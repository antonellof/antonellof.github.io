---
layout: post
title: "Social Media API Integration: Best Practices"
date: 2017-10-08
categories: [How-To]
tags: [API Integration, Social Media, OAuth, Webhooks]
excerpt: "Four platforms, four OAuth flows, four sets of rate limits — and one unified approach that kept us from getting banned."
---

The product manager's pitch was simple: "Users connect their social accounts, we post for them, everyone wins." What they didn't mention was that Facebook, Twitter, Instagram, and LinkedIn each have their own OAuth dialect, their own rate limit philosophy, and their own creative interpretation of API documentation.

Our first integration posted successfully to Facebook and then silently failed on Twitter for three days because we'd stored an expired token and assumed the API would tell us nicely. It did tell us. We weren't listening.

After building integrations with all four major platforms and surviving millions of API calls, here's the architecture that kept us authenticated, rate-limited, and out of platform jail.

## OAuth 2.0: The Authorization Code Tango

Every platform implements OAuth slightly differently, but the authorization code flow is the common backbone. User clicks "Connect," gets redirected to the platform, approves access, comes back with a code you exchange for tokens.

### Facebook's Flow (Graph API v2.10)

```javascript
// Step 1: Redirect to authorization URL
app.get('/auth/facebook', (req, res) => {
    const authUrl = `https://www.facebook.com/v2.10/dialog/oauth?` +
        `client_id=${CLIENT_ID}&` +
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
        `scope=email,public_profile&` +
        `state=${generateState()}`;
    
    res.redirect(authUrl);
});

// Step 2: Handle callback
app.get('/auth/facebook/callback', async (req, res) => {
    const { code, state } = req.query;
    
    // Exchange code for access token
    const tokenResponse = await fetch(
        'https://graph.facebook.com/v2.10/oauth/access_token',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                code: code
            })
        }
    );
    
    const { access_token } = await tokenResponse.json();
    
    // Get user info
    const userResponse = await fetch(
        `https://graph.facebook.com/me?access_token=${access_token}&fields=id,name,email`
    );
    
    const user = await userResponse.json();
    
    // Store token and user info
    await saveUserToken(user.id, access_token);
    
    res.json({ user, token: access_token });
});
```

The `state` parameter isn't optional decoration. It's CSRF protection. Generate it, store it server-side, validate it on callback. Skip this and you're building a "let attackers connect victim accounts" feature.

## Token Management: Where Integrations Go to Die

Tokens expire. Refresh tokens expire (sometimes). Users revoke access from the platform's settings page and your app finds out via a 401 at 2 a.m.

### A Token Manager That Handles Reality

```javascript
class TokenManager {
    constructor(db) {
        this.db = db;
    }
    
    async saveToken(userId, platform, tokenData) {
        await this.db.tokens.upsert({
            userId,
            platform,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: tokenData.expires_in 
                ? new Date(Date.now() + tokenData.expires_in * 1000)
                : null
        });
    }
    
    async getToken(userId, platform) {
        const token = await this.db.tokens.findOne({
            userId,
            platform
        });
        
        if (!token) {
            throw new Error('Token not found');
        }
        
        // Check if expired
        if (token.expiresAt && token.expiresAt < new Date()) {
            return await this.refreshToken(userId, platform, token);
        }
        
        return token.accessToken;
    }
    
    async refreshToken(userId, platform, token) {
        // Refresh token logic
        const newToken = await this.callRefreshEndpoint(platform, token.refreshToken);
        await this.saveToken(userId, platform, newToken);
        return newToken.access_token;
    }
}
```

Never store tokens in localStorage on the client. Encrypt at rest in your database. Treat tokens like passwords — because they basically are.

Refresh proactively, not reactively. Check expiry before every API call, not after the 401. Users notice failed posts; they don't notice a background token refresh.

## Facebook Graph API: Pages, Posts, and Permissions

```javascript
class FacebookAPI {
    constructor(accessToken) {
        this.accessToken = accessToken;
        this.baseUrl = 'https://graph.facebook.com/v2.10';
    }
    
    async postToPage(pageId, message, imageUrl = null) {
        const params = {
            message,
            access_token: this.accessToken
        };
        
        if (imageUrl) {
            params.url = imageUrl;
        }
        
        const response = await fetch(
            `${this.baseUrl}/${pageId}/feed`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params)
            }
        );
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Facebook API error: ${error.error.message}`);
        }
        
        return await response.json();
    }
    
    async getPageInsights(pageId, metrics, since, until) {
        const response = await fetch(
            `${this.baseUrl}/${pageId}/insights?` +
            `metric=${metrics.join(',')}&` +
            `since=${since}&` +
            `until=${until}&` +
            `access_token=${this.accessToken}`
        );
        
        return await response.json();
    }
}
```

Facebook's error responses are actually helpful — read `error.error.message`, log `error.error.code`, and build your retry logic around specific error types, not generic "something failed."

## Twitter: OAuth 1.0a, Because Why Make It Easy

Twitter still used OAuth 1.0a for API calls in 2017. If you've never signed requests with HMAC-SHA1, consider yourself lucky. If you have, you understand why libraries exist.

```javascript
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');

class TwitterAPI {
    constructor(consumerKey, consumerSecret, accessToken, accessTokenSecret) {
        this.oauth = OAuth({
            consumer: {
                key: consumerKey,
                secret: consumerSecret
            },
            signature_method: 'HMAC-SHA1',
            hash_function: (baseString, key) => {
                return crypto.createHmac('sha1', key).update(baseString).digest('base64');
            }
        });
        
        this.token = {
            key: accessToken,
            secret: accessTokenSecret
        };
    }
    
    async postTweet(text, mediaIds = []) {
        const requestData = {
            url: 'https://api.twitter.com/1.1/statuses/update.json',
            method: 'POST'
        };
        
        const params = {
            status: text
        };
        
        if (mediaIds.length > 0) {
            params.media_ids = mediaIds.join(',');
        }
        
        requestData.url += '?' + new URLSearchParams(params).toString();
        
        const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, this.token));
        
        const response = await fetch(requestData.url, {
            method: 'POST',
            headers: {
                Authorization: authHeader.Authorization
            }
        });
        
        return await response.json();
    }
    
    async uploadMedia(imageBuffer) {
        const formData = new FormData();
        formData.append('media', imageBuffer);
        
        const requestData = {
            url: 'https://upload.twitter.com/1.1/media/upload.json',
            method: 'POST'
        };
        
        const authHeader = this.oauth.toHeader(
            this.oauth.authorize(requestData, this.token)
        );
        
        const response = await fetch(requestData.url, {
            method: 'POST',
            headers: {
                Authorization: authHeader.Authorization
            },
            body: formData
        });
        
        const result = await response.json();
        return result.media_id_string;
    }
}
```

Media uploads are a two-step dance: upload the binary, get a `media_id`, attach it to the tweet. Skip the upload step and you'll post text-only tweets wondering where your images went.

## Instagram: The Plot Twist (It's Facebook Now)

Instagram's API landscape in 2017 was... evolving. Business accounts posted through the Facebook Graph API, not a standalone Instagram endpoint.

```javascript
class InstagramAPI {
    constructor(accessToken) {
        this.accessToken = accessToken;
        this.baseUrl = 'https://api.instagram.com/v1';
    }
    
    async uploadPhoto(imageUrl, caption) {
        // Instagram requires posting through Facebook Graph API
        // for business accounts
        
        const response = await fetch(
            `https://graph.facebook.com/v2.10/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    image_url: imageUrl,
                    caption: caption,
                    access_token: this.accessToken
                })
            }
        );
        
        const { id: containerId } = await response.json();
        
        // Publish the container
        const publishResponse = await fetch(
            `https://graph.facebook.com/v2.10/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    creation_id: containerId,
                    access_token: this.accessToken
                })
            }
        );
        
        return await publishResponse.json();
    }
}
```

Create container, then publish. Two API calls for one photo. Instagram's API has always had opinions about how content gets published.

## LinkedIn: UGC Posts and REST.li Headers

```javascript
class LinkedInAPI {
    constructor(accessToken) {
        this.accessToken = accessToken;
        this.baseUrl = 'https://api.linkedin.com/v2';
    }
    
    async postUpdate(text, visibility = 'PUBLIC') {
        const response = await fetch(
            `${this.baseUrl}/ugcPosts`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Restli-Protocol-Version': '2.0.0'
                },
                body: JSON.stringify({
                    author: `urn:li:person:${PERSON_URN}`,
                    lifecycleState: 'PUBLISHED',
                    specificContent: {
                        'com.linkedin.ugc.ShareContent': {
                            shareCommentary: {
                                text: text
                            },
                            shareMediaCategory: 'NONE'
                        }
                    },
                    visibility: {
                        'com.linkedin.ugc.MemberNetworkVisibility': visibility
                    }
                })
            }
        );
        
        return await response.json();
    }
}
```

LinkedIn's payload structure is verbose. The `X-Restli-Protocol-Version` header is mandatory. Forget it and you'll get errors that don't obviously point to the missing header.

## Rate Limiting: The Universal Constraint

Every platform rate-limits differently. Twitter measures in 15-minute windows. LinkedIn gives you a daily budget. Exceed any of them and you're not posting — you're waiting.

### Centralized Rate Limit Manager

```javascript
class RateLimitManager {
    constructor(redis) {
        this.redis = redis;
        this.limits = {
            facebook: { calls: 200, window: 3600 },
            twitter: { calls: 300, window: 900 },
            instagram: { calls: 200, window: 3600 },
            linkedin: { calls: 500, window: 86400 }
        };
    }
    
    async checkLimit(platform, endpoint) {
        const key = `rate_limit:${platform}:${endpoint}`;
        const limit = this.limits[platform];
        
        const current = await this.redis.incr(key);
        
        if (current === 1) {
            await this.redis.expire(key, limit.window);
        }
        
        if (current > limit.calls) {
            const ttl = await this.redis.ttl(key);
            throw new RateLimitError(
                `Rate limit exceeded for ${platform}. Retry after ${ttl} seconds.`
            );
        }
        
        return {
            remaining: limit.calls - current,
            resetAt: Date.now() + (await this.redis.ttl(key)) * 1000
        };
    }
}

// Usage
const rateLimitManager = new RateLimitManager(redis);

async function postToFacebook(message) {
    await rateLimitManager.checkLimit('facebook', 'post');
    return await facebookAPI.postToPage(PAGE_ID, message);
}
```

Track limits per platform, per endpoint. A global counter is better than nothing, but Twitter's tweet limit and Twitter's media upload limit are different animals.

Respect `Retry-After` headers from the platforms themselves — they're more accurate than your estimates.

## Webhooks: Let the Platforms Come to You

Polling for new messages is how you burn rate limits and annoy platform trust-and-safety teams. Webhooks flip the model: they push events to you.

### Facebook Webhooks

```javascript
app.post('/webhooks/facebook', (req, res) => {
    // Verify webhook signature
    const signature = req.headers['x-hub-signature-256'];
    const payload = JSON.stringify(req.body);
    const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');
    
    if (`sha256=${expectedSignature}` !== signature) {
        return res.status(401).send('Invalid signature');
    }
    
    // Handle webhook
    const { entry } = req.body;
    
    for (const event of entry) {
        if (event.messaging) {
            event.messaging.forEach(handleMessage);
        }
        
        if (event.changes) {
            event.changes.forEach(handleChange);
        }
    }
    
    res.status(200).send('OK');
});

function handleMessage(event) {
    if (event.message) {
        // Process incoming message
        processIncomingMessage(event.sender.id, event.message);
    }
}
```

Verify signatures before processing. Unverified webhooks are an open endpoint for anyone who guesses your URL.

### Twitter Webhooks (CRC Challenge)

```javascript
app.post('/webhooks/twitter', (req, res) => {
    // Verify CRC (Challenge Response Check)
    const crcToken = req.query.crc_token;
    
    if (crcToken) {
        const responseToken = crypto
            .createHmac('sha256', CONSUMER_SECRET)
            .update(crcToken)
            .digest('base64');
        
        return res.json({ response_token: `sha256=${responseToken}` });
    }
    
    // Verify webhook signature
    const signature = req.headers['x-twitter-webhooks-signature'];
    // ... verification logic
    
    // Handle webhook
    const { tweet_create_events } = req.body;
    
    tweet_create_events.forEach(event => {
        processTweet(event);
    });
    
    res.status(200).send('OK');
});
```

Twitter's CRC handshake trips up everyone the first time. Handle the `crc_token` query parameter before you handle actual events, or webhook registration fails silently.

## Error Handling: Retry Smart, Not Hard

```javascript
class SocialMediaAPI {
    async makeRequest(url, options) {
        try {
            const response = await fetch(url, options);
            
            if (response.status === 401) {
                // Token expired, refresh it
                await this.refreshToken();
                return this.makeRequest(url, options);
            }
            
            if (response.status === 429) {
                // Rate limited
                const retryAfter = response.headers.get('Retry-After');
                throw new RateLimitError(`Rate limited. Retry after ${retryAfter} seconds.`);
            }
            
            if (!response.ok) {
                const error = await response.json();
                throw new APIError(error.error.message, response.status);
            }
            
            return await response.json();
        } catch (error) {
            if (error instanceof RateLimitError) {
                // Queue for retry
                await this.queueForRetry(url, options);
                throw error;
            }
            
            // Log and rethrow
            console.error('API request failed:', error);
            throw error;
        }
    }
}
```

401 → refresh token and retry once. 429 → queue and back off. 5xx → exponential retry with jitter. 4xx (except 429) → don't retry; you broke something.

Blind retries on 400 errors just hammer the API with the same bad request. Learned that one the embarrassing way.

## What We Wish We'd Known on Day One

Store tokens encrypted, refresh them proactively, and never trust a token that "worked yesterday." Build one abstraction layer per platform behind a common interface — your product code shouldn't know whether it's talking to OAuth 1.0a or 2.0.

Rate limit before you call, not after you get blocked. Verify webhook signatures religiously. Log every API call with platform, endpoint, status code, and latency — when a platform changes their API (and they will), those logs are your forensic evidence.

Cache read-heavy responses (user profiles, page metadata) to stay under rate limits. Use webhooks for inbound events instead of polling. When something fails, queue it for retry rather than dropping it on the floor.

## The Bottom Line

Social media API integration isn't one integration — it's four (or more) integrations wearing a trench coat. OAuth flows differ, auth schemes differ, rate limits differ, and error formats differ.

Start with one platform. Get tokens, posting, and error handling solid. Then add the next. The unified patterns — token manager, rate limiter, webhook handler, retry queue — are where the real engineering lives.

The patterns here handled millions of API calls in production. Not because we mastered every platform quirk on day one, but because we built infrastructure that absorbed those quirks instead of scattering platform-specific hacks through the codebase.

---

*Written October 2017. API versions, endpoints, and auth schemes reflect that era — Facebook Graph v2.10, Twitter API v1.1, Instagram via Graph API. Platforms have changed substantially since; verify current docs before building.*

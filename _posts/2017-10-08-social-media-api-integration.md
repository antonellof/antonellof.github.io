---
layout: post
title: "Social Media API Integration: Best Practices"
date: 2017-10-08
categories: [How-To]
tags: [API Integration, Social Media, OAuth, Webhooks]
excerpt: "Integrating with social media APIs including Facebook, Twitter, Instagram, and LinkedIn. Covering OAuth flows, rate limits, webhooks, and error handling."
---

Integrating with social media APIs is essential for modern applications. After building integrations with Facebook, Twitter, Instagram, and LinkedIn, here's what works in production.

## OAuth 2.0 Flow

### Authorization Code Flow

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

## Token Management

### Token Storage

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

## Facebook Graph API

### Posting to Facebook

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

## Twitter API

### Posting Tweets

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

## Instagram API

### Posting Photos

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

## LinkedIn API

### Posting Updates

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

## Rate Limiting

### Rate Limit Handler

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

## Webhook Handling

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

### Twitter Webhooks

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

## Error Handling

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

## Best Practices

1. **Store tokens securely** - Encrypt at rest
2. **Handle token refresh** - Automatically refresh expired tokens
3. **Respect rate limits** - Implement rate limiting
4. **Handle webhooks** - Verify signatures
5. **Error handling** - Retry with exponential backoff
6. **Monitor API usage** - Track calls and errors
7. **Cache responses** - Reduce API calls
8. **Use webhooks** - Instead of polling

## Conclusion

Social media API integration requires:
- Proper OAuth implementation
- Token management
- Rate limit handling
- Webhook processing
- Robust error handling

Start with one platform, get it right, then expand. The patterns shown here handle millions of API calls in production.

---

*Social media API integration patterns from October 2017, covering Facebook, Twitter, Instagram, and LinkedIn APIs.*

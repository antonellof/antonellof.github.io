---
layout: post
title: "System Design Interview: Designing a URL Shortener"
date: 2022-03-19
categories: [Deep Dive]
tags: [System Design, Interview, Architecture]
excerpt: "The URL shortener is the 'Hello World' of system design interviews—and for good reason. It looks simple until you need to handle 10 billion redirects a day without melting your database."
---

Every system design interview has a greatest hits album. Design Twitter. Design Uber. Design a rate limiter. And somewhere near the top, always: **design a URL shortener like bit.ly**.

I used to think it was a toy problem. How hard can it be? Hash a URL, store it, redirect. Done in five minutes, right?

Then I built one for a marketing team that generated short links for every email campaign, social post, and QR code. Within six months we were doing 50 million redirects daily. The "simple" PostgreSQL table with a unique index started gasping for air at peak hours. The cache hit ratio mattered more than any algorithm interview prep had suggested.

That's when I realized the URL shortener interview question isn't testing whether you can write a hash function. It's testing whether you understand read-heavy systems, encoding tradeoffs, and the gap between "works in demo" and "works at scale."

Here's the approach I use—both in interviews and in production.

## Step 1: Clarify Requirements (Don't Skip This)

The interviewer (or your product manager) says "design a URL shortener." Your first response should be questions, not boxes and arrows.

### Functional Requirements

What must the system do?

- **Create short URLs** — Accept a long URL, return a short one
- **Redirect** — Given a short code, redirect to the original URL
- **Custom aliases** (optional) — Let users pick `short.ly/my-launch` instead of random codes
- **Expiration** (optional) — Links that die after a date or TTL
- **Analytics** (optional) — Track clicks, referrers, geographic data

In interviews, I explicitly ask which of these are in scope. In production, I push back on analytics v1—it's a write amplification problem disguised as a feature.

### Non-Functional Requirements

These separate junior designs from senior ones:

- **Availability:** 99.9% uptime (redirects must work even if creation is degraded)
- **Latency:** Redirects under 100ms p99
- **Scale:** How many URLs created per day? How many redirects?
- **Durability:** Short URLs should work for years—no silent data loss

Typical interview assumptions:
- 100 million new URLs per day
- 100:1 read-to-write ratio (redirects dominate)
- 5-year retention
- Short codes of 7 characters

Write these down. Every design decision flows from these numbers.

## Step 2: Back-of-the-Envelope Math

Interviewers love this section. It shows you think about scale before drawing architecture diagrams.

### Traffic Estimates

```
Writes: 100M URLs/day
      = 100M / 86400 seconds
      ≈ 1,200 writes/second average
      ≈ 6,000 writes/second peak (5x average)

Reads: 100:1 ratio
     = 10B redirects/day
     ≈ 115,000 reads/second average
     ≈ 575,000 reads/second peak
```

That read number is the headline. **Half a million redirects per second at peak** changes your storage and caching strategy completely.

### Storage Estimates

```
Per URL record:
  - short_code: 7 bytes
  - original_url: ~500 bytes average
  - created_at: 8 bytes
  - user_id: 8 bytes
  - metadata: ~50 bytes
  ≈ 600 bytes per record (with overhead, call it 1KB)

5 years of storage:
  100M/day × 365 days × 5 years = 182.5B URLs
  182.5B × 1KB ≈ 182 TB

With replication (3x): ~550 TB
```

You won't store 182 billion rows in a single PostgreSQL table. This math tells you sharding is non-negotiable at scale.

### Bandwidth

```
Read bandwidth:
  575,000 req/s × 500 bytes (redirect response)
  ≈ 280 MB/s peak

Write bandwidth: negligible by comparison
```

Reads dominate everything—memory, bandwidth, cache sizing. Design for reads first.

## Step 3: API Design

Keep it simple. Two endpoints cover 95% of use cases.

### Create Short URL

```
POST /api/v1/urls
Content-Type: application/json

{
    "url": "https://example.com/products/summer-sale-2022?utm_source=email",
    "customAlias": "summer-sale",    // optional
    "expiresAt": "2027-01-01T00:00:00Z"  // optional
}

Response: 201 Created
{
    "shortUrl": "https://short.ly/summer-sale",
    "shortCode": "summer-sale",
    "originalUrl": "https://example.com/products/summer-sale-2022?utm_source=email",
    "createdAt": "2022-03-19T10:30:00Z",
    "expiresAt": "2027-01-01T00:00:00Z"
}
```

### Redirect

```
GET /{shortCode}
→ 301 Moved Permanently
→ Location: https://example.com/products/summer-sale-2022?utm_source=email
```

**301 vs 302:** Use 301 (permanent) if the mapping never changes—better for caching. Use 302 (temporary) if you might update the destination or need accurate click analytics (browsers cache 301s aggressively).

For analytics-heavy systems, I use 302 internally and accept the cache tradeoff. For pure shortening, 301 is fine.

## Step 4: The Encoding Problem

How do you generate short codes? This is the question interviewers actually care about.

### Option A: Base62 Encoding of Auto-Increment ID

The classic approach. Database auto-increment ID, encode to Base62:

```javascript
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function encodeBase62(num) {
    if (num === 0) return BASE62[0];
    
    let result = '';
    while (num > 0) {
        result = BASE62[num % 62] + result;
        num = Math.floor(num / 62);
    }
    return result;
}

function decodeBase62(str) {
    let num = 0;
    for (const char of str) {
        num = num * 62 + BASE62.indexOf(char);
    }
    return num;
}

// Examples:
encodeBase62(125)       // "b9"
encodeBase62(1000000)   // "4c92"
encodeBase62(56800235584) // "zzzzzz" (7 chars max ≈ 3.5 trillion URLs)
```

**Pros:** No collisions. Deterministic. Simple.
**Cons:** Reveals total URL count (competitors can estimate your volume). Single ID generator becomes a bottleneck.

The bottleneck fix: pre-generate ID ranges per server, or use Snowflake-style distributed IDs.

### Option B: Hash-Based (MD5/SHA + Truncate)

Hash the URL, take the first 7 characters:

```javascript
const crypto = require('crypto');

function generateShortCode(url) {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return hash.substring(0, 7);
}
```

**Pros:** Same URL always gets same code (deduplication for free). No central ID generator.
**Cons:** Collisions. With 7 Base62 characters (~3.5 trillion possibilities) and 182 billion URLs, birthday paradox says collisions are rare but not zero. You need collision detection and retry logic.

```javascript
async function createShortUrl(originalUrl, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const suffix = attempt === 0 ? '' : `-${attempt}`;
        const shortCode = generateShortCode(originalUrl + suffix);
        
        try {
            await db.urls.insert({ short_code: shortCode, original_url: originalUrl });
            return shortCode;
        } catch (error) {
            if (error.code !== 'UNIQUE_VIOLATION') throw error;
            // Collision—retry with modified input
        }
    }
    throw new Error('Failed to generate unique short code');
}
```

### Option C: Random Generation

Generate random 7-character strings. Check for uniqueness. Retry on collision.

Simple, works well at moderate scale. Collision probability stays low until you're storing billions of URLs.

**My production pick:** Base62 of distributed IDs for random codes. Hash-based for deduplication when the same URL is submitted twice (check hash first, return existing code if found).

## Step 5: Database Design

```sql
CREATE TABLE urls (
    id          BIGSERIAL,
    short_code  VARCHAR(10) NOT NULL,
    original_url TEXT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMP,
    user_id     BIGINT,
    click_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id, short_code)
) PARTITION BY HASH (short_code);

-- Create 64 partitions
CREATE TABLE urls_p0 PARTITION OF urls
    FOR VALUES WITH (MODULUS 64, REMAINDER 0);
-- ... urls_p1 through urls_p63

CREATE UNIQUE INDEX idx_urls_short_code ON urls (short_code);
CREATE INDEX idx_urls_user_id ON urls (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_urls_expires_at ON urls (expires_at) WHERE expires_at IS NOT NULL;
```

Key decisions:

- **`short_code` is the lookup key** — Every redirect queries by short code. Index it uniquely.
- **Hash partitioning by short_code** — Distributes writes and reads evenly across partitions.
- **Separate click_count updates** — If analytics are hot, update counts asynchronously to avoid write contention on the main row.

For URL deduplication, add a hash index:

```sql
CREATE INDEX idx_urls_url_hash ON urls (md5(original_url));
```

Before creating a new short URL, check if the hash exists. Return the existing code if it does.

## Step 6: Architecture

At scale, the architecture looks like this:

```
                    ┌─────────────┐
                    │   Clients   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │     CDN     │  ← Cache 301/302 responses
                    │ (CloudFront)│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │Load Balancer│
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼───┐ ┌──────▼───┐ ┌──────▼───┐
       │ App Srv 1│ │ App Srv 2│ │ App Srv N│
       └──────┬───┘ └──────┬───┘ └──────┬───┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────▼──────┐
                    │    Redis    │  ← Hot URL cache
                    │   Cluster   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼───┐ ┌──────▼───┐ ┌──────▼───┐
       │  DB Shard│ │  DB Shard│ │  DB Shard│
       │    0     │ │    1     │ │    N     │
       └──────────┘ └──────────┘ └──────────┘
```

### The Read Path (Critical—99% of Traffic)

```javascript
async function redirect(shortCode) {
    // Layer 1: CDN (if 301 cached, browser never hits us)
    
    // Layer 2: Redis cache
    const cached = await redis.get(`url:${shortCode}`);
    if (cached) {
        recordClickAsync(shortCode);  // Don't block redirect for analytics
        return redirect302(cached);
    }
    
    // Layer 3: Database
    const url = await db.query(
        'SELECT original_url, expires_at FROM urls WHERE short_code = $1',
        [shortCode]
    );
    
    if (!url) {
        throw new NotFoundError();
    }
    
    if (url.expires_at && url.expires_at < new Date()) {
        throw new GoneError();  // 410 Gone
    }
    
    // Populate cache (TTL based on access patterns)
    await redis.setex(`url:${shortCode}`, 3600, url.original_url);
    
    recordClickAsync(shortCode);
    return redirect302(url.original_url);
}
```

Cache strategy matters enormously:

- **Default TTL:** 1 hour for most URLs
- **Popular URLs:** Extend TTL based on access frequency (count-min sketch to detect hot keys)
- **Expired URLs:** Cache negative results briefly to prevent DB hammering

### The Write Path

Writes are rare (1% of traffic) but need correctness:

```javascript
async function createUrl(originalUrl, options = {}) {
    // Validate URL
    if (!isValidUrl(originalUrl)) {
        throw new ValidationError('Invalid URL');
    }
    
    // Check for malicious URLs (phishing, malware)
    if (await isBlockedUrl(originalUrl)) {
        throw new ForbiddenError('URL not allowed');
    }
    
    // Deduplication check
    const existing = await findByUrlHash(originalUrl);
    if (existing) {
        return existing;
    }
    
    // Generate short code
    const shortCode = options.customAlias 
        ? await claimCustomAlias(options.customAlias)
        : await generateUniqueCode();
    
    const record = await db.urls.insert({
        short_code: shortCode,
        original_url: originalUrl,
        expires_at: options.expiresAt,
        user_id: options.userId,
    });
    
    return record;
}
```

## Step 7: Scaling Strategies

### Database Sharding

When a single database can't keep up, shard by short code hash:

```javascript
function getShardId(shortCode) {
    const hash = crc32(shortCode);
    return hash % NUM_SHARDS;
}

async function findUrl(shortCode) {
    const shardId = getShardId(shortCode);
    return db.shards[shardId].query(
        'SELECT original_url FROM urls WHERE short_code = $1',
        [shortCode]
    );
}
```

Consistent hashing if you need to add/remove shards without full resharding.

### Rate Limiting

Prevent abuse—both creation and redirect scanning:

```javascript
// Creation: 100 URLs per user per hour
await rateLimiter.check(`create:${userId}`, { max: 100, window: 3600 });

// Redirect: 1000 requests per IP per minute (prevent enumeration)
await rateLimiter.check(`redirect:${clientIp}`, { max: 1000, window: 60 });
```

### Analytics (If You Must)

Async, always async. Never block a redirect to write analytics:

```javascript
async function recordClickAsync(shortCode) {
    // Fire and forget to message queue
    await kafka.publish('click-events', {
        shortCode,
        timestamp: Date.now(),
        referrer: req.headers.referer,
        userAgent: req.headers['user-agent'],
        // Geo-IP lookup happens in consumer
    });
}

// Separate consumer aggregates into analytics DB
```

Click counts in the main `urls` table? Update via batch job every few minutes, not per-click.

## Common Interview Follow-Ups

**"How do custom aliases work?"**
Check uniqueness before insert. Reserve premium aliases. Rate limit custom alias creation more aggressively.

**"What if two users submit the same URL?"**
Return the existing short code (deduplication). Optionally attribute both users to the same link.

**"How do you handle URL validation?"**
Parse with URL library, enforce HTTPS-only (or allow HTTP with warning), check against blocklist, resolve DNS to prevent SSRF if you're fetching URLs server-side.

**"How do you delete expired URLs?"**
Background job scans `expires_at` index, deletes in batches, invalidates cache entries. Don't rely on TTL alone—expired URLs in cache should return 410 Gone.

## What I'd Do Differently Today

Looking back at the marketing team's URL shortener:

1. **CDN caching from day one.** We added it at 20M redirects/day. Should've been there at 20K.
2. **Separate analytics pipeline.** Writing click counts to the main table caused lock contention we didn't anticipate.
3. **7 characters was enough.** We worried about running out of codes. At 100M/day, 7 Base62 chars lasts decades.
4. **Custom aliases need governance.** Marketing teams will fight over `short.ly/sale`. Build a reservation system.

## Conclusion

The URL shortener interview question is a trojan horse. It looks like a coding exercise (hash this URL!) but it's really testing:

- **Read-heavy system design** — Caching layers, CDN, hot key handling
- **ID generation at scale** — Collisions, distributed IDs, encoding
- **Capacity estimation** — Back-of-envelope math that drives architecture
- **Tradeoff articulation** — 301 vs 302, sync vs async analytics, hash vs increment

Start with requirements. Do the math. Design the read path obsessively—it's 99% of your traffic. Add caching layers until the database is a backup, not a bottleneck.

And if you're ever in an interview and someone says "design bit.ly," don't start with code. Start with questions. That's how you know someone's built one for real.

**Further Resources:**
- [System Design Primer](https://github.com/donnemartin/system-design-primer) — URL shortener walkthrough
- [Base62 Encoding](https://stackoverflow.com/questions/1119722/convert-base-10-number-to-base-62) — Encoding reference
- [Consistent Hashing](https://www.toptal.com/big-data/consistent-hashing) — Sharding strategy
- [Designing Data-Intensive Applications](https://dataintensive.net/) — Martin Kleppmann's definitive guide

---

*System design: URL shortener from March 2022, covering requirements, design, and scaling.*

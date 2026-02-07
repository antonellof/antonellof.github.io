---
layout: post
title: "System Design Interview: Designing a URL Shortener"
date: 2022-03-15
categories: [Deep Dive]
tags: [System Design, Interview, Architecture]
excerpt: "Design a URL shortener like bit.ly: requirements, capacity estimation, API design, database schema, encoding algorithm, and scaling strategies."
---

URL shorteners are common system design questions. After designing production shorteners, here's a comprehensive approach.

## Requirements

### Functional Requirements

- **Shorten URL** - Convert long to short
- **Redirect** - Short URL to original
- **Custom URLs** - Optional custom aliases
- **Analytics** - Click tracking

### Non-Functional Requirements

- **High availability** - 99.9% uptime
- **Low latency** - < 100ms redirect
- **Scalability** - Billions of URLs

## Capacity Estimation

### Traffic Estimates

- **Reads**: 100:1 ratio (100 redirects per shorten)
- **Writes**: 100M URLs/day
- **Reads**: 10B redirects/day
- **Storage**: 5 years = 500B URLs
- **Bandwidth**: 10B * 500 bytes = 5TB/day

## API Design

### Shorten URL

```
POST /api/v1/shorten
{
    "url": "https://example.com/very/long/url",
    "customAlias": "optional"
}

Response:
{
    "shortUrl": "https://short.ly/abc123",
    "expiresAt": "2027-01-01"
}
```

### Redirect

```
GET /abc123
→ 301 Redirect to original URL
```

## Database Design

### URL Table

```sql
CREATE TABLE urls (
    id BIGSERIAL PRIMARY KEY,
    short_code VARCHAR(10) UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    user_id BIGINT,
    click_count BIGINT DEFAULT 0
);

CREATE INDEX idx_short_code ON urls(short_code);
CREATE INDEX idx_user_id ON urls(user_id);
```

## Encoding Algorithm

### Base62 Encoding

```javascript
const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function encode(num) {
    if (num === 0) return chars[0];
    
    let result = '';
    while (num > 0) {
        result = chars[num % 62] + result;
        num = Math.floor(num / 62);
    }
    return result;
}

function decode(str) {
    let num = 0;
    for (let i = 0; i < str.length; i++) {
        num = num * 62 + chars.indexOf(str[i]);
    }
    return num;
}
```

## Architecture

```
┌─────────┐
│ Client  │
└────┬────┘
     │
┌────▼────────────┐
│  Load Balancer  │
└────┬────────────┘
     │
┌────┴────┬─────────┐
│         │         │
┌─▼──┐  ┌─▼──┐  ┌─▼──┐
│App │  │App │  │App │
│Srv │  │Srv │  │Srv │
└─┬──┘  └─┬──┘  └─┬──┘
  │       │       │
┌─┴───────┴───────┴─┐
│   Cache (Redis)   │
└─────────┬─────────┘
          │
┌─────────▼─────────┐
│  Database (Shard) │
└───────────────────┘
```

## Scaling Strategies

### Database Sharding

```javascript
function getShard(shortCode) {
    const hash = hashFunction(shortCode);
    return hash % NUM_SHARDS;
}
```

### Caching

```javascript
async function getOriginalUrl(shortCode) {
    // Check cache first
    const cached = await redis.get(`url:${shortCode}`);
    if (cached) {
        return cached;
    }
    
    // Check database
    const url = await db.urls.findOne({ short_code: shortCode });
    if (url) {
        await redis.setex(`url:${shortCode}`, 3600, url.original_url);
        return url.original_url;
    }
    
    throw new Error('URL not found');
}
```

## Best Practices

1. **Handle collisions** - Retry on duplicate
2. **Cache aggressively** - High read ratio
3. **Monitor performance** - Track latency
4. **Handle expiration** - Cleanup old URLs
5. **Rate limiting** - Prevent abuse
6. **Analytics** - Track usage
7. **Security** - Validate URLs
8. **Backup** - Regular backups

## Conclusion

URL shortener design requires:
- Efficient encoding
- Fast lookups
- Caching strategy
- Scalable architecture

Start with basic requirements, then add scaling. The design shown here handles billions of URLs.

---

*System design: URL shortener from March 2022, covering requirements, design, and scaling.*

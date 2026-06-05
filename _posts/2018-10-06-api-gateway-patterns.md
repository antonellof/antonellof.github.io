---
layout: post
title: "API Gateway Patterns: Rate Limiting, Caching, and Authentication"
date: 2018-10-06
categories: [Architecture]
tags: [API Gateway, Architecture, Security]
excerpt: "Fifteen microservices behind one front door sounds elegant until a rogue client hammers your user service at 10,000 req/s. Here's how we built gateways that say 'no' politely."
---

Before we had an API gateway, our microservices architecture looked like a strip mall with fifteen separate entrances — each with its own lock, its own rate limit (or lack thereof), and its own idea of what "authenticated" meant. Frontend clients talked to five different base URLs. Mobile apps cached credentials in three places. And one enthusiastic partner's integration test DDoS'd our user service because nothing was throttling at the edge.

The API gateway became the **single front door**: routing, auth, rate limiting, caching, and the cross-cutting concerns that don't belong duplicated in every service. Not because gateways are trendy — because "every team implements JWT validation slightly differently" is a security incident waiting for a calendar invite.

Here's what we built and what we'd do again.

## What an API Gateway Actually Does

An API gateway sits between clients and backend services. It:
- Routes requests to the right microservice
- Handles authentication and authorization once, centrally
- Protects backends from abuse (rate limiting)
- Caches responses that don't need to hit origin every time
- Provides a single URL for clients, even as backends move and multiply

Think of it as a concierge: clients ask the concierge; the concierge knows which room to send them to, checks their credentials, and won't let them order room service 500 times per minute.

## Request Routing: One URL, Many Backends

The simplest gateway is a reverse proxy with opinions. Express + `http-proxy-middleware` gets you surprisingly far:

```javascript
// Express.js gateway
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Route to user service
app.use('/api/users', createProxyMiddleware({
    target: 'http://user-service:3000',
    changeOrigin: true,
    pathRewrite: {
        '^/api/users': ''
    }
}));

// Route to order service
app.use('/api/orders', createProxyMiddleware({
    target: 'http://order-service:3000',
    changeOrigin: true,
    pathRewrite: {
        '^/api/orders': ''
    }
}));

app.listen(8080);
```

Clients see `api.example.com/users`. Behind the scenes, the gateway strips the prefix and forwards to `user-service:3000`. When you split the monolith further, clients don't care — the gateway routing table changes, not the mobile app.

## Rate Limiting: Protecting Backends From Enthusiasm

Not all traffic is malicious. Some is just... enthusiastic. Integration tests, retry loops, scrapers, that one client who polls every 100ms "for real-time feel." Rate limiting is how you say "we love your business, but please breathe."

### Token Bucket: Smooth Burst Handling

The token bucket algorithm refills tokens at a steady rate and allows bursts up to bucket capacity. It's intuitive and works well per-user or per-API-key:

```javascript
class TokenBucket {
    constructor(capacity, refillRate) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillRate = refillRate; // tokens per second
        this.lastRefill = Date.now();
    }
    
    refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(
            this.capacity,
            this.tokens + elapsed * this.refillRate
        );
        this.lastRefill = now;
    }
    
    consume(tokens = 1) {
        this.refill();
        if (this.tokens >= tokens) {
            this.tokens -= tokens;
            return true;
        }
        return false;
    }
}

// Per-user rate limiting
const userBuckets = new Map();

function rateLimitMiddleware(req, res, next) {
    const userId = req.user?.id || req.ip;
    
    if (!userBuckets.has(userId)) {
        userBuckets.set(userId, new TokenBucket(100, 10)); // 100 tokens, 10/sec
    }
    
    const bucket = userBuckets.get(userId);
    
    if (bucket.consume()) {
        next();
    } else {
        res.status(429).json({
            error: 'Rate limit exceeded',
            retryAfter: Math.ceil((1 - bucket.tokens) / bucket.refillRate)
        });
    }
}
```

In-memory buckets work for single-instance gateways. The moment you scale horizontally, you need shared state — hello, Redis.

### Redis-Based Rate Limiting: Works Across Gateway Replicas

```javascript
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

async function rateLimit(req, res, next) {
    const key = `rate_limit:${req.user?.id || req.ip}`;
    const limit = 100;
    const window = 60; // seconds
    
    const current = await redis.incr(key);
    
    if (current === 1) {
        await redis.expire(key, window);
    }
    
    if (current > limit) {
        const ttl = await redis.ttl(key);
        return res.status(429).json({
            error: 'Rate limit exceeded',
            retryAfter: ttl
        });
    }
    
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - current));
    res.setHeader('X-RateLimit-Reset', Date.now() + (ttl * 1000));
    
    next();
}
```

Return `429` with `Retry-After` headers. Well-behaved clients back off. The ones that don't? That's what WAF rules and IP blocks are for.

## Caching: Stop Asking the Database the Same Question

Some endpoints get called thousands of times per second with identical parameters. `/api/users/123` doesn't change every millisecond. Caching at the gateway offloads backends and cuts latency dramatically.

### In-Memory Cache: Simple and Fast (Single Instance)

```javascript
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes

function cacheMiddleware(ttl = 300) {
    return (req, res, next) => {
        const key = req.originalUrl || req.url;
        
        // Check cache
        const cached = cache.get(key);
        if (cached) {
            return res.json(cached);
        }
        
        // Override res.json to cache response
        const originalJson = res.json.bind(res);
        res.json = function(data) {
            cache.set(key, data, ttl);
            return originalJson(data);
        };
        
        next();
    };
}

// Usage
app.get('/api/users/:id', cacheMiddleware(600), async (req, res) => {
    const user = await userService.getUser(req.params.id);
    res.json(user);
});
```

**Cache invalidation caveat:** Gateway caching works best for read-heavy, rarely-changing data. User profiles? Maybe. Account balances? Be very careful. When in doubt, short TTLs and explicit cache-bust headers on writes.

### Redis Cache: Shared Across Gateway Instances

```javascript
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

async function cacheMiddleware(req, res, next) {
    const key = `cache:${req.originalUrl}`;
    
    // Check cache
    const cached = await redis.get(key);
    if (cached) {
        const data = JSON.parse(cached);
        return res.json(data);
    }
    
    // Override res.json
    const originalJson = res.json.bind(res);
    res.json = async function(data) {
        await redis.setex(key, 300, JSON.stringify(data)); // 5 min TTL
        return originalJson(data);
    };
    
    next();
}
```

Only cache `GET` requests. Never cache responses that vary by auth header unless your cache key includes the user identity.

## Authentication: Validate Once at the Door

Duplicating JWT validation in twelve microservices means twelve places to forget the expiry check. Do it at the gateway; pass trusted identity downstream.

### JWT Validation

```javascript
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Usage
app.get('/api/users/me', authMiddleware, (req, res) => {
    res.json(req.user);
});
```

Downstream services should receive identity via headers (`X-User-Id`, `X-User-Roles`) injected by the gateway — not re-validate the JWT unless you need defense-in-depth for highly sensitive operations.

### API Key Authentication for Partners

```javascript
const apiKeys = new Map([
    ['key-123', { userId: 'user-1', permissions: ['read', 'write'] }],
    ['key-456', { userId: 'user-2', permissions: ['read'] }]
]);

function apiKeyMiddleware(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }
    
    const keyData = apiKeys.get(apiKey);
    if (!keyData) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    req.apiKey = keyData;
    next();
}
```

In production, API keys live in a database with rotation, revocation, and per-key rate limits — not a hardcoded Map. But the middleware shape is the same.

## Request/Response Transformation: Consistency at the Edge

Clients appreciate predictable response envelopes. Request IDs make debugging possible when logs span a dozen services:

```javascript
function transformRequest(req, res, next) {
    // Add request ID
    req.id = require('crypto').randomUUID();
    
    // Log request
    console.log(`[${req.id}] ${req.method} ${req.path}`);
    
    // Transform response
    const originalJson = res.json.bind(res);
    res.json = function(data) {
        const transformed = {
            requestId: req.id,
            timestamp: new Date().toISOString(),
            data: data
        };
        return originalJson(transformed);
    };
    
    next();
}
```

Propagate `req.id` to downstream services via `X-Request-Id` header. When a user reports "it broke at 3:15," you grep one ID instead of reconstructing a distributed trace from vibes.

## Load Balancing: Don't Send Everyone to the Same Pod

Round-robin across healthy backend instances is the default for a reason — it's simple and mostly works:

```javascript
const servers = [
    'http://user-service-1:3000',
    'http://user-service-2:3000',
    'http://user-service-3:3000'
];

let current = 0;

function getNextServer() {
    const server = servers[current];
    current = (current + 1) % servers.length;
    return server;
}

app.use('/api/users', createProxyMiddleware({
    target: getNextServer(),
    changeOrigin: true,
    router: (req) => getNextServer() // Round-robin
}));
```

For production, health-check-aware load balancing (via Kong, nginx, or cloud load balancers) skips unhealthy backends automatically. Sending traffic to a pod that's mid-crash helps nobody.

## Circuit Breakers at the Gateway: Fail Fast Before Backends Drown

When a backend is melting down, the gateway should stop forwarding traffic — not queue infinite requests:

```javascript
class CircuitBreaker {
    constructor(service, options = {}) {
        this.service = service;
        this.failureThreshold = options.failureThreshold || 5;
        this.timeout = options.timeout || 60000;
        this.state = 'CLOSED';
        this.failures = 0;
        this.nextAttempt = Date.now();
    }
    
    async call(...args) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error('Circuit breaker is OPEN');
            }
            this.state = 'HALF_OPEN';
        }
        
        try {
            const result = await this.service(...args);
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }
    
    onSuccess() {
        this.failures = 0;
        this.state = 'CLOSED';
    }
    
    onFailure() {
        this.failures++;
        if (this.failures >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
        }
    }
}

// Usage
const userServiceBreaker = new CircuitBreaker(userService.getUser);

app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await userServiceBreaker.call(req.params.id);
        res.json(user);
    } catch (error) {
        res.status(503).json({ error: 'Service unavailable' });
    }
});
```

Return `503` with a clear message instead of hanging until the client times out. Your mobile app's retry logic will thank you — if you've taught it to respect 503s.

## Off-the-Shelf Gateways: When Roll-Your-Own Gets Old

We started with Express. We migrated to **Kong** when plugin management, admin API, and rate-limiting plugins outweighed the simplicity of a custom server.

```yaml
# kong.yml
_format_version: "1.1"

services:
- name: user-service
  url: http://user-service:3000
  routes:
  - name: user-route
    paths:
    - /api/users
  plugins:
  - name: rate-limiting
    config:
      minute: 100
      hour: 1000
  - name: jwt
    config:
      secret_is_base64: false
  - name: response-caching
    config:
      ttl: 300

consumers:
- username: api-consumer
  keyauth_credentials:
  - key: api-key-123
```

Rate limiting, JWT validation, and response caching — configured declaratively, no middleware spaghetti.

### AWS API Gateway: When You're Already on AWS

```yaml
# serverless.yml
service: api-gateway

provider:
  name: aws
  runtime: nodejs14.x
  apiGateway:
    restApiId: ${self:custom.apiId}
    restApiRootResourceId: ${self:custom.rootResourceId}

functions:
  users:
    handler: handlers/users.handler
    events:
      - http:
          path: /api/users/{proxy+}
          method: ANY
          authorizer: aws_iam
          throttling:
            burstLimit: 200
            rateLimit: 100
```

Managed throttling, IAM auth, and Lambda integration — less ops, more vendor coupling. Tradeoffs, as always.

## What We Learned Running Gateways in Production

Rate limiting at the edge saved us more than once — set it before you need it, not after a partner's load test. Cache read-heavy endpoints aggressively but invalidate carefully; stale user data causes support tickets, stale product catalogs cause shrug emojis. Auth belongs at the gateway for external clients; internal service-to-service calls need their own trust model (mTLS, service tokens). Log every request with a correlation ID — you will need it. Circuit breakers on unhealthy backends prevent cascade failures. And version your APIs (`/v1/`, `/v2/`) so you can migrate clients without a big-bang deploy.

## The Bottom Line

An API gateway isn't ceremony — it's the choke point where you enforce the rules everyone agreed on in architecture reviews but nobody implemented in their service. One URL for clients. One place for auth. One place to say "slow down" before your database catches fire.

Build it early enough to matter, keep it thin enough to maintain, and resist the urge to put business logic in it. The gateway is a bouncer, not a chef.

---

*Written October 2018, covering production gateway patterns with Express, Kong, and AWS API Gateway. Gateway technology has exploded since (Envoy, Istio, APISIX) — the patterns remain; evaluate managed vs self-hosted for your scale.*

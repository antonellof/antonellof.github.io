---
layout: post
title: "API Gateway Patterns: Rate Limiting, Caching, and Authentication"
date: 2018-10-06
categories: [Architecture]
tags: [API Gateway, Architecture, Security]
excerpt: "Implement API gateway patterns for rate limiting, caching, authentication, and request routing. Learn how to build a production-ready API gateway with Kong, AWS API Gateway, or custom solutions."
---

API gateways are the entry point for microservices. After building production gateways, here are the patterns that work.

## What is an API Gateway?

An API gateway:
- Routes requests to backend services
- Handles cross-cutting concerns
- Provides single entry point
- Manages authentication/authorization

## Core Patterns

### Request Routing

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

## Rate Limiting

### Token Bucket Algorithm

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

### Redis-Based Rate Limiting

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

## Caching

### Response Caching

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

### Redis Caching

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

## Authentication

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

### API Key Authentication

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

## Request/Response Transformation

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

## Load Balancing

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

## Circuit Breaker

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

## Kong Gateway Configuration

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

## AWS API Gateway

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

## Best Practices

1. **Implement rate limiting** - Prevent abuse
2. **Cache responses** - Reduce backend load
3. **Validate authentication** - Secure endpoints
4. **Monitor metrics** - Track performance
5. **Handle errors gracefully** - Proper error responses
6. **Use circuit breakers** - Prevent cascading failures
7. **Log requests** - For debugging and analytics
8. **Version APIs** - Support multiple versions

## Conclusion

API gateways provide:
- Single entry point
- Cross-cutting concerns
- Security and rate limiting
- Request routing

Implement rate limiting, caching, and authentication at the gateway. The patterns shown here handle production traffic.

---

*API Gateway patterns from October 2018, covering production patterns.*

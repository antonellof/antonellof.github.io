---
layout: post
title: "Scaling to 20M Users: Architecture Lessons Learned"
date: 2018-12-09
categories: [Case Study]
tags: [Scalability, Architecture, Case Study]
excerpt: "Lessons learned from scaling a platform to 20 million users. Covering database optimization, caching strategies, microservices architecture, and infrastructure decisions."
---

Scaling from thousands to 20 million users required significant architecture changes. Here are the lessons learned from this journey.

## Initial Architecture

### Monolithic Application

```
┌─────────────────┐
│   Web Server    │
│  (Node.js/PHP)  │
└────────┬────────┘
         │
┌────────▼────────┐
│   PostgreSQL    │
│   (Single DB)   │
└─────────────────┘
```

**Problems:**
- Database became bottleneck
- Single point of failure
- Hard to scale horizontally
- Long deployment cycles

## Evolution: Phase 1 - Database Optimization

### Read Replicas

```
┌─────────────┐
│  Primary DB │
└──────┬──────┘
       │
       ├──────────┬──────────┐
       │          │          │
┌──────▼──┐  ┌────▼────┐  ┌─▼─────┐
│ Replica │  │ Replica │  │Replica│
│   1     │  │   2     │  │   3   │
└─────────┘  └─────────┘  └───────┘
```

**Results:**
- 3x read capacity
- Reduced primary DB load
- Better geographic distribution

### Connection Pooling

```javascript
// Before: Direct connections
const client = new pg.Client();
await client.connect();

// After: Connection pool
const pool = new pg.Pool({
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});
```

**Results:**
- Reduced connection overhead
- Better resource utilization
- 40% reduction in connection time

## Phase 2: Caching Strategy

### Multi-Layer Caching

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
┌──────▼──────┐
│   CDN       │  (Static assets)
└──────┬──────┘
       │
┌──────▼──────┐
│   Redis     │  (Application cache)
│  (In-memory)│
└──────┬──────┘
       │
┌──────▼──────┐
│  Database   │
└─────────────┘
```

### Redis Implementation

```javascript
// Cache user data
async function getUser(userId) {
    const cacheKey = `user:${userId}`;
    
    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
        return JSON.parse(cached);
    }
    
    // Fetch from database
    const user = await db.users.findById(userId);
    
    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(user));
    
    return user;
}
```

**Results:**
- 80% cache hit rate
- 10x reduction in database queries
- Sub-millisecond response times

### Cache Warming

```javascript
// Pre-populate cache for popular content
async function warmCache() {
    const popularUsers = await db.users.findPopular(1000);
    
    for (const user of popularUsers) {
        await redis.setex(
            `user:${user.id}`,
            3600,
            JSON.stringify(user)
        );
    }
}
```

## Phase 3: Microservices

### Service Decomposition

```
┌──────────────┐
│  API Gateway │
└──────┬───────┘
       │
   ┌───┴───┬────────┬────────┐
   │       │        │        │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌───▼──┐
│User │ │Order│ │Pay  │ │Notif │
│Svc  │ │Svc  │ │Svc  │ │Svc   │
└──┬──┘ └──┬──┘ └──┬──┘ └──┬───┘
   │       │       │       │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌──▼──┐
│User │ │Order│ │Pay  │ │Msg  │
│DB   │ │DB   │ │DB   │ │Queue│
└─────┘ └─────┘ └─────┘ └─────┘
```

**Benefits:**
- Independent scaling
- Technology diversity
- Faster deployments
- Fault isolation

## Phase 4: Database Sharding

### User Sharding Strategy

```javascript
// Shard by user ID
function getShard(userId) {
    const shardId = parseInt(userId) % 10; // 10 shards
    return `user_db_${shardId}`;
}

async function getUser(userId) {
    const shard = getShard(userId);
    const db = getDatabaseConnection(shard);
    return await db.users.findById(userId);
}
```

**Results:**
- 10x write capacity
- Reduced database size per shard
- Better query performance

### Cross-Shard Queries

```javascript
// Query across shards
async function searchUsers(query) {
    const shards = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    
    const results = await Promise.all(
        shards.map(shard => 
            queryShard(shard, query)
        )
    );
    
    return results.flat();
}
```

## Phase 5: Message Queues

### Async Processing

```
┌──────────┐
│   API    │
└────┬─────┘
     │
     ▼
┌──────────┐
│   SQS    │  (Message Queue)
└────┬─────┘
     │
     ├─────────┬─────────┐
     │         │         │
┌────▼──┐  ┌───▼──┐  ┌───▼──┐
│Worker │  │Worker│  │Worker│
│  1    │  │  2   │  │  3   │
└───────┘  └──────┘  └──────┘
```

**Use Cases:**
- Email sending
- Image processing
- Analytics
- Notifications

## Performance Metrics

### Before Optimization

- Average response time: 2.5s
- Database CPU: 95%
- Cache hit rate: 0%
- Uptime: 99.5%

### After Optimization

- Average response time: 150ms
- Database CPU: 30%
- Cache hit rate: 80%
- Uptime: 99.99%

## Key Decisions

### 1. Database Choice

**PostgreSQL** for:
- Complex queries
- ACID transactions
- JSON support

**MongoDB** for:
- High write throughput
- Flexible schema
- Horizontal scaling

### 2. Caching Strategy

**Redis** for:
- Hot data
- Session storage
- Real-time features

**CDN** for:
- Static assets
- Global distribution

### 3. Message Queue

**AWS SQS** for:
- Reliability
- Auto-scaling
- Managed service

### 4. Monitoring

**Prometheus + Grafana** for:
- Metrics collection
- Alerting
- Visualization

## Lessons Learned

### 1. Start Simple

Don't over-engineer initially. Optimize when you have real problems.

### 2. Measure Everything

You can't optimize what you don't measure. Track:
- Response times
- Error rates
- Cache hit rates
- Database performance

### 3. Cache Aggressively

Caching provides the biggest performance gains. Cache:
- User data
- Popular content
- Expensive queries

### 4. Database is Bottleneck

Optimize database first:
- Indexes
- Query optimization
- Connection pooling
- Read replicas

### 5. Scale Horizontally

Add more servers instead of bigger servers:
- Easier to scale
- Better fault tolerance
- Cost effective

### 6. Async Processing

Move heavy operations to background:
- Email sending
- Image processing
- Data aggregation

### 7. Monitor and Alert

Set up monitoring and alerts:
- Track key metrics
- Alert on anomalies
- Review regularly

## Architecture Principles

1. **Stateless services** - Easier to scale
2. **Idempotent operations** - Safe retries
3. **Graceful degradation** - Handle failures
4. **Circuit breakers** - Prevent cascading failures
5. **Rate limiting** - Protect resources
6. **Health checks** - Monitor service health
7. **Blue-green deployments** - Zero downtime
8. **Feature flags** - Gradual rollouts

## Current Architecture

```
                    ┌─────────────┐
                    │   CDN       │
                    │ (CloudFront)│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ API Gateway │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼────┐        ┌────▼────┐       ┌────▼────┐
   │  User   │        │  Order  │       │  Pay    │
   │ Service │        │ Service │       │ Service │
   └────┬────┘        └────┬────┘       └────┬────┘
        │                  │                  │
   ┌────▼────┐        ┌────▼────┐       ┌────▼────┐
   │ Redis   │        │  SQS    │       │  SQS    │
   │ Cache   │        │ Queue   │       │ Queue   │
   └────┬────┘        └────┬────┘       └────┬────┘
        │                  │                  │
   ┌────▼────┐        ┌────▼────┐       ┌────▼────┐
   │Postgres │        │ Workers │       │ Workers │
   │(Sharded)│        └──────────┘       └──────────┘
   └─────────┘
```

## Conclusion

Scaling to 20M users required:
- Database optimization (replicas, sharding)
- Aggressive caching (Redis, CDN)
- Microservices architecture
- Async processing (message queues)
- Continuous monitoring

Start simple, measure everything, and optimize based on data. The architecture evolved over time based on real needs.

---

*Scaling lessons from December 2018, covering the journey to 20 million users.*

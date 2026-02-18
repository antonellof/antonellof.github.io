---
layout: post
title: "Redis Data Structures: Beyond Key-Value"
date: 2020-09-12
categories: [How-To]
tags: [Redis, Data Structures, Caching]
excerpt: "Master Redis data structures: strings, lists, sets, sorted sets, hashes, and streams. Learn when to use each structure and practical patterns."
---

Redis provides powerful data structures beyond simple key-value. After using Redis in production, here's how to leverage each structure effectively.

## Redis Data Structures

### Strings

**Use cases:**
- Simple values
- Counters
- Caching

```javascript
// Set/Get
await redis.set('user:123:name', 'John Doe');
const name = await redis.get('user:123:name');

// Counters
await redis.incr('page:views');
await redis.incrby('page:views', 10);

// Expiration
await redis.setex('session:123', 3600, 'session-data');
```

### Lists

**Use cases:**
- Queues
- Timelines
- Recent items

```javascript
// Push/Pop
await redis.lpush('tasks', 'task1');
await redis.rpush('tasks', 'task2');
const task = await redis.lpop('tasks');

// Get range
const tasks = await redis.lrange('tasks', 0, 10);

// Blocking pop
const task = await redis.blpop('tasks', 10); // Wait 10 seconds
```

### Sets

**Use cases:**
- Unique items
- Tags
- Memberships

```javascript
// Add/Remove
await redis.sadd('tags:article:123', 'javascript', 'nodejs');
await redis.srem('tags:article:123', 'javascript');

// Check membership
const isMember = await redis.sismember('tags:article:123', 'nodejs');

// Set operations
const intersection = await redis.sinter('tags:article:123', 'tags:article:456');
const union = await redis.sunion('tags:article:123', 'tags:article:456');
const difference = await redis.sdiff('tags:article:123', 'tags:article:456');
```

### Sorted Sets

**Use cases:**
- Leaderboards
- Rankings
- Time-series data

```javascript
// Add with score
await redis.zadd('leaderboard', 100, 'player1');
await redis.zadd('leaderboard', 200, 'player2');

// Get rank
const rank = await redis.zrank('leaderboard', 'player1');

// Get top players
const topPlayers = await redis.zrevrange('leaderboard', 0, 9, 'WITHSCORES');

// Range queries
const players = await redis.zrangebyscore('leaderboard', 100, 200);
```

### Hashes

**Use cases:**
- Objects
- User profiles
- Configuration

```javascript
// Set/Get fields
await redis.hset('user:123', 'name', 'John Doe');
await redis.hset('user:123', 'email', 'john@example.com');
const name = await redis.hget('user:123', 'name');

// Get all
const user = await redis.hgetall('user:123');

// Increment
await redis.hincrby('user:123', 'score', 10);
```

### Streams

**Use cases:**
- Event logs
- Message queues
- Time-series

```javascript
// Add to stream
await redis.xadd('events', '*', 'type', 'user.created', 'userId', '123');

// Read from stream
const events = await redis.xread('STREAMS', 'events', '0');

// Consumer groups
await redis.xgroup('CREATE', 'events', 'consumers', '0');
const events = await redis.xreadgroup('GROUP', 'consumers', 'worker1', 'STREAMS', 'events', '>');
```

## Practical Patterns

### Rate Limiting

```javascript
async function rateLimit(userId, limit, window) {
    const key = `rate_limit:${userId}`;
    const current = await redis.incr(key);
    
    if (current === 1) {
        await redis.expire(key, window);
    }
    
    return current <= limit;
}
```

### Caching with TTL

```javascript
async function getCachedUser(userId) {
    const cached = await redis.get(`user:${userId}`);
    if (cached) {
        return JSON.parse(cached);
    }
    
    const user = await db.getUser(userId);
    await redis.setex(`user:${userId}`, 3600, JSON.stringify(user));
    return user;
}
```

### Leaderboard

```javascript
class Leaderboard {
    async addScore(playerId, score) {
        await redis.zadd('leaderboard', score, playerId);
    }
    
    async getTopPlayers(limit = 10) {
        return await redis.zrevrange('leaderboard', 0, limit - 1, 'WITHSCORES');
    }
    
    async getPlayerRank(playerId) {
        return await redis.zrevrank('leaderboard', playerId);
    }
}
```

### Recent Items

```javascript
async function addRecentItem(userId, itemId) {
    const key = `recent:${userId}`;
    await redis.lpush(key, itemId);
    await redis.ltrim(key, 0, 9); // Keep only 10 items
    await redis.expire(key, 86400); // 24 hours
}

async function getRecentItems(userId) {
    return await redis.lrange(`recent:${userId}`, 0, 9);
}
```

### Distributed Lock

```javascript
async function acquireLock(key, ttl = 10) {
    const lockKey = `lock:${key}`;
    const result = await redis.set(lockKey, 'locked', 'EX', ttl, 'NX');
    return result === 'OK';
}

async function releaseLock(key) {
    await redis.del(`lock:${key}`);
}
```

## Best Practices

1. **Choose right structure** - Match use case
2. **Set expiration** - Prevent memory leaks
3. **Use pipelines** - Batch operations
4. **Monitor memory** - Track usage
5. **Handle failures** - Graceful degradation
6. **Use transactions** - When needed
7. **Optimize keys** - Short, consistent
8. **Monitor performance** - Track latency

## Conclusion

Redis data structures enable:
- Efficient data storage
- Fast operations
- Rich functionality
- Scalable caching

Choose the right structure for your use case. The patterns shown here handle production workloads.

---

*Redis data structures from September 2020, covering strings, lists, sets, sorted sets, hashes, and streams.*

---
layout: post
title: "Redis Data Structures: Beyond Key-Value"
date: 2020-09-12
categories: [How-To]
tags: [Redis, Data Structures, Caching]
excerpt: "Redis isn't just a cache with GET and SET. Sorted sets powered our leaderboard, streams replaced a janky RabbitMQ setup, and the right data structure choice cut memory usage 40%."
---

My first Redis deployment was a glorified Memcached. `SET` user session. `GET` user session. `EXPIRE` in 3600 seconds. It worked fine, and I left massive performance on the table because I treated Redis as a key-value store with TTLs.

Then a colleague built a real-time leaderboard with sorted sets in 20 lines of code. Another replaced our rate limiter's PostgreSQL counter table (which was locking itself to death) with a single `INCR`. Someone else used streams for event processing and deleted an entire RabbitMQ cluster.

Redis has six core data structures—strings, lists, sets, sorted sets, hashes, and streams—each optimized for different access patterns. Picking the right one isn't trivia; it's the difference between Redis that transforms your architecture and Redis that's an expensive cache.

## Strings: More Than GET/SET

```javascript
// Basic cache
await redis.set('user:123:name', 'John Doe');
const name = await redis.get('user:123:name');

// Atomic counters — no race conditions
await redis.incr('page:views');
await redis.incrby('page:views', 10);

// Set with expiration in one command
await redis.setex('session:abc123', 3600, JSON.stringify(sessionData));
```

**Strings are for:** caching serialized objects, atomic counters, distributed locks (`SET key value NX EX 10`), rate limiting tokens, feature flags.

**Watch out for:** storing large JSON blobs you'll partially update. Every change rewrites the entire string. Use hashes instead.

## Lists: Queues and Timelines

```javascript
// Queue: LPUSH to add, BRPOP to consume (FIFO)
await redis.lpush('tasks', JSON.stringify({ type: 'send_email', to: 'user@example.com' }));
const task = await redis.brpop('tasks', 10);  // Block up to 10 seconds

// Recent items timeline
await redis.lpush('recent:views:user123', 'article:456');
await redis.ltrim('recent:views:user123', 0, 9);  // Keep last 10
```

Lists are doubly-linked lists. Fast push/pop at both ends. Slow random access.

**Lists are for:** job queues (simple ones—see streams for production), recent items feeds, activity timelines.

**The `BRPOP` pattern** gives you blocking consumers without polling. Multiple workers block on the same list; Redis delivers each message to one worker. Crude but effective job queue.

## Sets: Uniqueness and Membership

```javascript
// Tags on an article
await redis.sadd('tags:article:123', 'javascript', 'nodejs', 'redis');

// Check membership in O(1)
const isTagged = await redis.sismember('tags:article:123', 'nodejs');

// Set algebra
const commonTags = await redis.sinter('tags:article:123', 'tags:article:456');
const allTags = await redis.sunion('tags:article:123', 'tags:article:456');
```

**Sets are for:** unique collections, tags, "who's online" tracking (add user ID on connect, remove on disconnect), mutual followers (intersection of two users' following sets).

**Memory note:** sets use more memory per element than lists for large collections. If order matters or you need duplicates, sets are wrong.

## Sorted Sets: Rankings and Priority Queues

This is the structure people overlook most—and it's incredibly useful.

```javascript
// Leaderboard
await redis.zadd('leaderboard:2024', 15420, 'player:alice');
await redis.zadd('leaderboard:2024', 12850, 'player:bob');

// Top 10 players (highest scores first)
const top = await redis.zrevrange('leaderboard:2024', 0, 9, 'WITHSCORES');
// [['player:alice', '15420'], ['player:bob', '12850'], ...]

// Player rank (0-indexed)
const rank = await redis.zrevrank('leaderboard:2024', 'player:alice');

// Players with scores between 10000 and 15000
const midTier = await redis.zrangebyscore('leaderboard:2024', 10000, 15000);
```

Sorted sets are sets where each member has a score. Redis maintains sort order automatically. Insert, delete, and rank queries are O(log N).

**Sorted sets are for:**
- Leaderboards and rankings
- Priority queues (score = priority, lower = higher priority)
- Time-series data (score = timestamp)
- Rate limiting with sliding windows
- Auto-complete (score = search frequency)

We replaced a PostgreSQL leaderboard that used `ORDER BY score DESC LIMIT 10` on every page load—200ms queries at scale—with sorted set `ZREVRANGE`. Sub-millisecond.

## Hashes: Objects Without JSON Serialization

```javascript
// User profile as hash fields
await redis.hset('user:123', {
    name: 'John Doe',
    email: 'john@example.com',
    lastLogin: Date.now().toString()
});

// Get single field without deserializing entire object
const email = await redis.hget('user:123', 'email');

// Get all fields
const user = await redis.hgetall('user:123');

// Atomic field increment
await redis.hincrby('user:123', 'loginCount', 1);
```

**Hashes are for:** objects you update partially, user profiles, configuration, session data with multiple fields.

**Why not JSON strings?** Updating one field in a JSON string requires GET → parse → modify → SET. Race conditions unless you use WATCH/MULTI. Hash field updates are atomic and single-field reads don't transfer the whole object.

Rule of thumb: if you have structured data with fields you'll access or update independently, use a hash.

## Streams: Event Logs and Message Queues

Streams are Redis's newest core structure (Redis 5.0+)—append-only logs with consumer groups.

```javascript
// Producer: add events
await redis.xadd('events:orders', '*', 
    'type', 'order.created',
    'orderId', '123',
    'total', '99.99'
);

// Consumer group (multiple workers share load)
await redis.xgroup('CREATE', 'events:orders', 'order-processors', '0', 'MKSTREAM');

// Consumer reads new messages
const messages = await redis.xreadgroup(
    'GROUP', 'order-processors', 'worker-1',
    'COUNT', '10',
    'BLOCK', '5000',
    'STREAMS', 'events:orders', '>'
);

// Acknowledge processed messages
await redis.xack('events:orders', 'order-processors', messageId);
```

**Streams are for:**
- Event sourcing light
- Message queues with consumer groups
- Activity feeds with history
- Cross-service event delivery (simpler than Kafka for moderate volume)

**Streams vs Lists for queues:** streams have persistence, consumer groups, message acknowledgment, and replay. Lists are simpler but lack these features. For production job queues, use streams or a dedicated queue. For "fire and forget" tasks, lists are fine.

## Practical Patterns I've Deployed

### Rate Limiting (Strings + TTL)

```javascript
async function rateLimit(userId, limit = 100, windowSeconds = 60) {
    const key = `rate:${userId}`;
    const current = await redis.incr(key);
    
    if (current === 1) {
        await redis.expire(key, windowSeconds);
    }
    
    return {
        allowed: current <= limit,
        remaining: Math.max(0, limit - current),
        resetIn: await redis.ttl(key)
    };
}
```

Simple fixed-window rate limiter. For sliding windows, use sorted sets with timestamps as scores.

### Cache-Aside Pattern

```javascript
async function getCachedUser(userId) {
    const cached = await redis.get(`user:${userId}`);
    if (cached) return JSON.parse(cached);
    
    const user = await db.getUser(userId);
    await redis.setex(`user:${userId}`, 3600, JSON.stringify(user));
    return user;
}
```

Classic pattern. Invalidate on update (`DEL user:123`) or use TTL and accept stale data briefly.

### Distributed Lock

```javascript
async function withLock(lockKey, ttlSeconds, fn) {
    const token = crypto.randomUUID();
    const acquired = await redis.set(`lock:${lockKey}`, token, 'EX', ttlSeconds, 'NX');
    
    if (!acquired) throw new Error('Could not acquire lock');
    
    try {
        return await fn();
    } finally {
        // Only release if we still hold the lock
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            end
        `;
        await redis.eval(script, 1, `lock:${lockKey}`, token);
    }
}
```

Use [Redlock](https://redis.io/docs/manual/patterns/distributed-locks/) for multi-instance Redis. Single-instance locks fail if Redis restarts. For most cases, single-instance with short TTL is pragmatic.

### Leaderboard Service

```javascript
class Leaderboard {
    constructor(redis, key) {
        this.redis = redis;
        this.key = key;
    }
    
    async addScore(playerId, score) {
        await this.redis.zadd(this.key, score, playerId);
    }
    
    async getTopPlayers(limit = 10) {
        return this.redis.zrevrange(this.key, 0, limit - 1, 'WITHSCORES');
    }
    
    async getPlayerRank(playerId) {
        const rank = await this.redis.zrevrank(this.key, playerId);
        return rank !== null ? rank + 1 : null;  // 1-indexed for humans
    }
}
```

## Operations Best Practices

1. **Set TTLs on everything ephemeral** — sessions, caches, rate limits. Unbounded keys = memory surprise.
2. **Use pipelines** — batch multiple commands in one round trip
3. **Monitor memory** — `INFO memory`, set `maxmemory-policy` (usually `allkeys-lru`)
4. **Key naming conventions** — `entity:id:field` (e.g., `user:123:profile`)
5. **Don't use Redis as primary database** — persistence exists, but design for ephemeral data
6. **Connection pooling** — don't open a new connection per request

## Conclusion

Redis is a multi-tool, not a hammer. Strings for counters and caching. Hashes for structured objects. Sorted sets for anything ranked. Streams for events. Lists for simple queues. Sets for uniqueness.

The leaderboard that opened my eyes wasn't clever code—it was the right data structure. ZADD/ZREVRANGE replaced complex SQL, application-level sorting, and caching layers with two Redis commands.

Next time you reach for `SET`/`GET`, ask: is there a Redis structure that models this problem more naturally? Usually there is—and it's faster, simpler, and uses less memory than the key-value workaround you're about to write.

---

*Redis data structures from September 2020, covering strings, lists, sets, sorted sets, hashes, and streams.*

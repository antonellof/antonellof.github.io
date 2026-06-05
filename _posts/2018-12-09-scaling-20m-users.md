---
layout: post
title: "Scaling to 20M Users: Architecture Lessons Learned"
date: 2018-12-09
categories: [Case Study]
tags: [Scalability, Architecture, Case Study]
excerpt: "We didn't architect for 20 million users on day one. We architected for Tuesday — and Tuesday kept getting busier. Here's what actually broke, and what we did about it."
---

Nobody wakes up and says, "Let's design for 20 million users." You wake up, check metrics, and realize yesterday's peak is today's baseline. Then someone posts about you on a popular subreddit and "baseline" becomes a polite word for "the database is on fire."

This is the architecture story of scaling a platform from thousands to 20 million users — not a heroic overnight rewrite, but a series of uncomfortable Tuesdays where production told us exactly what to fix next. We didn't get everything right. We got better at listening to metrics, admitting when the monolith wasn't cute anymore, and caching like our response times depended on it (they did).

## Where We Started: One App, One Database, Many Assumptions

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

Classic monolith. Worked beautifully until it didn't.

The cracks showed gradually, then all at once:
- PostgreSQL CPU pegged at 95% during peak hours
- Deployments required coordinated downtime — or nerves of steel
- Horizontal scaling meant cloning the entire app, including parts that didn't need scaling
- One slow query could stall the whole request pipeline

We didn't microservice our way out on day one. We optimized our way toward breathing room, then split things when the pain was specific enough to justify the operational cost.

## Phase 1: Database Optimization — The First Real Bottleneck

Every scaling story eventually becomes a database story. Ours started with reads.

### Read Replicas: Spread the Read Load

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

Writes stayed on primary. Reads — user profiles, listings, dashboards — went to replicas. Three replicas gave us roughly 3x read capacity and let us serve reads from regions closer to users.

**The catch:** replication lag. A user updates their profile and immediately refreshes — if the read hits a replica that's 200ms behind, they see stale data and file a bug. We routed "read your own writes" to primary and everything else to replicas.

### Connection Pooling: Stop Opening Connections Like Party Favors

Before pooling, every request opened a fresh Postgres connection. Under load, we spent more time handshaking than querying.

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

Result: ~40% reduction in connection overhead and far fewer "too many connections" errors — Postgres's way of telling you to go away.

### Query Optimization: The Cheap Wins We Should Have Done First

Before replicas, before Redis, before anything else — we should have looked at `EXPLAIN ANALYZE`. Several "we need to scale" moments were actually "we need an index" moments.

A dashboard query scanning 2 million rows because someone forgot a composite index on `(tenant_id, created_at)` doesn't need sharding. It needs a DBA with coffee and fifteen minutes. We added partial indexes for hot query patterns, rewrote N+1 ORM calls into proper joins, and dropped unused indexes that were slowing writes.

Rule of thumb we adopted: if Postgres CPU is high, spend a day on query plans before spending a month on architecture changes. Most of the time, the database is telling you exactly what's wrong — you just have to ask nicely.

## Phase 2: Caching — The Biggest Bang for the Buck

If I could only keep one optimization from this entire journey, it's caching. Not because it's clever — because it's effective.

### Multi-Layer Cache: CDN → Redis → Database

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

Static assets on CloudFront. Hot application data in Redis. Database as the source of truth, not the first stop on every request.

### Redis in Practice

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

We hit **80% cache hit rate** on user data. Database query volume dropped roughly 10x for hot paths. P95 response times went from "users notice" to "users don't think about it."

### Cache Warming: Don't Make Popular Users Pay Cold-Cache Tax

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

After deploys or Redis restarts, cache warming prevented a thundering herd on the database from the most-requested profiles.

## Phase 3: Microservices — Split When the Pain Is Specific

We didn't break the monolith because microservices are fashionable. We broke it because **different parts of the system had different scaling profiles** and the same deployment cadence was slowing everyone down.

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

User service scaled for read-heavy traffic. Payment service scaled carefully — fewer instances, stricter deploy gates. Notification service scaled with queue depth, not request rate.

The wins: independent scaling, independent deploys, fault isolation (payment hiccup doesn't take down user profiles). The cost: distributed systems complexity, network latency, and a lot more dashboards to watch.

We extracted services in this order: notifications first (async-friendly, low coupling), then user profiles (read-heavy, clear boundaries), then orders, and payment last — because getting payment wrong is a career-limiting move. Each extraction taught us where the monolith's seams actually were versus where we *wished* they were.

## Phase 4: Database Sharding — When One Postgres Isn't Enough

Read replicas help reads. Writes still hit one primary. At sufficient scale, the write path and total data size force a split.

### Shard by User ID

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

Ten shards gave us roughly 10x write capacity and smaller indexes per shard — queries got faster because each database was working with less data.

**The ugly part:** cross-shard queries. Searching users by name across the entire platform? That fan-out query hits every shard:

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

We pushed cross-shard search to Elasticsearch for anything that wasn't a point lookup by user ID. Sharding solves write scale; it creates read complexity. Plan for both.

## Phase 5: Message Queues — Move Work Off the Request Path

Not everything needs to happen before the HTTP response returns. Email, image processing, analytics, push notifications — these belong in background workers.

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

The API enqueues a job and responds immediately. Workers process at their own pace, scaling with queue depth. AWS SQS gave us managed reliability and auto-scaling without running our own RabbitMQ cluster — a tradeoff we were happy to make in 2018.

The first async job we moved off the request path was "send welcome email." It felt almost silly — how much could one email matter? Turns out, during signup spikes, SMTP latency was adding 800ms to registration. Users don't notice email delivery time. They absolutely notice an 800ms registration form. That one change sold leadership on async processing for everything that wasn't blocking the user's next click.

## The Numbers: Before and After

| Metric | Before | After |
|--------|--------|-------|
| Avg response time | 2.5s | 150ms |
| Database CPU | 95% | 30% |
| Cache hit rate | 0% | 80% |
| Uptime | 99.5% | 99.99% |

These didn't happen in one deploy. They accumulated over months — each phase unlocking headroom for the next wave of growth.

## Key Technology Decisions (And Why)

**PostgreSQL** stayed our primary relational store — complex queries, ACID transactions, JSON support when we needed flexibility. **MongoDB** handled high-write, flexible-schema workloads where horizontal scaling mattered more than joins.

**Redis** for hot data, sessions, and real-time features. **CloudFront** for static assets and global edge caching. **AWS SQS** for async work — managed, reliable, scales with queue depth. **Prometheus + Grafana** for metrics, alerting, and the dashboards that justified our next optimization.

None of these were religious choices. They were "what's managed, what does the team know, what fails gracefully" choices.

## What We Actually Learned (The Non-Obvious Stuff)

**Start simple, but measure from day one.** We wasted time optimizing things that weren't bottlenecks because we didn't have metrics. Response times, error rates, cache hit rates, database query latency — if you can't see it, you can't fix it.

**Cache aggressively, invalidate carefully.** Caching gave us the biggest performance wins of any single technique. It also caused our most confusing bugs when invalidation lagged. Short TTLs plus explicit invalidation on writes beat clever cache coherence schemes we never finished building.

**The database is almost always the bottleneck — until it isn't.** Optimize queries, add indexes, pool connections, add replicas — in that rough order. Sharding is a last resort with real operational cost, not a growth milestone to celebrate.

**Scale horizontally before vertically.** More modest servers beat one giant server for fault tolerance, cost predictability, and the ability to roll out changes gradually.

**Async everything that isn't user-facing.** If the user doesn't need to wait for it, they shouldn't. Email can arrive three seconds late. Analytics can lag by minutes. The request path should be ruthlessly short.

**Monitoring isn't optional — it's how you sleep.** Alerts on error rate spikes, latency percentiles, queue depth, and database connections. Review dashboards weekly; don't wait for customers to tell you something broke.

**Premature optimization is real — but so is premature microservices.** We almost split the monolith six months before we needed to, because microservices were the hot conference topic. Glad we waited. The boundaries we drew with real traffic data were much cleaner than the boundaries we drew on a whiteboard with ambition and a marker.

## Principles We Still Follow

Stateless services scale horizontally without drama. Idempotent operations make retries safe — and in distributed systems, retries happen. Graceful degradation beats hard failures: show cached data, disable non-essential features, keep checkout alive. Circuit breakers and rate limiting protect shared resources. Health checks and blue-green deploys keep changes from becoming incidents. Feature flags let us roll out gradually and roll back instantly.

These aren't a checklist for a architecture review slide. They're the difference between "we deployed at noon" and "we deployed at noon and nothing caught fire."

## Where We Landed

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

It's more complex than the monolith. It's also still standing at 20 million users — which was the actual requirement.

## What We'd Do Differently

If we could wind the clock back to 50,000 users, we'd instrument earlier — structured logging, distributed tracing, and percentile-based alerting from the start, not after the first outage post-mortem. We'd cache sooner, even when the database "felt fine," because cache hit rate is free performance you bank before you need it. And we'd document service boundaries in the monolith before extracting them, so the first microservice split followed seams that already existed in the code, not seams we invented under pressure.

None of that would have skipped any phase. It would have made each phase shorter and less painful.

## The Bottom Line

Scaling isn't a destination. It's a series of decisions driven by real bottlenecks, measured with real metrics, rolled back when they don't work.

We didn't architect for 20 million users on day one. We architected for surviving the next busy Tuesday — and Tuesday kept showing up until "busy" meant "millions." Start simple. Measure everything. Cache before you shard. Split services when the pain is specific. Move work async when users don't need to wait.

The architecture you need at 20 million users is not the architecture you need at 20 thousand. That's not a failure of planning — that's how growth actually works.

---

*Written December 2018, documenting the journey to 20 million users. Cloud offerings, Kubernetes maturity, and serverless patterns have evolved significantly since — the sequencing (optimize → cache → split → shard → async) still holds.*

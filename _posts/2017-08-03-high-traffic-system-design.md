---
layout: post
title: "High-Traffic System Design: Scaling to Millions of Users"
date: 2017-08-03
categories: [Architecture]
tags: [System Design, Scalability, Performance, Architecture]
excerpt: "The scaling playbook we wish we'd read before our first viral moment — load balancing, caching layers, and the art of not melting your database."
---

Our first "viral moment" wasn't a Product Hunt launch or a TechCrunch feature. It was a Tuesday. Traffic went from "comfortable" to "why is the database on fire" in about eleven minutes. The postmortem had three action items and one recurring theme: we'd designed for the traffic we had, not the traffic we wanted.

Scaling to millions of users isn't one clever trick. It's a stack of boring decisions — caching, load balancing, read replicas, async workers — each buying you room to breathe until the next bottleneck shows up. Here's the architecture that survived the climb from thousands to millions, with the scars to prove it.

## Start With Numbers, Not Diagrams

Before you draw boxes and arrows, answer five questions:

- **Traffic**: Requests per second at peak, not average
- **Users**: Concurrent connections vs. total registered
- **Data**: Read/write ratio (most apps are wildly read-heavy)
- **Latency**: What's acceptable? (Sub-200ms for APIs, sub-2s for pages)
- **Availability**: 99.9% sounds modest until you do the math on downtime

We learned to design for peak × 3. Viral moments don't send a calendar invite.

## The Shape of a System That Can Grow

```
Users → CDN → Load Balancer → App Servers → Cache → Database
                ↓
            Message Queue → Workers
```

Every layer exists because the layer below it ran out of capacity. Skip a layer and you'll meet it again, usually during an incident.

## Load Balancing: Spread the Pain

One server handling everything works until it doesn't — usually at the worst possible moment.

### HAProxy at Layer 4

```nginx
# Layer 4 Load Balancer (HAProxy)
global
    maxconn 4096

defaults
    mode http
    timeout connect 5000ms
    timeout client 50000ms
    timeout server 50000ms

frontend http-in
    bind *:80
    default_backend servers

backend servers
    balance roundrobin
    server web1 10.0.1.1:80 check
    server web2 10.0.1.2:80 check
    server web3 10.0.1.3:80 check
```

Health checks are non-negotiable. A load balancer that keeps sending traffic to a dead server isn't load balancing — it's load *concentrating* on the survivors.

### Health Checks in Your App

```python
# Health check endpoint
@app.route('/health')
def health():
    return {'status': 'healthy'}, 200

# Load balancer configuration
# - Health checks every 30 seconds
# - Remove unhealthy instances
# - Distribute traffic evenly
```

Make `/health` cheap. Don't hit the database on every probe unless you enjoy cascading failures.

## Caching: Your Database's Best Friend

The fastest query is the one you never run. Most read-heavy apps can serve 80–90% of requests from cache once you stop treating Redis like a nice-to-have.

### Multi-Layer Caching

```python
class CacheManager:
    def __init__(self):
        self.l1_cache = {}  # In-memory (per server)
        self.l2_cache = redis.Redis()  # Distributed
        self.l3_cache = CDN  # Edge caching
    
    async def get(self, key):
        # L1: In-memory
        if key in self.l1_cache:
            return self.l1_cache[key]
        
        # L2: Redis
        value = await self.l2_cache.get(key)
        if value:
            self.l1_cache[key] = value
            return value
        
        # L3: Database (not shown)
        return None
    
    async def set(self, key, value, ttl=3600):
        # Set in all layers
        self.l1_cache[key] = value
        await self.l2_cache.setex(key, ttl, value)
```

L1 is microseconds. L2 is milliseconds. L3 (your database) is... let's not talk about L3 response times during an incident.

### Cache-Aside: The Workhorse Pattern

```python
async def get_user(user_id):
    # Try cache first
    cached = await cache.get(f'user:{user_id}')
    if cached:
        return json.loads(cached)
    
    # Cache miss - get from database
    user = await db.get_user(user_id)
    
    # Store in cache
    await cache.setex(
        f'user:{user_id}',
        3600,  # 1 hour TTL
        json.dumps(user)
    )
    
    return user
```

Cache-aside means the application owns cache logic. Simple, flexible, and you feel every cache miss in your database metrics — which is actually useful feedback.

### Write-Through: Consistency at a Cost

```python
async def update_user(user_id, data):
    # Update database
    user = await db.update_user(user_id, data)
    
    # Update cache
    await cache.setex(
        f'user:{user_id}',
        3600,
        json.dumps(user)
    )
    
    # Invalidate related caches
    await cache.delete(f'user:{user_id}:profile')
    
    return user
```

Invalidate aggressively. Stale cache data is worse than a cache miss — at least a miss goes to the source of truth.

## Database Scaling: When One Postgres Isn't Enough

Your database will be the bottleneck eventually. Plan for it before the query planner becomes your enemy.

### Read Replicas

```python
# Write to master
class WriteDatabase:
    def __init__(self):
        self.conn = psycopg2.connect(
            host='db-master.example.com',
            database='myapp'
        )
    
    def create_user(self, user_data):
        # Write to master
        cursor = self.conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email) VALUES (%s, %s)",
            (user_data['name'], user_data['email'])
        )
        self.conn.commit()

# Read from replicas
class ReadDatabase:
    def __init__(self):
        self.replicas = [
            psycopg2.connect('db-replica-1.example.com'),
            psycopg2.connect('db-replica-2.example.com'),
            psycopg2.connect('db-replica-3.example.com'),
        ]
        self.current = 0
    
    def get_connection(self):
        # Round-robin replica selection
        conn = self.replicas[self.current]
        self.current = (self.current + 1) % len(self.replicas)
        return conn
    
    def get_user(self, user_id):
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        return cursor.fetchone()
```

Replicas lag. If a user updates their profile and immediately refreshes, they might see the old version for a few hundred milliseconds. Design for eventual consistency or route critical reads to the master.

### Sharding: The Nuclear Option

```python
class ShardedDatabase:
    def __init__(self):
        self.shards = {
            0: psycopg2.connect('db-shard-0.example.com'),
            1: psycopg2.connect('db-shard-1.example.com'),
            2: psycopg2.connect('db-shard-2.example.com'),
        }
        self.shard_count = len(self.shards)
    
    def get_shard(self, user_id):
        # Consistent hashing
        return hash(user_id) % self.shard_count
    
    def get_user(self, user_id):
        shard = self.get_shard(user_id)
        conn = self.shards[shard]
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        return cursor.fetchone()
```

Sharding fixes write throughput and storage limits. It breaks cross-shard joins, complicates migrations, and makes your ORM cry. Don't shard until replicas and query optimization are genuinely exhausted.

## Async Processing: Get Slow Work Off the Request Path

Users shouldn't wait for your email service while they're checking out. Queue it.

```python
# Producer
class OrderService:
    def __init__(self):
        self.queue = redis.Redis()
    
    async def create_order(self, order_data):
        # Create order record
        order = await db.create_order(order_data)
        
        # Queue async tasks
        await self.queue.lpush('email:send', json.dumps({
            'type': 'order_confirmation',
            'order_id': order.id
        }))
        
        await self.queue.lpush('analytics:track', json.dumps({
            'event': 'order_created',
            'order_id': order.id
        }))
        
        return order

# Consumer
class Worker:
    def __init__(self):
        self.queue = redis.Redis()
    
    async def process_queue(self, queue_name):
        while True:
            # Blocking pop
            message = await self.queue.brpop(queue_name, timeout=1)
            
            if message:
                data = json.loads(message[1])
                await self.handle_message(data)
    
    async def handle_message(self, data):
        if data['type'] == 'order_confirmation':
            await self.send_order_email(data['order_id'])
```

The order API returns in 50ms. The confirmation email arrives in 2 seconds. Everyone's happy. Make workers idempotent — queues deliver at-least-once, and "at-least-once" means duplicates.

## CDN: Stop Serving Static Assets From Your App Servers

Your API servers should not be delivering JavaScript bundles and profile photos. That's what CDNs are for.

```python
# Static assets via CDN
STATIC_URL = 'https://cdn.example.com'

# API responses with CDN headers
@app.route('/api/users/<user_id>')
async def get_user(user_id):
    user = await get_user_from_cache(user_id)
    
    response = jsonify(user)
    
    # CDN caching headers
    response.headers['Cache-Control'] = 'public, max-age=3600'
    response.headers['CDN-Cache-Control'] = 'public, max-age=3600'
    response.headers['Vary'] = 'Accept-Encoding'
    
    return response
```

Cache public API responses carefully. User-specific data with `Cache-Control: public` is a privacy incident waiting to happen.

## Rate Limiting: Protect Yourself From Everyone (Including You)

One misconfigured cron job can DDOS your own API. Rate limiting isn't just for bad actors.

```python
from redis import Redis
import time

class RateLimiter:
    def __init__(self):
        self.redis = Redis()
    
    def is_allowed(self, key, limit, window):
        now = time.time()
        pipe = self.redis.pipeline()
        
        # Remove old entries
        pipe.zremrangebyscore(key, 0, now - window)
        
        # Count current requests
        pipe.zcard(key)
        
        # Add current request
        pipe.zadd(key, {str(now): now})
        pipe.expire(key, window)
        
        results = pipe.execute()
        count = results[1]
        
        return count < limit

# Usage
limiter = RateLimiter()

@app.route('/api/data')
async def get_data():
    client_id = request.headers.get('X-Client-ID')
    
    if not limiter.is_allowed(f'rate_limit:{client_id}', limit=100, window=60):
        return jsonify({'error': 'Rate limit exceeded'}), 429
    
    return jsonify({'data': 'response'})
```

Return `429` with a `Retry-After` header. Well-behaved clients will back off. The rest you block at the edge.

## Monitoring: You Can't Fix What You Can't See

We once discovered our cache hit rate had dropped to 12% three days after a deploy. Nobody noticed because we weren't watching.

```python
from prometheus_client import Counter, Histogram
import time

# Metrics
request_count = Counter('http_requests_total', 'Total requests', ['method', 'endpoint'])
request_duration = Histogram('http_request_duration_seconds', 'Request duration', ['endpoint'])

@app.route('/api/users/<user_id>')
@request_duration.labels('get_user').time()
async def get_user(user_id):
    request_count.labels('GET', 'get_user').inc()
    
    start_time = time.time()
    
    try:
        user = await get_user_from_db(user_id)
        return jsonify(user)
    except Exception as e:
        # Log error
        logger.error(f"Error getting user {user_id}: {e}")
        raise
    finally:
        duration = time.time() - start_time
        if duration > 1.0:  # Log slow requests
            logger.warning(f"Slow request: get_user took {duration}s")
```

Instrument request counts, latency percentiles (p50, p95, p99), error rates, and cache hit ratios. Alert on trends, not just thresholds.

## Horizontal Scaling: Stateless Servers Win

You can't scale a server that stores sessions in memory. The second instance has amnesia.

```python
# No session storage in app
# Use Redis for sessions
import redis

class SessionStore:
    def __init__(self):
        self.redis = redis.Redis()
    
    def get_session(self, session_id):
        return self.redis.get(f'session:{session_id}')
    
    def set_session(self, session_id, data, ttl=3600):
        self.redis.setex(f'session:{session_id}', ttl, json.dumps(data))
```

Any app server can handle any request. Scale up by adding instances. Scale down by removing them. No sticky sessions required.

### Auto-Scaling Rules That Actually Work

```yaml
# Auto-scaling configuration
min_instances: 3
max_instances: 50
target_cpu_utilization: 70
target_request_rate: 1000  # requests per second per instance

# Scale up when:
# - CPU > 70%
# - Request rate > 1000/sec
# - Response time > 500ms

# Scale down when:
# - CPU < 30% for 5 minutes
# - Request rate < 300/sec for 10 minutes
```

Scale up fast, scale down slow. Removing capacity during a traffic spike's trailing edge is how you cause a second outage.

## Database Optimization: Before You Shard, Tune

```python
from sqlalchemy import create_engine
from sqlalchemy.pool import QueuePool

engine = create_engine(
    'postgresql://user:pass@host/db',
    poolclass=QueuePool,
    pool_size=20,
    max_overflow=40,
    pool_pre_ping=True  # Verify connections
)
```

Connection pooling prevents your app from opening 500 connections during a spike and suffocating Postgres.

```python
# Use indexes
# SELECT * FROM users WHERE email = ?  -- Needs index on email

# Batch operations
async def get_users(user_ids):
    # Instead of N queries
    # SELECT * FROM users WHERE id IN (?, ?, ...)
    return await db.query(
        "SELECT * FROM users WHERE id = ANY(%s)",
        (user_ids,)
    )

# Pagination
async def get_users_page(page, page_size):
    offset = (page - 1) * page_size
    return await db.query(
        "SELECT * FROM users ORDER BY id LIMIT %s OFFSET %s",
        (page_size, offset)
    )
```

The N+1 query problem doesn't announce itself. It shows up as "why is our database CPU at 100% with only 50 users online?"

## Graceful Degradation: Something Can Always Break

Design for partial failure. If recommendations are down, show the catalog without them. If search is slow, serve cached results. A degraded experience beats a 500 error page.

## Load Test Before You Need To

We ran our first load test at 3× expected traffic and watched the database connection pool exhaust in four minutes. Better at 3 p.m. on a Wednesday than during a product launch.

## The Bottom Line

Scaling to millions isn't a single architectural leap. It's a sequence:

1. **Load balance** so one server isn't doing all the work
2. **Cache aggressively** so your database isn't doing all the work
3. **Replicate reads** before you shard writes
4. **Queue slow work** so requests stay fast
5. **CDN your static assets** so app servers focus on app logic
6. **Monitor everything** so you see the next bottleneck coming
7. **Degrade gracefully** when something inevitably breaks

Start simple. A single app server, a database, and Redis for sessions gets you surprisingly far. Add layers when metrics — not anxiety — tell you to.

The patterns here handled millions of requests per day in production. Not because we over-engineered on day one, but because each layer had a clear job and we added the next one when the current stack started sweating.

---

*Written August 2017. Examples reflect common patterns from that era — HAProxy, Redis queues, Prometheus metrics. The principles hold; specific services and limits have evolved.*

---
layout: post
title: "High-Traffic System Design: Scaling to Millions of Users"
date: 2017-08-03
categories: [Architecture]
tags: [System Design, Scalability, Performance, Architecture]
excerpt: "Design patterns and strategies for building systems that handle millions of users, covering load balancing, caching, database scaling, and CDN integration."
---

Designing systems that handle millions of users requires careful architecture from day one. After scaling systems from thousands to millions of users, here are the patterns that actually work in production.

## System Requirements

Before designing, understand:
- **Traffic**: Requests per second (RPS)
- **Users**: Concurrent and total users
- **Data**: Read/write ratio, data size
- **Latency**: Acceptable response times
- **Availability**: Uptime requirements

## Architecture Overview

```
Users → CDN → Load Balancer → App Servers → Cache → Database
                ↓
            Message Queue → Workers
```

## Load Balancing

### Multiple Load Balancers

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

### Application Load Balancer

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

## Caching Strategy

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

### Cache-Aside Pattern

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

### Write-Through Cache

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

## Database Scaling

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

### Database Sharding

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

## Message Queue for Async Processing

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

## CDN Integration

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

## Rate Limiting

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

## Monitoring and Observability

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

## Horizontal Scaling

### Stateless Application Servers

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

### Auto-Scaling

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

## Database Optimization

### Connection Pooling

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

### Query Optimization

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

## Best Practices

1. **Cache aggressively** - Cache everything that can be cached
2. **Use CDN** - Offload static assets
3. **Scale horizontally** - Add more servers, not bigger servers
4. **Database replicas** - Read from replicas, write to master
5. **Async processing** - Use queues for heavy operations
6. **Monitor everything** - Know your system's behavior
7. **Graceful degradation** - System should degrade gracefully
8. **Load testing** - Test before you need to scale

## Conclusion

Scaling to millions of users requires:
- Load balancing
- Multi-layer caching
- Database scaling (replicas, sharding)
- Async processing
- CDN integration
- Monitoring and observability

Start simple, add complexity as you scale. The patterns shown here handle millions of requests per day in production.

---

*High-traffic system design patterns from August 2017, covering scalability strategies.*

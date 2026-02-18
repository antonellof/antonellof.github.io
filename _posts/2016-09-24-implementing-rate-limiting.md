---
layout: post
title: "Implementing Rate Limiting: Patterns and Best Practices"
date: 2016-09-24
categories: [How-To]
tags: [Rate Limiting, API Security, Performance, Redis]
excerpt: "Learn how to implement effective rate limiting strategies using Redis, covering token bucket, sliding window, and distributed rate limiting patterns for production APIs."
---

Rate limiting is essential for protecting APIs from abuse and ensuring fair resource usage. After implementing rate limiting for APIs handling millions of requests per day, I've learned what works and what doesn't. Here are the patterns that scale.

## Why Rate Limiting?

Rate limiting protects your system by:
- Preventing API abuse and DDoS attacks
- Ensuring fair resource distribution
- Controlling costs
- Maintaining service quality

## Basic Rate Limiting Patterns

### 1. Fixed Window Counter

Simple but has edge case issues:

```python
import redis
import time

redis_client = redis.Redis(host='localhost', port=6379, db=0)

def fixed_window_rate_limit(key, limit, window):
    """
    Fixed window: 100 requests per minute
    Problem: Allows 200 requests at window boundary
    """
    current_window = int(time.time() / window)
    redis_key = f"rate_limit:{key}:{current_window}"
    
    current = redis_client.incr(redis_key)
    
    if current == 1:
        redis_client.expire(redis_key, window)
    
    return current <= limit
```

### 2. Sliding Window Log

More accurate but memory intensive:

```python
def sliding_window_log_rate_limit(key, limit, window):
    """
    Sliding window log: Track all requests
    Accurate but uses more memory
    """
    now = time.time()
    redis_key = f"rate_limit:{key}"
    
    # Remove old entries
    redis_client.zremrangebyscore(redis_key, 0, now - window)
    
    # Count current requests
    current = redis_client.zcard(redis_key)
    
    if current < limit:
        # Add current request
        redis_client.zadd(redis_key, {str(now): now})
        redis_client.expire(redis_key, int(window))
        return True
    
    return False
```

### 3. Sliding Window Counter (Recommended)

Best balance of accuracy and efficiency:

```python
def sliding_window_counter_rate_limit(key, limit, window):
    """
    Sliding window counter: Efficient and accurate
    Uses multiple fixed windows to approximate sliding window
    """
    now = time.time()
    # Use 10 sub-windows
    sub_window_size = window / 10
    current_sub_window = int(now / sub_window_size)
    
    redis_key = f"rate_limit:{key}:{current_sub_window}"
    
    # Increment current sub-window
    current = redis_client.incr(redis_key)
    redis_client.expire(redis_key, int(window))
    
    # Count requests in all sub-windows
    total = 0
    for i in range(10):
        sub_window = current_sub_window - i
        count = redis_client.get(f"rate_limit:{key}:{sub_window}") or 0
        total += int(count)
    
    return total <= limit
```

## Token Bucket Algorithm

More flexible for burst handling:

```python
class TokenBucket:
    def __init__(self, redis_client, key, capacity, refill_rate):
        """
        capacity: Maximum tokens
        refill_rate: Tokens added per second
        """
        self.redis = redis_client
        self.key = f"token_bucket:{key}"
        self.capacity = capacity
        self.refill_rate = refill_rate
    
    def consume(self, tokens=1):
        now = time.time()
        bucket_key = self.key
        
        # Lua script for atomic operation
        lua_script = """
        local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'last_refill')
        local tokens = tonumber(bucket[1]) or ARGV[1]
        local last_refill = tonumber(bucket[2]) or ARGV[2]
        local now = tonumber(ARGV[2])
        local capacity = tonumber(ARGV[3])
        local refill_rate = tonumber(ARGV[4])
        local requested = tonumber(ARGV[5])
        
        -- Refill tokens
        local elapsed = now - last_refill
        tokens = math.min(capacity, tokens + (elapsed * refill_rate))
        
        -- Check if enough tokens
        if tokens >= requested then
            tokens = tokens - requested
            redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last_refill', now)
            redis.call('EXPIRE', KEYS[1], 3600)
            return {1, tokens}
        else
            redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last_refill', now)
            redis.call('EXPIRE', KEYS[1], 3600)
            return {0, tokens}
        end
        """
        
        result = self.redis.eval(
            lua_script,
            1,
            bucket_key,
            self.capacity,
            now,
            self.capacity,
            self.refill_rate,
            tokens
        )
        
        allowed = result[0] == 1
        remaining = result[1]
        
        return {
            'allowed': allowed,
            'remaining': remaining,
            'reset_time': now + ((self.capacity - remaining) / self.refill_rate)
        }

# Usage
bucket = TokenBucket(redis_client, 'user:123', capacity=100, refill_rate=10)
result = bucket.consume(tokens=5)

if result['allowed']:
    # Process request
    pass
else:
    # Rate limited
    return f"Rate limit exceeded. Try again in {result['reset_time']:.0f} seconds"
```

## Distributed Rate Limiting

For multi-server setups:

```python
class DistributedRateLimiter:
    def __init__(self, redis_client):
        self.redis = redis_client
    
    def check_rate_limit(self, identifier, limit, window):
        """
        Distributed rate limiting using Redis
        Works across multiple application servers
        """
        key = f"rate_limit:{identifier}"
        now = time.time()
        
        # Lua script for atomic check-and-increment
        lua_script = """
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        
        -- Clean up old entries
        redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
        
        -- Count current requests
        local current = redis.call('ZCARD', key)
        
        if current < limit then
            -- Add current request
            redis.call('ZADD', key, now, now)
            redis.call('EXPIRE', key, window)
            return {1, limit - current - 1, window}
        else
            -- Get oldest request to calculate reset time
            local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
            local reset_time = 0
            if oldest[2] then
                reset_time = oldest[2] + window - now
            end
            return {0, 0, reset_time}
        end
        """
        
        result = self.redis.eval(
            lua_script,
            1,
            key,
            limit,
            window,
            now
        )
        
        allowed = result[0] == 1
        remaining = result[1]
        reset_time = result[2]
        
        return {
            'allowed': allowed,
            'remaining': remaining,
            'reset_time': reset_time
        }
```

## HTTP Middleware Implementation

### Express.js Middleware

```javascript
const express = require('express');
const redis = require('redis');
const { RateLimiterRedis } = require('rate-limiter-flexible');

const redisClient = redis.createClient({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
});

// Create rate limiter
const rateLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl',
    points: 100, // Number of requests
    duration: 60, // Per 60 seconds
});

const rateLimiterMiddleware = async (req, res, next) => {
    try {
        // Use IP address or user ID as key
        const key = req.user?.id || req.ip;
        
        await rateLimiter.consume(key);
        next();
    } catch (rejRes) {
        // Rate limit exceeded
        res.status(429).json({
            error: 'Too many requests',
            retryAfter: Math.round(rejRes.msBeforeNext / 1000)
        });
    }
};

app.use('/api/', rateLimiterMiddleware);
```

### Laravel Middleware

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Support\Facades\Redis;
use Illuminate\Http\Request;

class RateLimitMiddleware
{
    public function handle(Request $request, Closure $next, $limit = 60, $window = 60)
    {
        $key = $this->resolveRequestSignature($request);
        $redis = Redis::connection();
        
        $lua = "
            local key = KEYS[1]
            local limit = tonumber(ARGV[1])
            local window = tonumber(ARGV[2])
            local now = tonumber(ARGV[3])
            
            redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
            local current = redis.call('ZCARD', key)
            
            if current < limit then
                redis.call('ZADD', key, now, now)
                redis.call('EXPIRE', key, window)
                return {1, limit - current - 1}
            else
                return {0, 0}
            end
        ";
        
        $result = $redis->eval($lua, 1, "rate_limit:{$key}", $limit, $window, time());
        
        if ($result[0] == 0) {
            return response()->json([
                'error' => 'Rate limit exceeded'
            ], 429)->header('Retry-After', $window);
        }
        
        return $next($request)->header('X-RateLimit-Remaining', $result[1]);
    }
    
    protected function resolveRequestSignature(Request $request)
    {
        // Use user ID if authenticated, otherwise IP
        return $request->user() 
            ? "user:{$request->user()->id}"
            : "ip:{$request->ip()}";
    }
}
```

## Rate Limiting Strategies

### Per-User Rate Limiting

```python
def get_user_rate_limit(user_id, user_tier):
    """
    Different limits based on user tier
    """
    limits = {
        'free': {'limit': 100, 'window': 3600},      # 100/hour
        'premium': {'limit': 1000, 'window': 3600},  # 1000/hour
        'enterprise': {'limit': 10000, 'window': 3600}  # 10000/hour
    }
    
    return limits.get(user_tier, limits['free'])
```

### Per-Endpoint Rate Limiting

```python
# Different limits for different endpoints
ENDPOINT_LIMITS = {
    '/api/login': {'limit': 5, 'window': 300},      # 5 per 5 minutes
    '/api/search': {'limit': 30, 'window': 60},     # 30 per minute
    '/api/data': {'limit': 100, 'window': 3600},    # 100 per hour
}

def endpoint_rate_limit_middleware(endpoint, identifier):
    limits = ENDPOINT_LIMITS.get(endpoint, {'limit': 60, 'window': 60})
    return check_rate_limit(identifier, limits['limit'], limits['window'])
```

### Adaptive Rate Limiting

```python
class AdaptiveRateLimiter:
    def __init__(self, redis_client):
        self.redis = redis_client
        self.base_limit = 100
        self.min_limit = 10
        self.max_limit = 1000
    
    def get_limit(self, identifier):
        """
        Adjust limit based on system load
        """
        # Check system load
        load_avg = self.get_system_load()
        
        if load_avg > 0.8:
            # High load - reduce limits
            return max(self.min_limit, int(self.base_limit * 0.5))
        elif load_avg < 0.3:
            # Low load - increase limits
            return min(self.max_limit, int(self.base_limit * 1.5))
        else:
            return self.base_limit
    
    def get_system_load(self):
        # Get from monitoring system or calculate
        import os
        return os.getloadavg()[0] / os.cpu_count()
```

## Rate Limit Headers

Always include rate limit information in responses:

```python
def rate_limit_headers(remaining, reset_time, limit):
    return {
        'X-RateLimit-Limit': str(limit),
        'X-RateLimit-Remaining': str(remaining),
        'X-RateLimit-Reset': str(int(reset_time)),
        'Retry-After': str(int(reset_time - time.time()))
    }

# Usage in Flask
@app.route('/api/data')
@rate_limit(limit=100, window=3600)
def get_data():
    # Get rate limit info
    info = get_rate_limit_info(request.user.id)
    
    response = jsonify({'data': get_data()})
    
    # Add headers
    for key, value in rate_limit_headers(
        info['remaining'],
        info['reset_time'],
        info['limit']
    ).items():
        response.headers[key] = value
    
    return response
```

## Testing Rate Limits

```python
import unittest
import time

class TestRateLimiter(unittest.TestCase):
    def setUp(self):
        self.redis = redis.Redis()
        self.limiter = DistributedRateLimiter(self.redis)
        self.key = 'test_user'
    
    def test_allows_requests_within_limit(self):
        limit = 10
        window = 60
        
        # Make requests up to limit
        for i in range(limit):
            result = self.limiter.check_rate_limit(
                self.key, limit, window
            )
            self.assertTrue(result['allowed'])
        
        # Next request should be blocked
        result = self.limiter.check_rate_limit(
            self.key, limit, window
        )
        self.assertFalse(result['allowed'])
    
    def test_resets_after_window(self):
        limit = 10
        window = 1  # 1 second for testing
        
        # Exhaust limit
        for i in range(limit):
            self.limiter.check_rate_limit(self.key, limit, window)
        
        # Wait for window to expire
        time.sleep(window + 0.1)
        
        # Should allow again
        result = self.limiter.check_rate_limit(
            self.key, limit, window
        )
        self.assertTrue(result['allowed'])
```

## Best Practices

1. **Use sliding window or token bucket** - More accurate than fixed window
2. **Store limits in Redis** - Enables distributed rate limiting
3. **Use Lua scripts** - Atomic operations prevent race conditions
4. **Include rate limit headers** - Help clients understand limits
5. **Implement different limits** - Per user tier, per endpoint
6. **Monitor rate limit hits** - Alert on abuse patterns
7. **Graceful degradation** - Don't fail completely on rate limit

## Conclusion

Effective rate limiting requires:
- Choosing the right algorithm (sliding window or token bucket)
- Using Redis for distributed systems
- Implementing atomic operations with Lua scripts
- Providing clear feedback to clients
- Monitoring and adjusting limits

Start with sliding window counter for most use cases, then evolve to token bucket if you need burst handling. The patterns shown here handle millions of requests per day.

---

*Rate limiting patterns using Redis, reflecting best practices from late 2016.*

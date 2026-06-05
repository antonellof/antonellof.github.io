---
layout: post
title: "Implementing Rate Limiting: Patterns and Best Practices"
date: 2016-09-24
categories: [How-To]
tags: [Rate Limiting, API Security, Performance, Redis]
excerpt: "One customer wrote a script that called our API 50,000 times an hour. Nobody else could log in. Here's how we built rate limiting that actually works — algorithms, Redis, and the headers your clients deserve."
---

We didn't implement rate limiting because we read a security best practices checklist. We implemented it because one enthusiastic customer — let's call them a "power user" — wrote a script that hit our login endpoint 50,000 times in an hour and took the API down for everyone else.

That's the moment rate limiting stops being theoretical. It's not about punishing users. It's about making sure one actor can't starve the rest. It's about protecting your database from itself. It's about sleeping through the night without wondering if someone's scraping your entire dataset at 3 AM.

After rate limiting APIs handling millions of requests per day, here's what actually scales — the algorithms, the Redis patterns, and the client-facing details that separate "we blocked you" from "here's when you can try again."

## Why Rate Limiting Exists

Rate limiting is traffic control for your API. Without it:

- One abusive client becomes everyone's outage
- Your cloud bill becomes a function of someone else's bad loop
- Fair usage stops being fair
- Login endpoints become brute-force welcome mats

With it, you cap damage, preserve capacity for legitimate users, and get a lever for tiered pricing (free gets 100/hour, enterprise gets 10,000/hour). Everybody wins except the script kiddie. They get a 429 and a `Retry-After` header.

## The Algorithm Zoo: Pick Your Poison

### Fixed Window: Simple, Sneaky

Count requests per time bucket. Easy to implement. Has a famous flaw:

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

At the boundary between windows, a client can send 100 requests at 0:59 and 100 more at 1:00. You allowed 200 in two seconds while thinking you allowed 100 per minute. Fixed windows are fine for coarse protection. Don't use them for strict quotas.

### Sliding Window Log: Accurate, Memory-Hungry

Track every request timestamp. Precise. Expensive:

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

Every request is a sorted set entry. At millions of requests per hour per key, memory adds up. Great for low-volume, high-stakes endpoints (login, password reset). Overkill for general API traffic.

### Sliding Window Counter: The Sweet Spot

Approximate sliding window using multiple fixed sub-windows. Good enough for almost everything:

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

Ten sub-windows gives you ~90% of sliding window accuracy at a fraction of the memory cost. This is where most APIs should start.

## Token Bucket: When Bursts Are Features, Not Bugs

Some use cases want to allow short bursts — a user loads a dashboard that fires 20 parallel requests. Token bucket says "you can spike, but you refill slowly."

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

The Lua script is non-negotiable. Without atomic read-modify-write, two concurrent requests both see 1 token left and both proceed. You've built a rate limiter that doesn't rate limit.

## Distributed Rate Limiting: Multiple Servers, One Counter

In-memory rate limiting per server means a user with 100 req/min limit gets 100 per server. Three servers? 300. Redis centralizes the count:

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

Redis becomes a single point of failure. Run it with replication or accept that rate limiting disappears when Redis dies — and decide whether that's fail-open (allow traffic) or fail-closed (block everyone). We chose fail-open for availability, fail-closed for auth endpoints.

## Middleware: Where Limits Meet Requests

### Express.js

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

`rate-limiter-flexible` handles the Redis plumbing. Roll your own if you enjoy debugging race conditions.

### Laravel

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

Authenticated users get rate limited by user ID. Anonymous traffic by IP. Shared NAT offices will share a bucket — document that or offer API keys.

## Strategies Beyond "100 Per Minute for Everyone"

### Tiered Limits

Free users and enterprise customers shouldn't share the same bucket:

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

Rate limits become a product feature. "Upgrade for higher limits" is a sentence your sales team can use.

### Per-Endpoint Limits

Login and search shouldn't share limits. Login gets brute-forced. Search gets scraped:

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

Tight limits on auth endpoints. Generous limits on read-heavy data endpoints. Obvious in hindsight, often skipped in implementation.

### Adaptive Limits

When the system is drowning, lower limits. When it's idle, loosen up:

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

Adaptive limiting is a circuit breaker for your API. Use carefully — users notice when limits change mid-session.

## Headers: Tell Clients What's Happening

A 429 without context is a support ticket. Headers turn confusion into self-service:

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

`X-RateLimit-Remaining` on successful responses lets well-behaved clients throttle themselves. `Retry-After` on 429s tells them exactly when to come back. This is API hygiene.

## Testing: Prove It Before Production Proves It For You

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

Test the boundary. Test reset timing. Test concurrent access if you're not using Lua. The limiter that works in unit tests and fails under parallel load is more common than you'd think.

## What We Actually Recommend

Skip fixed windows for anything strict. Start with sliding window counter for general API protection. Reach for token bucket when bursts are legitimate. Always use Redis (or equivalent) for distributed deployments. Always use Lua scripts for atomicity. Always return headers.

Different limits per tier and per endpoint — login is not search. Monitor rate limit hits; a spike in 429s on `/api/login` is someone trying something. Graceful degradation on Redis failure is a policy decision, not an implementation detail.

Rate limiting isn't about saying no. It's about making "no" rare, fair, and survivable — for your users, your infrastructure, and your on-call rotation.

---

*Rate limiting patterns using Redis, reflecting best practices from late 2016. Algorithm tradeoffs and header conventions remain standard; managed API gateways now offer built-in rate limiting for teams that prefer not to roll their own.*

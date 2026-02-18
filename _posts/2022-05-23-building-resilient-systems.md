---
layout: post
title: "Building Resilient Systems: Timeout, Retry, and Fallback"
date: 2022-05-23
categories: [Architecture]
tags: [Resilience, Patterns, Architecture]
excerpt: "Build resilient systems with timeout, retry, and fallback patterns. Learn how to handle failures gracefully and maintain system availability."
---

Resilient systems handle failures gracefully. After building production systems, here are the patterns that work.

## Timeout Pattern

### Implementation

```javascript
function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error('Operation timed out'));
            }, timeoutMs);
        })
    ]);
}

// Usage
try {
    const result = await withTimeout(
        fetchUser(userId),
        5000 // 5 second timeout
    );
} catch (error) {
    if (error.message === 'Operation timed out') {
        // Handle timeout
        return getCachedUser(userId);
    }
    throw error;
}
```

## Retry Pattern

### Exponential Backoff

```javascript
async function retryWithBackoff(fn, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const initialDelay = options.initialDelay || 1000;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            
            const delay = initialDelay * Math.pow(2, attempt);
            await sleep(delay);
        }
    }
}
```

## Fallback Pattern

### Implementation

```javascript
async function getUserWithFallback(userId) {
    try {
        return await userService.getUser(userId);
    } catch (error) {
        // Fallback to cache
        const cached = await cache.get(`user:${userId}`);
        if (cached) {
            return cached;
        }
        
        // Fallback to default
        return {
            id: userId,
            name: 'Guest',
            email: 'guest@example.com'
        };
    }
}
```

## Best Practices

1. **Set timeouts** - Prevent hanging
2. **Retry wisely** - Exponential backoff
3. **Use fallbacks** - Graceful degradation
4. **Monitor failures** - Track patterns
5. **Circuit breakers** - Prevent cascading
6. **Handle errors** - Proper error types
7. **Test failures** - Chaos engineering
8. **Document patterns** - Clear guidelines

## Conclusion

Resilient systems require:
- Timeout handling
- Retry logic
- Fallback strategies
- Error monitoring

Combine patterns for production resilience. The patterns shown here handle real-world failures.

---

*Building resilient systems from May 2022, covering timeout, retry, and fallback patterns.*

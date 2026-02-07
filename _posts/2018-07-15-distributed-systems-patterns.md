---
layout: post
title: "Distributed Systems Patterns: Circuit Breaker and Retry Logic"
date: 2018-07-15
categories: [Architecture]
tags: [Distributed Systems, Resilience, Patterns]
excerpt: "Implement resilience patterns in distributed systems: circuit breakers, retry logic, bulkheads, and timeouts. Learn how to handle failures gracefully in microservices."
---

Distributed systems fail. After building resilient microservices, I've learned that proper failure handling is critical. Here are the patterns that work in production.

## The Problem

In distributed systems:
- Networks fail
- Services crash
- Timeouts occur
- Cascading failures happen

Without proper patterns, one failure can bring down the entire system.

## Circuit Breaker Pattern

### Concept

A circuit breaker:
- **Open**: Fails fast, doesn't call service
- **Closed**: Normal operation
- **Half-Open**: Testing if service recovered

### Implementation

```javascript
class CircuitBreaker {
    constructor(service, options = {}) {
        this.service = service;
        this.failureThreshold = options.failureThreshold || 5;
        this.timeout = options.timeout || 60000; // 60 seconds
        this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
        
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.nextAttempt = Date.now();
    }
    
    async call(...args) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error('Circuit breaker is OPEN');
            }
            // Try half-open
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
        this.failureCount = 0;
        this.state = 'CLOSED';
    }
    
    onFailure() {
        this.failureCount++;
        
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.resetTimeout;
        }
    }
    
    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            nextAttempt: this.nextAttempt
        };
    }
}
```

### Usage

```javascript
const axios = require('axios');

async function fetchUser(userId) {
    const response = await axios.get(`https://api.example.com/users/${userId}`);
    return response.data;
}

const breaker = new CircuitBreaker(fetchUser, {
    failureThreshold: 5,
    resetTimeout: 30000
});

// Use circuit breaker
try {
    const user = await breaker.call('123');
    console.log(user);
} catch (error) {
    if (error.message === 'Circuit breaker is OPEN') {
        // Return cached data or default
        return getCachedUser('123');
    }
    throw error;
}
```

## Retry Logic

### Exponential Backoff

```javascript
async function retryWithBackoff(fn, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const initialDelay = options.initialDelay || 1000;
    const maxDelay = options.maxDelay || 30000;
    const multiplier = options.multiplier || 2;
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            // Don't retry on certain errors
            if (error.status === 400 || error.status === 401) {
                throw error;
            }
            
            if (attempt < maxRetries) {
                const delay = Math.min(
                    initialDelay * Math.pow(multiplier, attempt),
                    maxDelay
                );
                
                await sleep(delay);
            }
        }
    }
    
    throw lastError;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Jitter

```javascript
function addJitter(delay, jitter = 0.1) {
    const jitterAmount = delay * jitter * Math.random();
    return delay + jitterAmount;
}

async function retryWithJitter(fn, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const baseDelay = options.baseDelay || 1000;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt < maxRetries) {
                const delay = addJitter(baseDelay * Math.pow(2, attempt));
                await sleep(delay);
            } else {
                throw error;
            }
        }
    }
}
```

## Timeout Pattern

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
        fetchUser('123'),
        5000 // 5 second timeout
    );
} catch (error) {
    if (error.message === 'Operation timed out') {
        // Handle timeout
    }
}
```

## Bulkhead Pattern

Isolate resources to prevent cascading failures:

```javascript
class Bulkhead {
    constructor(maxConcurrency) {
        this.maxConcurrency = maxConcurrency;
        this.active = 0;
        this.queue = [];
    }
    
    async execute(fn) {
        return new Promise((resolve, reject) => {
            if (this.active < this.maxConcurrency) {
                this.run(fn, resolve, reject);
            } else {
                this.queue.push({ fn, resolve, reject });
            }
        });
    }
    
    async run(fn, resolve, reject) {
        this.active++;
        
        try {
            const result = await fn();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.active--;
            
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                this.run(next.fn, next.resolve, next.reject);
            }
        }
    }
}

// Usage
const bulkhead = new Bulkhead(10); // Max 10 concurrent

await bulkhead.execute(() => fetchUser('123'));
```

## Combining Patterns

```javascript
class ResilientService {
    constructor(service, options = {}) {
        this.circuitBreaker = new CircuitBreaker(service, {
            failureThreshold: options.failureThreshold || 5,
            resetTimeout: options.resetTimeout || 30000
        });
        
        this.bulkhead = new Bulkhead(options.maxConcurrency || 10);
        this.timeout = options.timeout || 5000;
    }
    
    async call(...args) {
        return this.bulkhead.execute(async () => {
            return withTimeout(
                this.circuitBreaker.call(...args),
                this.timeout
            );
        });
    }
}

// Usage
const resilientService = new ResilientService(fetchUser, {
    failureThreshold: 5,
    resetTimeout: 30000,
    maxConcurrency: 10,
    timeout: 5000
});

try {
    const user = await resilientService.call('123');
} catch (error) {
    // Handle error gracefully
    return getFallbackUser('123');
}
```

## Node.js Libraries

### Opossum (Circuit Breaker)

```javascript
const CircuitBreaker = require('opossum');

const options = {
    timeout: 3000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000
};

const breaker = new CircuitBreaker(fetchUser, options);

breaker.on('open', () => console.log('Circuit breaker opened'));
breaker.on('halfOpen', () => console.log('Circuit breaker half-open'));
breaker.on('close', () => console.log('Circuit breaker closed'));

breaker.fallback(() => getCachedUser('123'));

const user = await breaker.fire('123');
```

### Axios Retry

```javascript
const axios = require('axios');
const axiosRetry = require('axios-retry');

const client = axios.create();

axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               error.response?.status >= 500;
    }
});

const response = await client.get('https://api.example.com/users/123');
```

## Monitoring

```javascript
class ResilientService {
    constructor(service, options = {}) {
        // ... existing code ...
        this.metrics = {
            totalCalls: 0,
            failures: 0,
            timeouts: 0,
            circuitBreakerOpens: 0
        };
    }
    
    async call(...args) {
        this.metrics.totalCalls++;
        const startTime = Date.now();
        
        try {
            const result = await this.execute(...args);
            const duration = Date.now() - startTime;
            this.recordSuccess(duration);
            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            this.recordFailure(error, duration);
            throw error;
        }
    }
    
    recordSuccess(duration) {
        // Send to metrics system
        metrics.histogram('service.call.duration', duration);
        metrics.increment('service.call.success');
    }
    
    recordFailure(error, duration) {
        if (error.message.includes('timeout')) {
            this.metrics.timeouts++;
        } else {
            this.metrics.failures++;
        }
        
        metrics.increment('service.call.failure');
        metrics.histogram('service.call.duration', duration);
    }
}
```

## Best Practices

1. **Use circuit breakers** - Prevent cascading failures
2. **Implement retries** - With exponential backoff
3. **Set timeouts** - Don't wait forever
4. **Use bulkheads** - Isolate resources
5. **Monitor metrics** - Track failures and latency
6. **Have fallbacks** - Return cached/default data
7. **Fail fast** - Don't retry forever
8. **Test failures** - Chaos engineering

## Conclusion

Resilience patterns enable:
- Graceful failure handling
- Prevention of cascading failures
- Better user experience
- System stability

Combine circuit breakers, retries, timeouts, and bulkheads for production-ready services. The patterns shown here handle real-world failures.

---

*Distributed systems resilience patterns from July 2018, covering production patterns.*

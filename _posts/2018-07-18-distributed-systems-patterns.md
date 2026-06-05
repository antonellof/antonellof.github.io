---
layout: post
title: "Distributed Systems Patterns: Circuit Breaker and Retry Logic"
date: 2018-07-18
categories: [Architecture]
tags: [Distributed Systems, Resilience, Patterns]
excerpt: "One flaky microservice took down our whole checkout flow. Here's how circuit breakers, retries, timeouts, and bulkheads stopped the domino effect — with code you can actually ship."
---

At 2:47 AM on a Tuesday, our recommendation service started timing out. Nothing dramatic — just a few slow responses. But our order service retried. And retried. And retried. By 2:52 AM, we'd exhausted connection pools, thread pools, and the patience of the on-call engineer (me, in sweatpants, questioning career choices).

That's the thing about distributed systems: **failure is not an edge case. It's Tuesday.** Networks drop packets. Services OOM. Someone deploys a typo to production. Without deliberate resilience patterns, one sick service infects the whole herd.

These are the patterns we landed on after that incident — and several like it — in production microservices. Not theory from a textbook. Actual code that kept us from paging the CEO.

## Why "Just Retry" Is a Trap

In a monolith, a slow database call is annoying. In microservices, it's contagious.

When Service A calls Service B, which calls Service C, and C hiccups:
- A's threads block waiting for B
- B's threads block waiting for C
- Users see spinners. Then errors. Then Twitter mentions.

The naive fix — "retry harder" — makes it worse. You're not healing the system; you're amplifying the outage. The patterns below work together: **fail fast when you should, retry when it helps, and isolate blast radius when all else fails.**

## Circuit Breaker: The Bouncer at the Door

Think of a circuit breaker like a bouncer who watched three people get turned away at the door and decided, "Yeah, we're not letting anyone in until management sorts this out."

Three states:
- **Closed** — Normal operation. Requests flow through.
- **Open** — Fail fast. Don't even bother calling the downstream service.
- **Half-Open** — Tentative probe. "Are you feeling better? One request, just to check."

The key insight: when a dependency is down, **stop hammering it**. Return cached data, a degraded response, or a clear error. Your users prefer "recommendations unavailable" over a 45-second timeout.

### Roll Your Own (It's Simpler Than You Think)

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

### Wiring It Up

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

**Tuning tip:** `failureThreshold: 5` and `resetTimeout: 30000` are reasonable starting points. Too aggressive and you'll flap open/closed on transient blips. Too lenient and you'll burn resources before the breaker trips. Watch your metrics and adjust — this is not a set-and-forget knob.

## Retry Logic: Polite Persistence, Not Spam

Retries are good. *Blind* retries are how you DDoS yourself.

The rules we follow:
- **Retry transient failures** — network blips, 503s, connection resets
- **Don't retry client errors** — a 400 won't magically become a 200 if you ask nicely
- **Use exponential backoff** — give the downstream service room to recover
- **Add jitter** — so 500 clients don't retry at the exact same millisecond (the "thundering herd" problem)

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

### Jitter: Because Synchronized Retries Are Rude

Without jitter, every client that failed at T=0 retries at T=1s, T=2s, T=4s — creating periodic traffic spikes that look like a mini DDoS. Jitter spreads the load.

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

**Lesson learned:** We once had a payment provider outage. Our retry logic was fine. Our *lack* of jitter meant we hit their recovery endpoint with 10x normal traffic the moment they came back online. They went down again. We added jitter the next day.

## Timeouts: The Most Underrated Pattern

A request without a timeout is a request that waits forever. Forever is longer than your users' patience.

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

Set timeouts at **every hop** — client to gateway, gateway to service, service to database. The slowest timeout in the chain wins, and if you only set one, you'll still leak threads everywhere else.

## Bulkhead Pattern: Compartmentalize Like a Ship

On ships, bulkheads prevent one flooded compartment from sinking the whole vessel. In software, bulkheads limit how many concurrent calls can hit a dependency — so when the recommendation service melts down, checkout still works.

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

We give critical paths (payments, auth) their own bulkheads with higher limits. Nice-to-have paths (recommendations, "people also bought") get tighter limits and graceful fallbacks. When things go sideways, the money still moves.

## Stack the Patterns: Defense in Depth

Real resilience isn't one pattern — it's layers. Timeout wraps circuit breaker wraps bulkhead. Each layer catches what the previous one missed.

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

## Don't Reinvent Everything: Use Battle-Tested Libraries

We rolled our own circuit breaker once for learning. In production, we use **Opossum** — it handles edge cases we hadn't thought of and emits events for monitoring.

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

For HTTP retries, **axios-retry** saves you from copy-pasting backoff logic into every service:

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

## If You Can't Measure It, You Can't Fix It at 3 AM

Patterns without metrics are wishful thinking. Track what matters:

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

Alert on circuit breaker opens. Graph retry rates. When failure counts spike before a breaker trips, your thresholds need tuning. When breakers never open despite high error rates, they're decorative.

## What We Actually Do in Production

After enough incidents, these became our defaults — not commandments, but strong opinions:

Circuit breakers go on every cross-service call that isn't strictly required for the happy path. Retries use exponential backoff with jitter, capped at three attempts, and never on 4xx errors. Every outbound call has an explicit timeout — usually 3–5 seconds for internal services, longer for external APIs with SLAs. Bulkheads separate critical from optional dependencies. Fallbacks return stale cache or degraded responses rather than errors when the business allows it. And we chaos-test quarterly — because patterns you haven't tested are patterns you don't trust.

## The Bottom Line

Distributed systems don't fail gracefully on their own. That's your job.

Circuit breakers stop you from drowning a sick service. Retries handle transient blips — with backoff and jitter so you don't make things worse. Timeouts prevent thread leaks and user rage. Bulkheads keep one bad dependency from taking down everything else.

The recommendation service still flakes sometimes. But checkout works. And I sleep in sweatpants by choice now, not because of a pager.

---

*Written July 2018. Patterns and libraries (Opossum, axios-retry) reflect the Node.js ecosystem at the time — the concepts are timeless; check current library versions before copy-pasting into a 2024 codebase.*

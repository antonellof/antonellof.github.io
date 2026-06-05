---
layout: post
title: "Building Resilient Systems: Timeout, Retry, and Fallback"
date: 2022-05-23
categories: [Architecture]
tags: [Resilience, Patterns, Architecture]
excerpt: "Our payment service didn't crash. It just... stopped responding. No errors, no timeouts, no alerts. Requests piled up until the entire checkout flow seized like an engine running without oil."
---

The incident report was maddening in its simplicity. Payment service healthy according to Kubernetes. CPU at 12%. Memory fine. Logs clean. But checkout had been failing for eleven minutes because the payment provider's API was accepting TCP connections and then... nothing. No response. No error. Just silence.

Our HTTP client had no timeout configured. Default behavior: wait forever.

Forever, in production, is about eleven minutes—until connection pools fill up, thread pools exhaust, and the failure cascades from payment service to order service to the entire checkout flow. One hung connection took down revenue for a quarter hour.

That incident taught me something I've never forgotten: **resilience isn't about handling errors. It's about handling the absence of errors when something is clearly wrong.**

Timeouts, retries, and fallbacks are the three patterns I reach for first. Not because they're fancy—because they prevent silent failures from becoming cascading disasters.

## The Failure Modes You're Actually Fighting

Before diving into patterns, understand what breaks in distributed systems:

| Failure Type | What Happens | What You See |
|--------------|--------------|--------------|
| Hard failure | Service returns 500, connection refused | Error logs, alerts fire |
| Slow failure | Service responds... eventually | Timeouts (if configured) |
| Silent failure | Connection accepted, no response | Nothing. Until cascade. |
| Partial failure | Service returns degraded data | Wrong data, silent corruption |
| Thundering herd | Service recovers, all clients retry at once | Immediate re-failure |

Hard failures are easy. Silent and slow failures are what kill you at 3am.

## Pattern 1: Timeouts — Assume Everything Will Hang

Every external call needs a timeout. No exceptions. Not the database. Not Redis. Not the internal service "that never goes down."

```javascript
function withTimeout(promise, timeoutMs, operation = 'operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new TimeoutError(
                    `${operation} timed out after ${timeoutMs}ms`
                ));
            }, timeoutMs);
        }),
    ]);
}

// Usage
async function getUser(userId) {
    return withTimeout(
        userService.fetch(userId),
        3000,  // 3 seconds max
        `fetchUser(${userId})`
    );
}
```

### Choosing Timeout Values

This is part science, part art:

```javascript
const TIMEOUTS = {
    // User-facing requests: tight
    checkout: 5000,
    search: 2000,
    
    // Internal service calls: moderate
    userService: 3000,
    inventoryService: 3000,
    
    // Background jobs: generous
    reportGeneration: 60000,
    dataExport: 300000,
};
```

My rule of thumb: **set timeout at 2-3x your p99 latency**, then tune based on incidents. If your user service p99 is 800ms, start with 2000-3000ms timeout.

Too tight: false timeouts during normal load spikes.
Too loose: cascading failures during actual outages.

### Timeouts at Every Layer

Don't just timeout the HTTP call—timeout the entire operation including retries:

```javascript
async function checkoutWithDeadline(cart, deadlineMs = 10000) {
    const deadline = Date.now() + deadlineMs;
    
    const remainingTime = () => deadline - Date.now();
    
    if (remainingTime() <= 0) {
        throw new DeadlineExceededError('Checkout deadline exceeded');
    }
    
    const user = await withTimeout(
        getUser(cart.userId),
        Math.min(remainingTime(), 3000),
        'getUser'
    );
    
    const inventory = await withTimeout(
        checkInventory(cart.items),
        Math.min(remainingTime(), 3000),
        'checkInventory'
    );
    
    const payment = await withTimeout(
        processPayment(cart, user),
        Math.min(remainingTime(), 5000),
        'processPayment'
    );
    
    return { user, inventory, payment };
}
```

The checkout has a 10-second deadline. Each sub-operation gets the minimum of its normal timeout and whatever time remains. No single slow call consumes the entire budget.

## Pattern 2: Retry — But Not Like a Maniac

Retries save you from transient failures—a momentary network blip, a pod restart, a GC pause. Retries destroy you from permanent failures—if every client retries a failing service simultaneously, you create a DDoS against yourself.

### Exponential Backoff with Jitter

```javascript
async function retryWithBackoff(fn, options = {}) {
    const {
        maxRetries = 3,
        initialDelayMs = 100,
        maxDelayMs = 10000,
        backoffMultiplier = 2,
        jitter = true,
        retryableErrors = [TimeoutError, NetworkError],
    } = options;
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            const isRetryable = retryableErrors.some(
                ErrorType => error instanceof ErrorType
            );
            
            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }
            
            let delay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
            delay = Math.min(delay, maxDelayMs);
            
            // Jitter: randomize delay to prevent thundering herd
            if (jitter) {
                delay = delay * (0.5 + Math.random() * 0.5);
            }
            
            logger.warn(`Retry attempt ${attempt + 1}/${maxRetries}`, {
                error: error.message,
                delayMs: Math.round(delay),
            });
            
            await sleep(delay);
        }
    }
    
    throw lastError;
}

// Usage
const user = await retryWithBackoff(
    () => userService.fetch(userId),
    { maxRetries: 3, initialDelayMs: 200 }
);
```

### What to Retry (and What Not To)

**Retry these:**
- Timeouts
- Connection errors
- 429 (Too Many Requests) — with backoff
- 502, 503, 504 — server/gateway errors

**Never retry these:**
- 400 (Bad Request) — your fault, retrying won't help
- 401, 403 — auth issues
- 404 — resource doesn't exist
- 409 (Conflict) — business logic rejection

```javascript
function isRetryable(error) {
    if (error instanceof TimeoutError) return true;
    if (error instanceof NetworkError) return true;
    if (error.statusCode === 429) return true;
    if (error.statusCode >= 500) return true;
    return false;
}
```

Retrying a 400 Bad Request twelve times because your retry logic doesn't check status codes? I've done it. It's embarrassing.

### Idempotency: The Retry Prerequisite

Retries are only safe for **idempotent operations**—operations that produce the same result whether you execute them once or five times.

```javascript
// NOT idempotent — retrying creates duplicate charges
async function chargeCard(amount, cardToken) {
    return paymentProvider.charge({ amount, cardToken });
}

// Idempotent — uses idempotency key
async function chargeCardIdempotent(amount, cardToken, idempotencyKey) {
    return paymentProvider.charge({
        amount,
        cardToken,
        idempotencyKey,  // Provider deduplicates by this key
    });
}

// Usage: generate key once, reuse on retry
const idempotencyKey = `order-${orderId}-payment`;
const payment = await retryWithBackoff(
    () => chargeCardIdempotent(amount, cardToken, idempotencyKey)
);
```

GET requests are naturally idempotent. POST requests need idempotency keys. PUT and DELETE usually are, but verify.

## Pattern 3: Fallback — Graceful Degradation

When retries exhaust and timeouts fire, fallback keeps the system usable—degraded, but usable.

```javascript
async function getUserWithFallback(userId) {
    try {
        return await retryWithBackoff(
            () => withTimeout(userService.fetch(userId), 3000, 'getUser'),
            { maxRetries: 2 }
        );
    } catch (error) {
        logger.warn('User service failed, trying fallbacks', {
            userId,
            error: error.message,
        });
        
        // Fallback 1: Stale cache
        const cached = await cache.get(`user:${userId}`);
        if (cached) {
            metrics.increment('fallback.cache_hit');
            return { ...cached, _stale: true };
        }
        
        // Fallback 2: Default/guest user
        metrics.increment('fallback.default_user');
        return {
            id: userId,
            name: 'Guest',
            email: null,
            _fallback: true,
        };
    }
}
```

### Fallback Strategies by Priority

I think of fallbacks as a ladder—try each rung until something works:

1. **Primary service** — the real thing
2. **Retry with backoff** — maybe it was transient
3. **Stale cache** — old data beats no data
4. **Alternative service** — read replica, backup provider
5. **Static/default response** — hardcoded fallback
6. **Fail gracefully** — return error with helpful message

Which rungs you implement depends on the business impact:

```javascript
// Product recommendations: static fallback is fine
async function getRecommendations(userId) {
    try {
        return await recommendationService.get(userId);
    } catch {
        return STATIC_FALLBACK_RECOMMENDATIONS;  // Curated bestsellers
    }
}

// Payment processing: NO fallback. Fail explicitly.
async function processPayment(order) {
    try {
        return await paymentService.charge(order);
    } catch (error) {
        // Never silently substitute a fake payment
        throw new PaymentFailedError('Unable to process payment', { cause: error });
    }
}
```

**Critical rule:** Know which operations can degrade and which must fail hard. Recommending generic products when the ML service is down? Fine. Pretending a payment succeeded? Criminal.

## Combining the Patterns

In production, these patterns stack together:

```javascript
async function getProductDetails(productId) {
    const cacheKey = `product:${productId}`;
    
    // Layer 1: Cache (fastest fallback)
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
    
    // Layer 2: Primary service with timeout + retry
    try {
        const product = await retryWithBackoff(
            () => withTimeout(
                productService.fetch(productId),
                2000,
                'fetchProduct'
            ),
            { maxRetries: 2, initialDelayMs: 100 }
        );
        
        // Populate cache on success
        await cache.setex(cacheKey, 300, JSON.stringify(product));
        return product;
        
    } catch (primaryError) {
        logger.warn('Primary product service failed', {
            productId,
            error: primaryError.message,
        });
        
        // Layer 3: Read replica fallback
        try {
            const product = await withTimeout(
                productServiceReadReplica.fetch(productId),
                3000,
                'fetchProductReplica'
            );
            
            await cache.setex(cacheKey, 60, JSON.stringify(product));  // Shorter TTL
            return { ...product, _source: 'replica' };
            
        } catch (replicaError) {
            // Layer 4: Static fallback for known products
            const staticProduct = STATIC_CATALOG[productId];
            if (staticProduct) {
                return { ...staticProduct, _source: 'static' };
            }
            
            // Layer 5: Fail with useful error
            throw new ProductUnavailableError(productId, {
                primaryError,
                replicaError,
            });
        }
    }
}
```

Cache → retry with timeout → read replica → static fallback → explicit failure. Five layers of resilience before giving up.

## Circuit Breakers: When Retries Become the Problem

Retries help with transient failures. But if a service is genuinely down, retries just waste time and amplify load. Circuit breakers stop calling services that aren't going to respond:

```javascript
class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeoutMs = options.resetTimeoutMs || 30000;
        this.state = 'CLOSED';  // CLOSED = normal, OPEN = failing, HALF_OPEN = testing
        this.failureCount = 0;
        this.lastFailureTime = null;
    }
    
    async execute(fn, fallback) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
                this.state = 'HALF_OPEN';
            } else {
                return fallback();  // Skip call entirely
            }
        }
        
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            if (this.state === 'OPEN') {
                return fallback();
            }
            throw error;
        }
    }
    
    onSuccess() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }
    
    onFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            logger.error('Circuit breaker OPEN', { failureCount: this.failureCount });
        }
    }
}

// Usage
const paymentBreaker = new CircuitBreaker({ failureThreshold: 3 });

async function processPayment(order) {
    return paymentBreaker.execute(
        () => paymentService.charge(order),
        () => { throw new PaymentServiceUnavailableError(); }
    );
}
```

When the circuit is OPEN, calls fail immediately—no waiting for timeouts, no retry storms. After 30 seconds, one test call goes through (HALF_OPEN). If it succeeds, circuit closes. If it fails, back to OPEN.

Libraries like [opossum](https://github.com/nodeshift/opossum) (Node.js) and [resilience4j](https://github.com/resilience4j/resilience4j) (Java) implement this with metrics and configuration.

## Testing Resilience (Not Just Happy Path)

Patterns you don't test don't work when you need them. I use chaos engineering lite:

```javascript
// Fault injection middleware for staging
app.use((req, res, next) => {
    const faultConfig = req.headers['x-fault-injection'];
    if (!faultConfig || process.env.NODE_ENV === 'production') {
        return next();
    }
    
    const { type, probability = 0.5 } = JSON.parse(faultConfig);
    
    if (Math.random() > probability) return next();
    
    switch (type) {
        case 'timeout':
            // Never respond — test client timeouts
            return;  // Hang forever
        case 'slow':
            return setTimeout(next, 10000);  // 10s delay
        case 'error':
            return res.status(503).json({ error: 'Injected failure' });
        default:
            next();
    }
});
```

Regular chaos tests in staging:
- Kill a service pod, verify fallbacks activate
- Inject 5-second latency, verify timeouts fire
- Return 503 for 60 seconds, verify circuit breaker opens
- Restore service, verify circuit breaker closes

If you haven't tested it, assume it's broken.

## Production Checklist

Before shipping any service that calls external dependencies:

- [ ] **Every external call has a timeout** — HTTP, database, cache, message queue
- [ ] **Retries use exponential backoff with jitter** — not immediate retries
- [ ] **Retry logic checks error types** — don't retry 400s
- [ ] **Write operations use idempotency keys** — safe to retry
- [ ] **Fallback strategy defined per operation** — know what can degrade
- [ ] **Circuit breakers on critical dependencies** — fail fast when services are down
- [ ] **Metrics on timeout/retry/fallback rates** — you can't fix what you can't see
- [ ] **Chaos tests in staging** — verify patterns actually work

## Conclusion

That eleven-minute checkout outage? A three-line timeout would have prevented it. The payment provider's silence would have become a caught `TimeoutError`, retried twice, then failed gracefully with "Payment temporarily unavailable—please try again."

Resilience patterns aren't exciting. Nobody gets promoted for adding timeouts. But they're the difference between a blip users never notice and an incident that wakes up the on-call engineer at 3am.

Set timeouts on everything. Retry with backoff and jitter. Fall back gracefully where business rules allow. Break circuits when services are genuinely down. Test it all in staging before production teaches you the hard way.

**Further Resources:**
- [Release It!](https://pragprog.com/titles/mnee2/release-it-second-edition/) — Michael Nygard's resilience bible
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html) — Martin Fowler
- [Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) — AWS Architecture Blog
- [resilience4j](https://github.com/resilience4j/resilience4j) — Java resilience library
- [opossum](https://github.com/nodeshift/opossum) — Node.js circuit breaker

---

*Building resilient systems from May 2022, covering timeout, retry, and fallback patterns.*

---
layout: post
title: "Microservices Communication: Synchronous vs Asynchronous"
date: 2020-08-28
categories: [Architecture]
tags: [Microservices, Communication, Architecture]
excerpt: "The worst microservices call each other in a chain and take down the whole system when one hiccups. Here's how to choose sync vs async communication—and why the answer is usually both."
---

Our order service called the inventory service called the pricing service called the user service. User service timed out. Pricing failed. Inventory failed. Order failed. The customer saw an error. Four services were involved in a 2-second page load that returned nothing.

This is the microservices trap: you split the monolith for independence, then wire everything synchronously and build a **distributed monolith**—all the coupling, plus network latency and cascading failures.

Communication patterns are the fix. Not "always REST" or "always events." The right question: does this interaction need an immediate response, or can it happen eventually? The answer determines sync vs async—and most real systems need both.

## The Fundamental Trade-off

**Synchronous (request-response):**
- Client waits for response
- Strong consistency possible
- Tight temporal coupling—both sides must be up simultaneously
- Failures cascade unless you add circuit breakers, timeouts, fallbacks

**Asynchronous (events/messages):**
- Sender doesn't wait
- Eventual consistency
- Loose coupling—services can be down temporarily
- Harder to debug, duplicate messages, ordering challenges

Neither is "better." They're different tools.

## Synchronous Patterns

### REST: The Default Choice

```javascript
// Client
const response = await fetch('http://user-service/api/users/123');
const user = await response.json();

// Server
app.get('/api/users/:id', async (req, res) => {
    const user = await userService.getUser(req.params.id);
    res.json(user);
});
```

REST wins on simplicity. HTTP everywhere, great tooling, easy debugging with curl, browser devtools, and logs. Every engineer knows it.

**Use REST for:**
- Public APIs
- User-facing request/response flows
- Simple CRUD between services
- When you need HTTP caching, CDN, standard auth

**REST problems at scale:**
- Cascading failures (A → B → C, C dies, all die)
- Latency stacks (50ms × 5 hops = 250ms minimum)
- No built-in retry/delivery guarantees

Mitigate with timeouts (always), circuit breakers (Netflix Hystrix pattern, or [resilience4j](https://github.com/resilience4j/resilience4j)), and bulkheads (isolate thread pools per dependency).

### gRPC: Internal Service Communication

```javascript
// Client
const user = await userClient.getUser({ userId: '123' });

// Server
async getUser(call, callback) {
    const user = await userService.getUser(call.request.userId);
    callback(null, user);
}
```

gRPC uses HTTP/2, Protocol Buffers, and generates typed clients from `.proto` files. It's faster and more efficient than REST JSON—binary serialization, multiplexed connections, streaming support.

**Use gRPC for:**
- Service-to-service internal APIs
- High-throughput, low-latency calls
- Streaming (server-side, client-side, bidirectional)
- When you control both ends and want type safety

**Skip gRPC for:**
- Public APIs (browsers don't natively support it without grpc-web)
- Simple services where REST is "good enough"
- Teams uncomfortable with protobuf tooling

My rule: REST for external APIs, gRPC for internal hot paths.

## Asynchronous Patterns

### Message Queues: Reliable Delivery

```javascript
// Producer
await sqs.sendMessage({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
        event: 'user.created',
        userId: '123',
        data: userData
    })
}).promise();

// Consumer
const messages = await sqs.receiveMessage({ QueueUrl: queueUrl }).promise();

for (const message of messages.Messages) {
    const event = JSON.parse(message.Body);
    await handleEvent(event);
    await sqs.deleteMessage({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle
    }).promise();
}
```

Queues decouple producer and consumer temporally. User service creates a user and drops a message. Email service processes it whenever—seconds later, minutes later, after a restart. Messages persist until acknowledged.

**Use queues for:**
- Background jobs (send email, generate report, resize image)
- Work distribution across consumers
- Peak load buffering
- When you need guaranteed delivery with retries

**Queue essentials:**
- Dead letter queues (DLQ) for messages that fail repeatedly
- Idempotent consumers (same message processed twice shouldn't break things)
- Visibility timeout tuning (SQS-specific, but the concept is universal)

### Event-Driven: Pub/Sub for Fan-Out

```javascript
// Publisher
await eventBus.publish({
    type: 'OrderCreated',
    orderId: '123',
    userId: '456',
    total: 99.99
});

// Multiple subscribers, independently
eventBus.subscribe('OrderCreated', async (event) => {
    await inventoryService.reserveItems(event.orderId);
});

eventBus.subscribe('OrderCreated', async (event) => {
    await emailService.sendConfirmation(event.userId);
});

eventBus.subscribe('OrderCreated', async (event) => {
    await analyticsService.trackOrder(event.orderId);
});
```

One event, many consumers. Add a new subscriber without changing the publisher. This is the loosest coupling—and the hardest to debug when something goes wrong silently.

**Use events for:**
- Notifying multiple services of state changes
- Event sourcing / CQRS projections
- When you want to add consumers without modifying producers

**Event challenges:**
- Ordering (events arriving out of order)
- Duplicates (at-least-once delivery means handle idempotency)
- Debugging ("what happened to order 123?" requires event tracing)
- Schema evolution (version your events)

Tools: [Kafka](https://kafka.apache.org/) for high-throughput event streaming, [RabbitMQ](https://www.rabbitmq.com/) for flexible routing, SNS/SQS for AWS-native, [NATS](https://nats.io/) for simplicity.

## The Hybrid Pattern (What Actually Works)

Pure sync is a distributed monolith. Pure async makes simple things complicated. Production systems hybrid:

```javascript
// Synchronous: user needs immediate response
app.post('/api/orders', async (req, res) => {
    const order = await orderService.createOrder(req.body);
    
    // Asynchronous: background processing
    await eventBus.publish({
        type: 'OrderCreated',
        orderId: order.id,
        userId: order.userId
    });
    
    res.status(201).json(order);  // User gets order ID immediately
});

// Async subscribers handle the rest
eventBus.subscribe('OrderCreated', async (event) => {
    await inventoryService.reserveItems(event.orderId);
});

eventBus.subscribe('OrderCreated', async (event) => {
    await emailService.sendConfirmation(event.userId);
});
```

User gets a fast response. Inventory reservation and email sending happen async. If email service is down, order still completes—email retries later.

This is the pattern I reach for most: **sync for the critical path the user waits on, async for everything else.**

## Decision Framework

| Scenario | Pattern | Why |
|----------|---------|-----|
| User clicks "Buy now" | Sync (create order) + Async (fulfillment) | User needs confirmation now; shipping can wait |
| Dashboard loads user profile | Sync (REST/gRPC) | Immediate data needed |
| Send welcome email on signup | Async (queue) | User doesn't wait for email |
| Update search index on content change | Async (event) | Search can lag seconds |
| Payment processing | Sync with timeout + circuit breaker | Need immediate success/fail |
| Analytics tracking | Async (fire-and-forget) | Never block user flow for analytics |
| Inventory check during checkout | Sync (with fallback) | User needs to know if item is available |

**Use sync when:**
- User is waiting
- Strong consistency required
- Failure must be immediate and visible
- Simple request/response semantics

**Use async when:**
- Background processing
- Multiple consumers need the same event
- Peak load smoothing
- Eventual consistency is acceptable

## Production Essentials

1. **Timeouts everywhere** — never wait forever for a downstream service
2. **Circuit breakers** — stop calling services that are clearly down
3. **Idempotency** — async means duplicates; design for it
4. **Correlation IDs** — trace requests across sync calls and async events
5. **Contract testing** — [Pact](https://docs.pact.io/) or similar for API compatibility
6. **Monitor both paths** — latency for sync, lag for async consumers
7. **Document the choreography** — event flows are invisible without diagrams

## Conclusion

Microservices communication isn't a religious war between REST and Kafka. It's engineering judgment about coupling, consistency, and failure modes.

The order→inventory→pricing→user chain that started this post? We replaced the synchronous chain with: sync call to create the order (user gets response), async event for inventory reservation and payment processing. User service was only called if the order page needed profile data—and cached.

Sync for what users wait on. Async for what can happen later. Circuit breakers for what might fail. Events for what needs fan-out.

That's not microservices ideology. That's just not building a distributed monolith and calling it progress.

---

*Microservices communication patterns from August 2020, covering synchronous and asynchronous approaches.*

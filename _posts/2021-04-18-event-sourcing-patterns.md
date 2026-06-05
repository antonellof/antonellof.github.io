---
layout: post
title: "Event Sourcing: Implementation Patterns"
date: 2021-04-18
categories: [Architecture]
tags: [Event Sourcing, CQRS, Architecture]
excerpt: "Instead of storing current state, store every change that led to it. Event sourcing sounds academic until you need a complete audit trail, time-travel debugging, or the ability to rebuild read models from scratch."
---

"Can you tell me what this order looked like last Tuesday at 3 PM?"

With a traditional database, you get the current order—or you dig through backup tapes and pray. With event sourcing, you replay events until Tuesday 3 PM and reconstruct exact state. Every change ever made is stored. The current state is a projection, not the source of truth.

Event sourcing stores **state changes as an immutable sequence of events** rather than overwriting current state. OrderCreated → ItemAdded → ItemAdded → OrderConfirmed. The events are the truth; the current order is derived by replaying them.

It's not for every system. It's transformative when you need complete audit trails, temporal queries, or multiple read models from the same write stream. It's overkill for a CRUD blog.

We adopted event sourcing for our order management system—compliance required knowing exactly who changed what and when. Here's the implementation that worked.

## Core Concepts

**Event store:** Append-only log of events per aggregate (stream).

**Aggregate:** Domain object reconstructed by replaying its events.

**Projection:** Read model built by processing events (often separate from write model—CQRS).

**Snapshot:** Periodic aggregate state save to avoid replaying thousands of events.

The flow: command → aggregate produces events → events appended to store → projections update read models.

## Event Store Implementation

```javascript
class EventStore {
    constructor(db) {
        this.db = db;
    }
    
    async appendEvents(streamId, events, expectedVersion) {
        const currentVersion = await this.getStreamVersion(streamId);
        
        if (currentVersion !== expectedVersion) {
            throw new ConcurrencyError(
                `Expected version ${expectedVersion}, got ${currentVersion}`
            );
        }
        
        const records = events.map((event, index) => ({
            streamId,
            version: expectedVersion + index + 1,
            eventType: event.constructor.name,
            eventData: JSON.stringify(event),
            metadata: JSON.stringify(event.metadata || {}),
            timestamp: new Date()
        }));
        
        await this.db.events.insertMany(records);
        return expectedVersion + events.length;
    }
    
    async getEvents(streamId, fromVersion = 0) {
        const records = await this.db.events
            .find({ streamId, version: { $gt: fromVersion } })
            .sort({ version: 1 });
        
        return records.map(r => this.deserialize(r));
    }
    
    deserialize(record) {
        const EventClass = EventTypes[record.eventType];
        return Object.assign(new EventClass(), JSON.parse(record.eventData));
    }
}
```

**Optimistic concurrency:** `expectedVersion` prevents lost updates. If two writers race, one fails and retries with fresh events. This is how you handle concurrent modifications without locks.

**Events are immutable.** Never update or delete events. Ever. Corrections are new events (OrderCancelled, not DELETE FROM events).

## Event-Sourced Aggregate

```javascript
class Order {
    constructor(streamId) {
        this.streamId = streamId;
        this.version = 0;
        this.status = 'pending';
        this.items = [];
        this.total = 0;
        this.uncommittedEvents = [];
    }
    
    static fromHistory(streamId, events) {
        const order = new Order(streamId);
        events.forEach(event => order.apply(event, false));
        order.version = events.length;
        return order;
    }
    
    addItem(productId, quantity, price) {
        if (this.status !== 'pending') {
            throw new Error('Cannot modify confirmed order');
        }
        
        this.raise(new OrderItemAdded(this.streamId, productId, quantity, price));
    }
    
    confirm() {
        if (this.items.length === 0) {
            throw new Error('Cannot confirm empty order');
        }
        this.raise(new OrderConfirmed(this.streamId));
    }
    
    raise(event) {
        this.apply(event, true);
        this.uncommittedEvents.push(event);
    }
    
    apply(event, isNew) {
        switch (event.constructor.name) {
            case 'OrderItemAdded':
                this.items.push({
                    productId: event.productId,
                    quantity: event.quantity,
                    price: event.price
                });
                this.total += event.quantity * event.price;
                break;
            case 'OrderConfirmed':
                this.status = 'confirmed';
                break;
            case 'OrderCancelled':
                this.status = 'cancelled';
                break;
        }
    }
    
    getUncommittedEvents() {
        return this.uncommittedEvents;
    }
    
    markEventsAsCommitted() {
        this.uncommittedEvents = [];
    }
}
```

Two paths to state change:
- **New commands:** `raise()` → `apply()` → add to uncommitted events
- **Replay from history:** `apply()` only (reconstructing past state)

Same `apply()` logic for both. This symmetry is critical—replay must produce identical state to live processing.

## Event Definitions

```javascript
class DomainEvent {
    constructor(streamId, metadata = {}) {
        this.streamId = streamId;
        this.occurredAt = new Date();
        this.metadata = metadata;  // userId, correlationId, etc.
    }
}

class OrderItemAdded extends DomainEvent {
    constructor(streamId, productId, quantity, price) {
        super(streamId);
        this.productId = productId;
        this.quantity = quantity;
        this.price = price;
    }
}

class OrderConfirmed extends DomainEvent {
    constructor(streamId) {
        super(streamId);
    }
}
```

Events are past tense (OrderConfirmed, not ConfirmOrder). They describe what happened, not what should happen.

## Repository: Load by Replay, Save by Append

```javascript
class OrderRepository {
    constructor(eventStore, snapshotStore) {
        this.eventStore = eventStore;
        this.snapshotStore = snapshotStore;
    }
    
    async findById(streamId) {
        const snapshot = await this.snapshotStore.getLatest(streamId);
        
        let fromVersion = 0;
        let order;
        
        if (snapshot) {
            order = Order.fromSnapshot(snapshot.data);
            fromVersion = snapshot.version;
        } else {
            order = new Order(streamId);
        }
        
        const events = await this.eventStore.getEvents(streamId, fromVersion);
        if (events.length === 0 && !snapshot) return null;
        
        events.forEach(e => order.apply(e, false));
        order.version = fromVersion + events.length;
        order.markEventsAsCommitted();
        
        return order;
    }
    
    async save(order) {
        const events = order.getUncommittedEvents();
        if (events.length === 0) return;
        
        const newVersion = await this.eventStore.appendEvents(
            order.streamId,
            events,
            order.version
        );
        
        order.version = newVersion;
        order.markEventsAsCommitted();
        
        // Snapshot every 100 events
        if (newVersion % 100 === 0) {
            await this.snapshotStore.save(order.streamId, order, newVersion);
        }
        
        // Publish events for projections
        for (const event of events) {
            await this.eventBus.publish(event);
        }
    }
}
```

## Projections: Read Models from Events

Write model (event-sourced aggregate) optimized for business rules. Read models optimized for queries—built by projections:

```javascript
class OrderListProjection {
    constructor(db) {
        this.db = db;
    }
    
    async handle(event) {
        switch (event.constructor.name) {
            case 'OrderItemAdded':
                await this.db.orders.updateOne(
                    { streamId: event.streamId },
                    {
                        $push: { items: {
                            productId: event.productId,
                            quantity: event.quantity,
                            price: event.price
                        }},
                        $inc: { total: event.quantity * event.price },
                        $set: { status: 'pending', updatedAt: event.occurredAt }
                    },
                    { upsert: true }
                );
                break;
                
            case 'OrderConfirmed':
                await this.db.orders.updateOne(
                    { streamId: event.streamId },
                    { $set: { status: 'confirmed', confirmedAt: event.occurredAt }}
                );
                break;
        }
    }
}
```

Projections must be **idempotent**—processing the same event twice produces the same result. At-least-once delivery means duplicates happen.

**Rebuild projections:** Drop the read model, replay all events from the event store. This is event sourcing's superpower—new read models from historical data.

## CQRS: Separate Read and Write

```javascript
// Command side
class OrderCommandHandler {
    constructor(repository) {
        this.repository = repository;
    }
    
    async handle(command) {
        const order = await this.repository.findById(command.orderId)
                     || new Order(command.orderId);
        
        if (command.type === 'AddItem') {
            order.addItem(command.productId, command.quantity, command.price);
        } else if (command.type === 'Confirm') {
            order.confirm();
        }
        
        await this.repository.save(order);
    }
}

// Query side — reads from projection, NOT event store
class OrderQueryHandler {
    constructor(readDb) {
        this.readDb = readDb;
    }
    
    async getOrderList(filters) {
        return this.readDb.orders.find(filters).toArray();
    }
    
    async getOrderSummary(orderId) {
        return this.readDb.orders.findOne({ streamId: orderId });
    }
}
```

Queries never touch the event store. They read projections. This separation lets you optimize read and write independently.

## Snapshots: Performance Optimization

Replaying 10,000 events to load one order is slow. Snapshots save aggregate state periodically:

```javascript
class SnapshotStore {
    async save(streamId, aggregate, version) {
        await this.db.snapshots.insertOne({
            streamId,
            version,
            data: aggregate.toSnapshot(),
            createdAt: new Date()
        });
    }
    
    async getLatest(streamId) {
        return this.db.snapshots
            .findOne({ streamId }, { sort: { version: -1 } });
    }
}
```

Load snapshot at version 9000, replay events 9001-10000. Much faster.

## When Event Sourcing Is Worth It

**Good fit:**
- Audit requirements (finance, healthcare, legal)
- Complex domains with rich history needs
- Multiple read models from same data
- Temporal queries ("state at time T")
- Event-driven architecture already in place

**Skip it when:**
- Simple CRUD with no audit needs
- Team unfamiliar with the pattern (learning curve is real)
- Strong consistency requirements on reads (projections are eventually consistent)
- Storage costs are a primary concern (events accumulate forever)

## Production Lessons

1. **Version your event schemas** — `OrderItemAddedV2` or upcasting on read
2. **Store metadata** — userId, correlationId, causationId on every event
3. **Monitor projection lag** — how far behind are read models?
4. **Test replay** — aggregate state from events must match snapshot state
5. **Plan event retention** — archive old events, don't delete
6. **Idempotent projections** — handle duplicate event delivery
7. **Don't event-source everything** — hybrid architectures are fine

## Conclusion

Event sourcing trades simplicity for capabilities: complete history, temporal queries, flexible projections, and natural fit with event-driven systems. The current state in your database is a cache of the event stream's latest projection.

"What did this order look like last Tuesday at 3 PM?" became a one-line replay. Compliance audits went from weeks to hours. New reporting requirements became new projections over existing events, not schema migrations on production tables.

Start with one aggregate. Implement the event store. Build one projection. Add snapshots when replay gets slow. Don't event-source your entire domain on day one—that's how projects die.

Events are the truth. Everything else is a view. That's a mindset shift, but once it clicks, you see problems differently—and solve them more elegantly.

---

*Event sourcing patterns from April 2021, covering event store, aggregates, projections, and snapshots.*

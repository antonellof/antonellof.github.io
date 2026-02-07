---
layout: post
title: "Event Sourcing: Implementation Patterns"
date: 2021-04-15
categories: [Architecture]
tags: [Event Sourcing, CQRS, Architecture]
excerpt: "Implement event sourcing patterns: event store, aggregates, projections, snapshots, and how to build event-sourced systems with CQRS."
---

Event sourcing stores state changes as events. After implementing event-sourced systems, here's how to use the patterns effectively.

## What is Event Sourcing?

Event sourcing:
- **Stores events** - Not current state
- **Replay events** - Reconstruct state
- **Audit trail** - Complete history
- **Time travel** - Query past state

## Event Store

### Basic Event Store

```javascript
class EventStore {
    constructor(db) {
        this.db = db;
    }
    
    async appendEvents(streamId, events, expectedVersion) {
        const stream = await this.getStream(streamId);
        
        if (stream.version !== expectedVersion) {
            throw new Error('Concurrency conflict');
        }
        
        const eventsToSave = events.map((event, index) => ({
            streamId,
            version: expectedVersion + index + 1,
            eventType: event.constructor.name,
            eventData: JSON.stringify(event),
            timestamp: new Date()
        }));
        
        await this.db.events.insertMany(eventsToSave);
        
        return expectedVersion + events.length;
    }
    
    async getEvents(streamId, fromVersion = 0) {
        const events = await this.db.events.find({
            streamId,
            version: { $gt: fromVersion }
        }).sort({ version: 1 });
        
        return events.map(e => this.deserializeEvent(e));
    }
    
    async getStream(streamId) {
        const events = await this.getEvents(streamId);
        return {
            streamId,
            version: events.length,
            events
        };
    }
    
    deserializeEvent(eventRecord) {
        const EventClass = require(`./events/${eventRecord.eventType}`);
        return Object.assign(
            Object.create(EventClass.prototype),
            JSON.parse(eventRecord.eventData)
        );
    }
}
```

## Aggregate Pattern

### Event-Sourced Aggregate

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
        events.forEach(event => order.apply(event));
        order.version = events.length;
        return order;
    }
    
    addItem(productId, quantity, price) {
        if (this.status !== 'pending') {
            throw new Error('Cannot modify completed order');
        }
        
        const event = new OrderItemAdded(
            this.streamId,
            productId,
            quantity,
            price
        );
        
        this.apply(event);
        this.uncommittedEvents.push(event);
    }
    
    confirm() {
        if (this.items.length === 0) {
            throw new Error('Cannot confirm empty order');
        }
        
        const event = new OrderConfirmed(this.streamId);
        this.apply(event);
        this.uncommittedEvents.push(event);
    }
    
    apply(event) {
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
        }
    }
    
    getUncommittedEvents() {
        return this.uncommittedEvents;
    }
    
    markEventsAsCommitted() {
        this.uncommittedEvents = [];
        this.version += this.uncommittedEvents.length;
    }
}
```

## Events

### Event Definitions

```javascript
class DomainEvent {
    constructor(streamId, occurredAt = new Date()) {
        this.streamId = streamId;
        this.occurredAt = occurredAt;
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

## Repository Pattern

### Event-Sourced Repository

```javascript
class OrderRepository {
    constructor(eventStore) {
        this.eventStore = eventStore;
    }
    
    async findById(streamId) {
        const stream = await this.eventStore.getStream(streamId);
        if (stream.events.length === 0) {
            return null;
        }
        return Order.fromHistory(streamId, stream.events);
    }
    
    async save(order) {
        const events = order.getUncommittedEvents();
        if (events.length === 0) {
            return;
        }
        
        const newVersion = await this.eventStore.appendEvents(
            order.streamId,
            events,
            order.version
        );
        
        order.markEventsAsCommitted();
        order.version = newVersion;
    }
}
```

## Projections

### Read Model Projection

```javascript
class OrderProjection {
    constructor(db) {
        this.db = db;
    }
    
    async handle(event) {
        switch (event.constructor.name) {
            case 'OrderItemAdded':
                await this.handleOrderItemAdded(event);
                break;
            case 'OrderConfirmed':
                await this.handleOrderConfirmed(event);
                break;
        }
    }
    
    async handleOrderItemAdded(event) {
        await this.db.orders.updateOne(
            { streamId: event.streamId },
            {
                $push: { items: {
                    productId: event.productId,
                    quantity: event.quantity,
                    price: event.price
                }},
                $inc: { total: event.quantity * event.price }
            },
            { upsert: true }
        );
    }
    
    async handleOrderConfirmed(event) {
        await this.db.orders.updateOne(
            { streamId: event.streamId },
            { $set: { status: 'confirmed' } }
        );
    }
}
```

## Snapshots

### Snapshot Pattern

```javascript
class SnapshotStore {
    constructor(db) {
        this.db = db;
    }
    
    async saveSnapshot(streamId, aggregate, version) {
        await this.db.snapshots.insertOne({
            streamId,
            version,
            data: aggregate.serialize(),
            timestamp: new Date()
        });
    }
    
    async getSnapshot(streamId) {
        return await this.db.snapshots.findOne(
            { streamId },
            { sort: { version: -1 } }
        );
    }
}

class OrderRepository {
    constructor(eventStore, snapshotStore) {
        this.eventStore = eventStore;
        this.snapshotStore = snapshotStore;
    }
    
    async findById(streamId) {
        const snapshot = await this.snapshotStore.getSnapshot(streamId);
        
        let fromVersion = 0;
        let order;
        
        if (snapshot) {
            order = Order.deserialize(snapshot.data);
            fromVersion = snapshot.version;
        } else {
            order = new Order(streamId);
        }
        
        const events = await this.eventStore.getEvents(streamId, fromVersion);
        events.forEach(event => order.apply(event));
        
        return order;
    }
}
```

## CQRS Integration

### Command Side

```javascript
class OrderCommandHandler {
    constructor(repository) {
        this.repository = repository;
    }
    
    async handle(command) {
        const order = await this.repository.findById(command.orderId) || 
                     new Order(command.orderId);
        
        if (command instanceof AddItemCommand) {
            order.addItem(command.productId, command.quantity, command.price);
        } else if (command instanceof ConfirmOrderCommand) {
            order.confirm();
        }
        
        await this.repository.save(order);
    }
}
```

### Query Side

```javascript
class OrderQueryHandler {
    constructor(readModel) {
        this.readModel = readModel;
    }
    
    async getOrder(orderId) {
        return await this.readModel.orders.findOne({ streamId: orderId });
    }
    
    async getOrdersByStatus(status) {
        return await this.readModel.orders.find({ status }).toArray();
    }
}
```

## Best Practices

1. **Immutable events** - Don't modify events
2. **Version events** - Handle schema changes
3. **Use snapshots** - For performance
4. **Idempotent projections** - Safe replay
5. **Event versioning** - Handle migrations
6. **Test replay** - Verify correctness
7. **Monitor projections** - Track lag
8. **Document events** - Clear schema

## Conclusion

Event sourcing enables:
- Complete audit trail
- Time travel queries
- Flexible projections
- Scalable systems

Start with simple events, then add projections and snapshots. The patterns shown here handle production workloads.

---

*Event sourcing patterns from April 2021, covering event store, aggregates, projections, and snapshots.*

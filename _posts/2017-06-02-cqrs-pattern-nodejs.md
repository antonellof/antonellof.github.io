---
layout: post
title: "CQRS Pattern in Node.js: Separating Reads and Writes"
date: 2017-06-02
categories: [Architecture]
tags: [CQRS, Node.js, Architecture, Design Patterns]
excerpt: "Our read endpoints were drowning while writes barely ticked. CQRS sounded like enterprise architecture cosplay—until we separated read and write models and everything got faster."
---

# CQRS Pattern in Node.js: Separating Reads and Writes

The dashboard loaded in four seconds. Creating a new record took 80 milliseconds.

Read that again. Our *reads* were slow. Our *writes* were fast. Every instinct from traditional CRUD development said this was backwards—you optimize writes, reads are easy.

Except we had a social analytics product where users refreshed dashboards constantly (reads) but created campaigns occasionally (writes). The read load was 50:1. Our single PostgreSQL schema—normalized, indexed, perfectly sensible—was getting hammered by complex JOIN queries that writes never triggered.

CQRS—Command Query Responsibility Segregation—sounded like something a consultant would charge $40,000 to explain. Then I implemented it in a Node.js service and our dashboard load time dropped to 400ms.

Not magic. Just acknowledging that reads and writes have different needs, and pretending otherwise was costing us money.

## What CQRS Actually Means

The name is the definition:

- **Commands** change state (create user, place order, update profile)
- **Queries** return data (get user, list orders, fetch dashboard)

In traditional architecture, one model serves both:

```
Traditional:
┌─────────────┐
│   Service   │─── Reads & Writes
└─────────────┘
```

In CQRS, you split them:

```
CQRS:
┌─────────────┐     ┌─────────────┐
│  Command    │     │   Query     │
│  Handler    │     │   Handler   │
└─────────────┘     └─────────────┘
```

"Segregation" is the important word. Not duplication for its own sake—*optimization* for different access patterns.

## Why Bother?

The benefits we actually got:

- **Independent scaling** — Scale read replicas without touching write infrastructure
- **Optimized models** — Write model stays normalized; read model gets denormalized for speed
- **Performance** — Dashboard queries hit pre-computed data instead of JOINing six tables
- **Complexity management** — Business rules live in command handlers, not scattered across controllers

The costs we accepted:

- **Eventual consistency** — Read model might be seconds behind writes
- **More moving parts** — Projections, event handlers, sync monitoring
- **Cognitive overhead** — "Which model do I use?" becomes a real question

CQRS isn't free. It's a trade. We took it because our read bottleneck was killing user experience.

## Basic Implementation

### Command Side (Writes)

Commands are intentions, not data bags. They carry validation and business logic:

```javascript
// commands/createUser.js
class CreateUserCommand {
    constructor(userData) {
        this.name = userData.name;
        this.email = userData.email;
        this.password = userData.password;
    }
}

// commandHandlers/createUserHandler.js
class CreateUserHandler {
    constructor(userRepository, eventBus) {
        this.userRepository = userRepository;
        this.eventBus = eventBus;
    }
    
    async handle(command) {
        // Validate command
        this.validate(command);
        
        // Create user (write model)
        const user = await this.userRepository.create({
            name: command.name,
            email: command.email,
            password: await this.hashPassword(command.password)
        });
        
        // Publish event
        await this.eventBus.publish('UserCreated', {
            userId: user.id,
            email: user.email
        });
        
        return { userId: user.id };
    }
    
    validate(command) {
        if (!command.email) {
            throw new Error('Email is required');
        }
        // More validation...
    }
}
```

The command handler owns validation, business rules, and persistence. It publishes events so the read side can catch up. It does *not* return a fully hydrated user profile with denormalized stats—that's the query side's job.

### Query Side (Reads)

Queries are read-only. No side effects. No events. Just data retrieval optimized for the question being asked:

```javascript
// queries/getUserById.js
class GetUserByIdQuery {
    constructor(userId) {
        this.userId = userId;
    }
}

// queryHandlers/getUserByIdHandler.js
class GetUserByIdHandler {
    constructor(userReadRepository) {
        this.userReadRepository = userReadRepository;
    }
    
    async handle(query) {
        // Read from optimized read model
        const user = await this.userReadRepository.findById(query.userId);
        
        if (!user) {
            throw new Error('User not found');
        }
        
        return {
            id: user.id,
            name: user.name,
            email: user.email,
            profile: user.profile // Denormalized data
        };
    }
}
```

The read model includes `profile` data that might come from three tables in the write model—pre-joined, pre-computed, ready to serve.

## Event Sourcing: CQRS's Optional Gym Membership

CQRS pairs naturally with Event Sourcing—storing state changes as events rather than overwriting rows. You don't *need* event sourcing for CQRS, but they complement each other:

```javascript
// events/userCreated.js
class UserCreatedEvent {
    constructor(userId, email, name) {
        this.userId = userId;
        this.email = email;
        this.name = name;
        this.timestamp = new Date();
    }
}

// eventStore.js
class EventStore {
    constructor(db) {
        this.db = db;
    }
    
    async append(streamId, event) {
        await this.db.events.insert({
            streamId,
            eventType: event.constructor.name,
            eventData: JSON.stringify(event),
            timestamp: new Date()
        });
    }
    
    async getEvents(streamId) {
        const events = await this.db.events
            .find({ streamId })
            .sort({ timestamp: 1 });
        
        return events.map(e => this.deserialize(e));
    }
}

// Command handler with event sourcing
class CreateUserHandler {
    constructor(eventStore, readModelUpdater) {
        this.eventStore = eventStore;
        this.readModelUpdater = readModelUpdater;
    }
    
    async handle(command) {
        const userId = generateId();
        const event = new UserCreatedEvent(
            userId,
            command.email,
            command.name
        );
        
        // Store event
        await this.eventStore.append(`user-${userId}`, event);
        
        // Update read model
        await this.readModelUpdater.handle(event);
        
        return { userId };
    }
}
```

Events are the source of truth. Current state is derived by replaying events (or by projections that maintain read models incrementally).

We used event sourcing for audit-sensitive operations—order history, campaign changes. Simple CRUD entities used CQRS without full event sourcing. You don't need the full stack on day one.

## Read Model Projections

Projections listen for events and update read models:

```javascript
// projections/userProjection.js
class UserProjection {
    constructor(readDb) {
        this.readDb = readDb;
    }
    
    async handle(event) {
        switch (event.eventType) {
            case 'UserCreated':
                await this.onUserCreated(event);
                break;
            case 'UserUpdated':
                await this.onUserUpdated(event);
                break;
            case 'UserDeleted':
                await this.onUserDeleted(event);
                break;
        }
    }
    
    async onUserCreated(event) {
        await this.readDb.users.insert({
            id: event.userId,
            email: event.email,
            name: event.name,
            createdAt: event.timestamp
        });
    }
    
    async onUserUpdated(event) {
        await this.readDb.users.update(
            { id: event.userId },
            { $set: { name: event.name } }
        );
    }
    
    async onUserDeleted(event) {
        await this.readDb.users.delete({ id: event.userId });
    }
}
```

Projections must be idempotent. Events can be delivered more than once. Design handlers that can safely replay.

Monitor projection lag. If your read model is five minutes behind, users notice—even if your architecture diagram is beautiful.

## The Mediator: Routing Commands and Queries

A mediator keeps your Express routes from becoming a switch statement the length of a novel:

```javascript
// mediator.js
class Mediator {
    constructor() {
        this.commandHandlers = new Map();
        this.queryHandlers = new Map();
    }
    
    registerCommand(commandType, handler) {
        this.commandHandlers.set(commandType.name, handler);
    }
    
    registerQuery(queryType, handler) {
        this.queryHandlers.set(queryType.name, handler);
    }
    
    async send(commandOrQuery) {
        const type = commandOrQuery.constructor.name;
        
        if (this.commandHandlers.has(type)) {
            const handler = this.commandHandlers.get(type);
            return await handler.handle(commandOrQuery);
        }
        
        if (this.queryHandlers.has(type)) {
            const handler = this.queryHandlers.get(type);
            return await handler.handle(commandOrQuery);
        }
        
        throw new Error(`No handler for ${type}`);
    }
}

// Usage
const mediator = new Mediator();

mediator.registerCommand(CreateUserCommand, createUserHandler);
mediator.registerQuery(GetUserByIdQuery, getUserByIdHandler);

// Send command
const result = await mediator.send(
    new CreateUserCommand({ name: 'John', email: 'john@example.com' })
);

// Send query
const user = await mediator.send(
    new GetUserByIdQuery(userId)
);
```

POST routes send commands. GET routes send queries. The route doesn't know about databases—it knows about intentions.

## Express Integration

```javascript
// routes/users.js
const express = require('express');
const router = express.Router();

// Command endpoint
router.post('/users', async (req, res, next) => {
    try {
        const command = new CreateUserCommand(req.body);
        const result = await mediator.send(command);
        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

// Query endpoint
router.get('/users/:id', async (req, res, next) => {
    try {
        const query = new GetUserByIdQuery(req.params.id);
        const user = await mediator.send(query);
        res.json(user);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
```

Clean separation at the HTTP layer too. POST mutates. GET reads. If you're tempted to add a side effect to a GET handler, that's your architecture trying to warn you.

## Denormalized Read Models: Where the Speed Lives

The write model stays normalized—data integrity, foreign keys, the comfortable world you know:

```javascript
// Write model (normalized)
{
    id: '123',
    name: 'John',
    email: 'john@example.com'
}
```

The read model gets fat with pre-computed data:

```javascript
// Read model (denormalized)
{
    id: '123',
    name: 'John',
    email: 'john@example.com',
    orderCount: 15,           // Denormalized
    totalSpent: 1250.50,      // Denormalized
    lastOrderDate: '2017-06-01' // Denormalized
}

// Projection updates read model
class UserStatsProjection {
    async onOrderCreated(event) {
        await this.readDb.users.update(
            { id: event.userId },
            {
                $inc: { orderCount: 1 },
                $inc: { totalSpent: event.amount },
                $set: { lastOrderDate: event.timestamp }
            }
        );
    }
}
```

That dashboard that took four seconds? It was JOINing users, orders, and analytics tables on every request. The denormalized read model answered the same question with a single document lookup.

Yes, `orderCount` might be stale for a few hundred milliseconds. For a dashboard, that's fine. For a bank balance, it wouldn't be. Know your consistency requirements.

## CQRS With MongoDB

MongoDB's document model makes CQRS feel natural—separate collections for write and read models:

```javascript
// Write model (MongoDB)
class UserWriteRepository {
    constructor(db) {
        this.collection = db.collection('users_write');
    }
    
    async create(userData) {
        const result = await this.collection.insertOne(userData);
        return result.insertedId;
    }
    
    async update(userId, updates) {
        await this.collection.updateOne(
            { _id: userId },
            { $set: updates }
        );
    }
}

// Read model (MongoDB with indexes)
class UserReadRepository {
    constructor(db) {
        this.collection = db.collection('users_read');
        // Create indexes for common queries
        this.collection.createIndex({ email: 1 });
        this.collection.createIndex({ 'profile.city': 1 });
    }
    
    async findById(userId) {
        return await this.collection.findOne({ _id: userId });
    }
    
    async findByEmail(email) {
        return await this.collection.findOne({ email });
    }
    
    async findByCity(city) {
        return await this.collection.find({ 'profile.city': city }).toArray();
    }
}
```

Index the read model for the queries you actually run. The write model indexes for integrity and write performance. Different access patterns, different indexes.

## When CQRS Is Worth It (And When It's Not)

**Good fit:**
- High read-to-write ratio (dashboards, analytics, social feeds)
- Complex business logic on writes that shouldn't slow reads
- Need to scale reads independently
- Different data shapes for commands vs queries

**Bad fit:**
- Simple CRUD with balanced read/write
- Low traffic where a single Postgres instance is fine
- Strong consistency requirements everywhere (banking transfers, inventory counts)
- Small team that can't maintain projections and monitoring

The honest test: **is read performance actually your bottleneck?** If not, CQRS adds complexity without benefit. Profile first. Architect second.

## Lessons From Production

**Start simple.** We began with CQRS on one aggregate (users)—not the entire domain. One command handler, one query handler, one projection. Prove the model before spreading it.

**Use events to decouple.** Synchronous read model updates work for low traffic. Events scale better and survive failures more gracefully.

**Embrace eventual consistency.** Tell users the dashboard might lag by a second. Design UI that doesn't pretend otherwise. Fighting eventual consistency with synchronous updates defeats the purpose.

**Monitor projections.** Alert on lag. Build rebuild scripts. Projections *will* break; plan for recovery.

**Version events.** `UserCreatedV1` and `UserCreatedV2` can coexist. Your event schema will change. Plan for it before you're deserializing JSON with missing fields at 2 AM.

## The Bottom Line

CQRS isn't academic architecture. It's a practical response to a specific problem: reads and writes have different performance profiles, and pretending they don't forces compromises that hurt users.

What we gained:

- Independent scaling of reads and writes
- Dashboard queries that went from seconds to milliseconds
- Clear separation—business logic in commands, presentation data in queries
- A path to event sourcing where audit trails mattered

What we paid:

- Eventual consistency (managed, not ignored)
- Projection maintenance (monitored, rebuildable)
- Team education (ongoing, worth it)

Start with one aggregate. Add event sourcing only where you need history. Don't CQRS your entire app because a conference talk made it sound cool.

Our read-heavy analytics workload was the perfect fit. Your mileage will vary. Profile your actual bottleneck before you segregate anything.

---

*CQRS patterns in Node.js from June 2017—Express 4.x, MongoDB 3.x, hand-rolled event bus. Reflects production implementations before mature CQRS libraries (like NestJS CQRS module) were widely adopted.*

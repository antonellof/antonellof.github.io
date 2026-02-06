---
layout: post
title: "CQRS Pattern in Node.js: Separating Reads and Writes"
date: 2017-06-15
categories: [Architecture]
tags: [CQRS, Node.js, Architecture, Design Patterns]
excerpt: "Implementing Command Query Responsibility Segregation (CQRS) in Node.js applications, separating read and write models for better scalability and performance."
---

CQRS (Command Query Responsibility Segregation) separates read and write operations into different models. After implementing CQRS in a high-traffic Node.js application, I learned it's not just an academic pattern—it solves real scalability problems.

## What is CQRS?

CQRS separates:
- **Commands**: Write operations that change state
- **Queries**: Read operations that return data

```
Traditional:
┌─────────────┐
│   Service   │─── Reads & Writes
└─────────────┘

CQRS:
┌─────────────┐     ┌─────────────┐
│  Command    │     │   Query     │
│  Handler    │     │   Handler   │
└─────────────┘     └─────────────┘
```

## Why CQRS?

Benefits:
- **Independent scaling**: Scale reads and writes separately
- **Optimized models**: Different data structures for reads vs writes
- **Performance**: Read models can be denormalized
- **Complexity**: Handle complex business logic in commands

## Basic Implementation

### Command Side

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

### Query Side

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

## Event Sourcing Integration

CQRS often pairs with Event Sourcing:

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

## Read Model Projections

Build read models from events:

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

## Mediator Pattern

Use a mediator to route commands and queries:

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

## Express.js Integration

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

## Denormalized Read Models

Optimize reads with denormalized data:

```javascript
// Write model (normalized)
{
    id: '123',
    name: 'John',
    email: 'john@example.com'
}

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

## CQRS with MongoDB

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

## When to Use CQRS

**Good fit:**
- High read/write ratio
- Complex business logic
- Need to scale reads independently
- Different data models for reads vs writes

**Not a good fit:**
- Simple CRUD applications
- Low traffic applications
- Tight consistency requirements
- Small team/simple domain

## Best Practices

1. **Start simple** - Don't over-engineer
2. **Use events** - Decouple command and query sides
3. **Handle eventual consistency** - Reads may be slightly stale
4. **Monitor projections** - Ensure read models stay in sync
5. **Version events** - Handle schema changes over time

## Conclusion

CQRS provides:
- Independent scaling of reads and writes
- Optimized data models
- Better performance for read-heavy workloads
- Clear separation of concerns

Start with simple CQRS, add event sourcing if needed. The pattern shown here handles millions of operations in production.

---

*CQRS patterns in Node.js from June 2017, reflecting production implementations.*

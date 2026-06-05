---
layout: post
title: "Hexagonal Architecture (Ports and Adapters)"
date: 2022-08-22
categories: [Architecture]
tags: [Hexagonal Architecture, Ports and Adapters, Clean Architecture]
excerpt: "We swapped PostgreSQL for MongoDB, REST for GraphQL, and AWS SQS for RabbitMQ—all without touching the business logic. That's not luck. That's hexagonal architecture done right."
---

The database migration email landed with the subject line every backend developer dreads: "Leadership approved MongoDB for the order service."

We'd built the order service on PostgreSQL. Every query was SQL. Every repository method assumed relational data. The "simple" database swap the architects proposed would touch every layer of the application—controllers, services, repositories, tests, the whole stack.

Except it didn't. Because we'd accidentally—then intentionally—structured the codebase using [hexagonal architecture](https://alistair.cockburn.us/hexagonal-architecture/), also called Ports and Adapters. The business logic lived in the center, isolated from infrastructure. The database was behind an interface. Swap the adapter, keep the domain.

We migrated from PostgreSQL to MongoDB in two weeks instead of two months. Not because MongoDB is magic—because we'd drawn the right boundaries.

## The Problem Hexagonal Architecture Solves

Most applications start clean and accumulate dependencies like barnacles:

```typescript
// The barnacle pattern (don't do this)
class OrderService {
    async createOrder(req: Request, res: Response) {
        const data = req.body;
        
        // Business logic mixed with HTTP
        if (!data.items?.length) {
            return res.status(400).json({ error: 'No items' });
        }
        
        // Business logic mixed with SQL
        const result = await db.query(
            'INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING *',
            [data.userId, data.total]
        );
        
        // Business logic mixed with messaging
        await sqs.sendMessage({
            QueueUrl: process.env.ORDER_QUEUE,
            MessageBody: JSON.stringify(result.rows[0]),
        });
        
        res.json(result.rows[0]);
    }
}
```

This works until it doesn't. Change the database? Touch the service. Switch from REST to gRPC? Touch the service. Add a new notification channel? Touch the service. Every infrastructure change becomes a business logic change.

Hexagonal architecture inverts the dependency direction. **Infrastructure depends on business logic, not the other way around.**

## The Hexagon (It's Not Actually a Hexagon)

Alistair Cockburn's original diagram used a hexagon because it has six sides—you could have six different adapters. The shape doesn't matter. The idea does:

```
        ┌─────────────────────────────────┐
        │         DRIVING ADAPTERS        │
        │   (HTTP, CLI, Message Consumer) │
        └───────────────┬─────────────────┘
                        │
        ┌───────────────▼─────────────────┐
        │         DRIVING PORTS           │
        │    (Use Case Interfaces)        │
        └───────────────┬─────────────────┘
                        │
        ┌───────────────▼─────────────────┐
        │                                 │
        │          DOMAIN CORE            │
        │     (Business Logic, Entities)  │
        │                                 │
        └───────────────┬─────────────────┘
                        │
        ┌───────────────▼─────────────────┐
        │         DRIVEN PORTS            │
        │   (Repository Interfaces)       │
        └───────────────┬─────────────────┘
                        │
        ┌───────────────▼─────────────────┐
        │         DRIVEN ADAPTERS         │
        │  (Database, External APIs, MQ)  │
        └─────────────────────────────────┘
```

**Driving side (left):** Things that trigger your application—HTTP requests, CLI commands, message queue consumers, scheduled jobs.

**Driven side (right):** Things your application uses—databases, external APIs, message queues, file systems.

**Ports:** Interfaces that define how the outside world talks to your domain (driving ports) or how your domain talks to the outside world (driven ports).

**Adapters:** Concrete implementations that connect ports to real technology.

## Building the Domain Core

The center of the hexagon contains pure business logic—no HTTP, no SQL, no framework imports:

```typescript
// domain/entities/Order.ts
export class Order {
    constructor(
        public readonly id: string,
        public readonly userId: string,
        public items: OrderItem[],
        public status: OrderStatus = 'pending',
        public readonly createdAt: Date = new Date(),
    ) {
        this.validate();
    }
    
    private validate(): void {
        if (!this.items.length) {
            throw new DomainError('Order must have at least one item');
        }
        if (this.items.some(item => item.quantity <= 0)) {
            throw new DomainError('Item quantity must be positive');
        }
    }
    
    calculateTotal(): number {
        return this.items.reduce(
            (sum, item) => sum + (item.price * item.quantity),
            0
        );
    }
    
    confirm(): void {
        if (this.status !== 'pending') {
            throw new DomainError(`Cannot confirm order in ${this.status} status`);
        }
        this.status = 'confirmed';
    }
    
    cancel(): void {
        if (this.status === 'shipped') {
            throw new DomainError('Cannot cancel shipped order');
        }
        this.status = 'cancelled';
    }
}

// domain/entities/OrderItem.ts
export interface OrderItem {
    productId: string;
    name: string;
    price: number;
    quantity: number;
}
```

Notice what's missing: no database imports, no HTTP types, no framework dependencies. This is plain TypeScript (or plain Java, Python, Go—language doesn't matter). You can unit test every business rule without mocking infrastructure.

## Defining Ports (Interfaces)

Ports are the contracts between domain and infrastructure:

```typescript
// domain/ports/driven/OrderRepository.ts (DRIVEN PORT)
export interface OrderRepository {
    save(order: Order): Promise<void>;
    findById(id: string): Promise<Order | null>;
    findByUserId(userId: string): Promise<Order[]>;
    updateStatus(id: string, status: OrderStatus): Promise<void>;
}

// domain/ports/driven/NotificationPort.ts (DRIVEN PORT)
export interface NotificationPort {
    sendOrderConfirmation(order: Order): Promise<void>;
    sendOrderCancellation(order: Order): Promise<void>;
}

// domain/ports/driving/CreateOrderUseCase.ts (DRIVING PORT)
export interface CreateOrderUseCase {
    execute(input: CreateOrderInput): Promise<Order>;
}

export interface CreateOrderInput {
    userId: string;
    items: OrderItem[];
}
```

**Driven ports** are interfaces your domain defines for things it needs. "I need to persist orders somehow. I don't care how."

**Driving ports** are interfaces for use cases your application exposes. "Create order" is a capability, independent of whether it's triggered by HTTP, CLI, or message queue.

## Implementing Use Cases

Use cases orchestrate domain logic using ports—they don't know about concrete implementations:

```typescript
// domain/usecases/CreateOrderUseCase.ts
export class CreateOrderService implements CreateOrderUseCase {
    constructor(
        private orderRepository: OrderRepository,
        private notificationPort: NotificationPort,
        private idGenerator: IdGenerator,
    ) {}
    
    async execute(input: CreateOrderInput): Promise<Order> {
        const order = new Order(
            this.idGenerator.generate(),
            input.userId,
            input.items,
        );
        
        await this.orderRepository.save(order);
        await this.notificationPort.sendOrderConfirmation(order);
        
        return order;
    }
}
```

This class depends on interfaces, not implementations. In tests, inject mocks. In production, inject real adapters. The use case code never changes.

## Building Adapters

Adapters connect ports to real technology:

### Driven Adapter: PostgreSQL Repository

```typescript
// adapters/driven/persistence/PostgreSQLOrderRepository.ts
export class PostgreSQLOrderRepository implements OrderRepository {
    constructor(private pool: Pool) {}
    
    async save(order: Order): Promise<void> {
        await this.pool.query(
            `INSERT INTO orders (id, user_id, items, status, created_at, total)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                order.id,
                order.userId,
                JSON.stringify(order.items),
                order.status,
                order.createdAt,
                order.calculateTotal(),
            ]
        );
    }
    
    async findById(id: string): Promise<Order | null> {
        const result = await this.pool.query(
            'SELECT * FROM orders WHERE id = $1',
            [id]
        );
        
        if (!result.rows.length) return null;
        return this.toDomain(result.rows[0]);
    }
    
    private toDomain(row: any): Order {
        return new Order(
            row.id,
            row.user_id,
            JSON.parse(row.items),
            row.status,
            row.created_at,
        );
    }
    
    // ... other methods
}
```

### Driven Adapter: MongoDB Repository (The Swap)

When leadership said MongoDB, we wrote a new adapter—same interface, different implementation:

```typescript
// adapters/driven/persistence/MongoOrderRepository.ts
export class MongoOrderRepository implements OrderRepository {
    constructor(private collection: Collection) {}
    
    async save(order: Order): Promise<void> {
        await this.collection.insertOne({
            _id: order.id,
            userId: order.userId,
            items: order.items,
            status: order.status,
            createdAt: order.createdAt,
            total: order.calculateTotal(),
        });
    }
    
    async findById(id: string): Promise<Order | null> {
        const doc = await this.collection.findOne({ _id: id });
        if (!doc) return null;
        return this.toDomain(doc);
    }
    
    private toDomain(doc: any): Order {
        return new Order(
            doc._id,
            doc.userId,
            doc.items,
            doc.status,
            doc.createdAt,
        );
    }
}
```

Zero changes to domain or use cases. Swap the adapter in dependency injection configuration. Done.

### Driving Adapter: HTTP Controller

```typescript
// adapters/driving/http/OrderController.ts
export class OrderController {
    constructor(private createOrder: CreateOrderUseCase) {}
    
    async create(req: Request, res: Response): Promise<void> {
        try {
            const order = await this.createOrder.execute({
                userId: req.user.id,
                items: req.body.items,
            });
            
            res.status(201).json(this.toResponse(order));
        } catch (error) {
            if (error instanceof DomainError) {
                res.status(400).json({ error: error.message });
                return;
            }
            throw error;
        }
    }
    
    private toResponse(order: Order) {
        return {
            id: order.id,
            userId: order.userId,
            items: order.items,
            status: order.status,
            total: order.calculateTotal(),
            createdAt: order.createdAt,
        };
    }
}
```

The controller translates HTTP to domain input and domain output to HTTP. It knows about both worlds but contains no business logic.

### Driving Adapter: Message Queue Consumer

Same use case, different entry point:

```typescript
// adapters/driving/messaging/OrderMessageHandler.ts
export class OrderMessageHandler {
    constructor(private createOrder: CreateOrderUseCase) {}
    
    async handle(message: OrderCreatedMessage): Promise<void> {
        await this.createOrder.execute({
            userId: message.userId,
            items: message.items,
        });
    }
}
```

HTTP request or SQS message—the business logic doesn't care.

## Wiring It Together

Dependency injection connects ports to adapters at the application boundary:

```typescript
// infrastructure/di/container.ts
export function createContainer(config: AppConfig) {
    // Driven adapters (infrastructure)
    const orderRepository = config.database === 'postgres'
        ? new PostgreSQLOrderRepository(config.dbPool)
        : new MongoOrderRepository(config.mongoCollection);
    
    const notificationPort = new EmailNotificationAdapter(config.emailService);
    
    // Use cases (domain)
    const createOrder = new CreateOrderService(
        orderRepository,
        notificationPort,
        new UuidGenerator(),
    );
    
    // Driving adapters (entry points)
    const orderController = new OrderController(createOrder);
    const orderMessageHandler = new OrderMessageHandler(createOrder);
    
    return { orderController, orderMessageHandler };
}
```

Change `config.database` from `'postgres'` to `'mongo'`. Everything else stays the same.

## Testing Becomes Trivial

The payoff for all this structure:

```typescript
// domain/usecases/CreateOrderService.test.ts
describe('CreateOrderService', () => {
    it('creates order and sends confirmation', async () => {
        const mockRepo: OrderRepository = {
            save: jest.fn(),
            findById: jest.fn(),
            findByUserId: jest.fn(),
            updateStatus: jest.fn(),
        };
        
        const mockNotification: NotificationPort = {
            sendOrderConfirmation: jest.fn(),
            sendOrderCancellation: jest.fn(),
        };
        
        const service = new CreateOrderService(
            mockRepo,
            mockNotification,
            { generate: () => 'order-123' },
        );
        
        const order = await service.execute({
            userId: 'user-456',
            items: [{ productId: 'p1', name: 'Widget', price: 10, quantity: 2 }],
        });
        
        expect(order.id).toBe('order-123');
        expect(order.calculateTotal()).toBe(20);
        expect(mockRepo.save).toHaveBeenCalledWith(order);
        expect(mockNotification.sendOrderConfirmation).toHaveBeenCalledWith(order);
    });
    
    it('rejects empty orders', async () => {
        const service = new CreateOrderService(
            mockRepo, mockNotification, idGenerator
        );
        
        await expect(service.execute({
            userId: 'user-456',
            items: [],
        })).rejects.toThrow('Order must have at least one item');
    });
});
```

No database. No HTTP server. No message queue. Pure business logic tests that run in milliseconds.

## When Hexagonal Architecture Is Overkill

I'm not going to pretend every project needs this. Skip it when:

**Simple CRUD apps.** If your app is mostly database operations with thin logic, the abstraction tax isn't worth it.

**Prototypes and MVPs.** Speed matters more than swap-ability. You can refactor later if the prototype survives.

**Small teams, small scope.** Three endpoints and one developer? Just write clean code with repository patterns and call it a day.

**You won't actually swap implementations.** Be honest—how often do you really change databases? If the answer is "never," you're paying for flexibility you won't use.

Use hexagonal architecture when:
- Business logic is complex and valuable
- You genuinely expect infrastructure changes
- Multiple entry points (HTTP + messaging + CLI) share logic
- Testability without infrastructure is a priority

## Common Mistakes

**Anemic domain models.** If your entities are just data bags and all logic lives in services, you've built layered architecture with extra steps—not hexagonal.

**Leaky ports.** If your repository interface returns database rows instead of domain entities, the abstraction is broken.

**Too many layers.** Hexagonal doesn't mean 47 interfaces. Start with repository and notification ports. Add more when you actually need them.

**Framework in the domain.** Importing Express types or ORM decorators in domain entities defeats the purpose.

## Conclusion

Hexagonal architecture isn't about drawing hexagons in architecture reviews. It's about **drawing boundaries that protect business logic from infrastructure churn**.

Our PostgreSQL-to-MongoDB migration succeeded because the domain didn't know PostgreSQL existed. The HTTP-to-gRPC experiment succeeded because use cases didn't know about REST. Tests run fast because business rules don't need a database to verify.

Start with the domain. Define ports for what you need. Implement adapters for what you have. Wire them at the edges. And when leadership sends that database migration email, you'll be ready.

**Further Resources:**
- [Hexagonal Architecture (Original)](https://alistair.cockburn.us/hexagonal-architecture/) — Alistair Cockburn's paper
- [Ports and Adapters Pattern](https://jmgarridopaz.github.io/content/hexagonalarchitecture.html) — Detailed explanation
- [Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) — Robert Martin's related model
- [Domain-Driven Design](https://www.domainlanguage.com/ddd/) — Eric Evans' foundational work

---

*Hexagonal architecture from August 2022, covering ports, adapters, and domain isolation.*

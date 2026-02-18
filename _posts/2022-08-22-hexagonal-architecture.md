---
layout: post
title: "Hexagonal Architecture (Ports and Adapters)"
date: 2022-08-22
categories: [Architecture]
tags: [Hexagonal Architecture, Ports and Adapters, Clean Architecture]
excerpt: "Implement hexagonal architecture: ports, adapters, domain isolation, and how to build testable, maintainable applications with clear boundaries."
---

Hexagonal architecture isolates business logic. After implementing it in production, here's how to structure applications effectively.

## What is Hexagonal Architecture?

Hexagonal architecture:
- **Ports** - Interfaces
- **Adapters** - Implementations
- **Domain** - Business logic
- **Isolation** - Technology-agnostic

## Structure

```
        ┌─────────────┐
        │   Adapters  │
        │  (Driving)  │
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │    Ports    │
        │  (Driving)  │
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │   Domain    │
        │   Logic     │
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │    Ports    │
        │  (Driven)   │
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │   Adapters  │
        │  (Driven)   │
        └─────────────┘
```

## Implementation

### Domain (Core)

```typescript
// Domain entity
class Order {
    constructor(
        public id: string,
        public items: OrderItem[],
        public total: number
    ) {}
    
    calculateTotal() {
        return this.items.reduce((sum, item) => sum + item.price, 0);
    }
}

// Port (interface)
interface OrderRepository {
    save(order: Order): Promise<void>;
    findById(id: string): Promise<Order | null>;
}
```

### Adapters

```typescript
// Driven adapter (database)
class PostgreSQLOrderRepository implements OrderRepository {
    async save(order: Order) {
        await db.orders.insert(order);
    }
    
    async findById(id: string) {
        return await db.orders.findOne({ id });
    }
}

// Driving adapter (HTTP)
class OrderController {
    constructor(private orderService: OrderService) {}
    
    async createOrder(req: Request, res: Response) {
        const order = await this.orderService.createOrder(req.body);
        res.json(order);
    }
}
```

## Best Practices

1. **Isolate domain** - No dependencies
2. **Define ports** - Clear interfaces
3. **Implement adapters** - Technology-specific
4. **Test domain** - Unit tests
5. **Mock adapters** - Integration tests
6. **Dependency injection** - Loose coupling
7. **Keep it simple** - Don't over-engineer
8. **Document ports** - Clear contracts

## Conclusion

Hexagonal architecture enables:
- Testable code
- Technology independence
- Clear boundaries
- Maintainable systems

Start with domain, then add ports and adapters. The architecture shown here isolates business logic effectively.

---

*Hexagonal architecture from August 2022, covering ports, adapters, and domain isolation.*

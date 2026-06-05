---
layout: post
title: "Domain-Driven Design: Tactical Patterns"
date: 2020-06-04
categories: [Architecture]
tags: [DDD, Domain-Driven Design, Patterns]
excerpt: "Strategic DDD draws the boundaries; tactical DDD writes the code inside them. Entities, value objects, aggregates, and repositories—the patterns that turn anemic data classes into domain models that actually enforce business rules."
---

After we drew bounded contexts and stopped three teams from fighting over one `Product` table, we had a new problem: the code *inside* each context was still anemic. `OrderService` did everything. `Order` was a bag of getters and setters. Business rules lived in random service methods, untested and duplicated.

Tactical DDD patterns fixed that. Not by adding complexity—forcing business logic into domain objects where it belongs. An `Order` that can't confirm itself when empty. A `Money` value object that refuses to add dollars to euros. An aggregate boundary that says "you can't modify order items without going through the Order root."

These patterns are the code-level companion to strategic DDD's context maps. Here's how I implement them in production JavaScript/TypeScript—and what mistakes to avoid.

## The Tactical Pattern Toolkit

| Pattern | Purpose | Key trait |
|---------|---------|-----------|
| Entity | Object with identity | Same ID = same thing, even if attributes change |
| Value Object | Object defined by attributes | Immutable, no identity, interchangeable |
| Aggregate | Consistency boundary | One root entity, external access only through root |
| Domain Service | Logic that doesn't fit one entity | Stateless operations across objects |
| Repository | Persistence abstraction | Collection-like interface for aggregates |
| Application Service | Use case orchestration | Transactions, coordinates domain objects |

The goal: **rich domain models** where business rules live in domain objects, not scattered across "manager" and "helper" classes.

## Entities: Identity Over Attributes

An entity has a unique identity that persists through attribute changes. Two `User` objects with the same ID are the same user, even if one has an updated email.

```javascript
class User {
    constructor(id, name, email) {
        if (!id) {
            throw new Error('User must have an ID');
        }
        this._id = id;
        this._name = name;
        this._email = email;
        this._createdAt = new Date();
    }
    
    get id() {
        return this._id;
    }
    
    updateName(newName) {
        if (!newName || newName.trim().length === 0) {
            throw new Error('Name cannot be empty');
        }
        this._name = newName;
    }
    
    updateEmail(newEmail) {
        if (!this.isValidEmail(newEmail)) {
            throw new Error('Invalid email address');
        }
        this._email = newEmail;
    }
    
    isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    
    equals(other) {
        return other instanceof User && this._id === other._id;
    }
}
```

**Not an entity:** a `Money` amount of $10. Two $10 bills are interchangeable—you don't track individual bill serial numbers. That's a value object.

**Entity test:** if two instances with different attribute values could still be "the same thing," it's an entity.

## Value Objects: Immutable, Validated, Interchangeable

Value objects are defined entirely by their attributes. No identity. Immutable—operations return new instances rather than mutating.

```javascript
class Money {
    constructor(amount, currency) {
        if (amount < 0) {
            throw new Error('Amount cannot be negative');
        }
        if (!currency) {
            throw new Error('Currency is required');
        }
        this._amount = amount;
        this._currency = currency;
        Object.freeze(this);
    }
    
    add(other) {
        if (this._currency !== other._currency) {
            throw new Error('Cannot add different currencies');
        }
        return new Money(this._amount + other._amount, this._currency);
    }
    
    subtract(other) {
        if (this._currency !== other._currency) {
            throw new Error('Cannot subtract different currencies');
        }
        if (this._amount < other._amount) {
            throw new Error('Insufficient funds');
        }
        return new Money(this._amount - other._amount, this._currency);
    }
    
    equals(other) {
        return other instanceof Money &&
               this._amount === other._amount &&
               this._currency === other._currency;
    }
}

class Address {
    constructor(street, city, state, zipCode) {
        this._street = street;
        this._city = city;
        this._state = state;
        this._zipCode = zipCode;
        Object.freeze(this);
    }
    
    equals(other) {
        return other instanceof Address &&
               this._street === other._street &&
               this._city === other._city &&
               this._state === other._state &&
               this._zipCode === other._zipCode;
    }
}
```

Value objects are where validation lives. An invalid `Money` can't exist. An invalid `Address` can't be constructed. Invalid states become unrepresentable—a much stronger guarantee than validating at service boundaries.

**Use value objects for:** money, addresses, date ranges, email addresses, coordinates, anything where you care about the value, not tracking a specific instance over time.

## Aggregates: Consistency Boundaries

An aggregate is a cluster of entities and value objects treated as a single unit for data changes. One entity is the **aggregate root**—the only entry point for external access.

Why? Because invariants span multiple objects. An `Order` with `OrderItems` has rules: can't confirm an empty order, can't modify items after shipping, total must match sum of items. The aggregate enforces these internally.

```javascript
class Order {
    constructor(id, customerId) {
        this._id = id;
        this._customerId = customerId;
        this._items = [];
        this._status = 'pending';
        this._total = new Money(0, 'USD');
    }
    
    get id() { return this._id; }
    
    get items() {
        return [...this._items];  // Return copy — don't expose internals
    }
    
    addItem(productId, quantity, price) {
        if (this._status !== 'pending') {
            throw new Error('Cannot modify completed order');
        }
        if (quantity <= 0) {
            throw new Error('Quantity must be positive');
        }
        
        const itemTotal = price.multiply(quantity);
        this._items.push({ productId, quantity, price, total: itemTotal });
        this._total = this._total.add(itemTotal);
    }
    
    removeItem(productId) {
        if (this._status !== 'pending') {
            throw new Error('Cannot modify completed order');
        }
        
        const index = this._items.findIndex(item => item.productId === productId);
        if (index === -1) throw new Error('Item not found');
        
        const item = this._items[index];
        this._total = this._total.subtract(item.total);
        this._items.splice(index, 1);
    }
    
    confirm() {
        if (this._items.length === 0) {
            throw new Error('Cannot confirm empty order');
        }
        this._status = 'confirmed';
    }
    
    cancel() {
        if (this._status === 'shipped') {
            throw new Error('Cannot cancel shipped order');
        }
        this._status = 'cancelled';
    }
}
```

**Rules I follow:**
- One aggregate per transaction (usually)
- Reference other aggregates by ID only, not object reference
- Keep aggregates small—large aggregates = contention and complexity
- External code calls methods on the root, never reaches into children

## Domain Services: When Logic Doesn't Belong to One Object

Sometimes business logic involves multiple aggregates or doesn't naturally fit one entity:

```javascript
class OrderPricingService {
    calculateDiscount(order, customer) {
        let discount = new Money(0, 'USD');
        
        if (customer.isVIP()) {
            discount = order.total.multiply(0.1);
        }
        
        if (order.total.amount > 100) {
            discount = discount.add(new Money(10, 'USD'));
        }
        
        return discount;
    }
}

class OrderValidationService {
    validateOrder(order, inventory) {
        const errors = [];
        
        for (const item of order.items) {
            const stock = inventory.getStock(item.productId);
            if (stock < item.quantity) {
                errors.push(`Insufficient stock for product ${item.productId}`);
            }
        }
        
        return errors;
    }
}
```

Domain services are stateless. They operate on domain objects but don't hold state themselves. If you're tempted to inject a database into a domain service, it's probably an application service in disguise.

## Repositories: Persistence Without Leaking

Repositories abstract data access behind a collection-like interface. Domain code asks for an `Order` by ID; the repository handles MongoDB, PostgreSQL, or JSON files.

```javascript
class OrderRepository {
    constructor(db) {
        this.db = db;
    }
    
    async findById(id) {
        const data = await this.db.orders.findOne({ id });
        if (!data) return null;
        return this.toDomain(data);
    }
    
    async save(order) {
        const data = this.toPersistence(order);
        await this.db.orders.save(data);
    }
    
    toDomain(data) {
        const order = new Order(data.id, data.customerId);
        data.items.forEach(item => {
            order.addItem(item.productId, item.quantity, new Money(item.price, 'USD'));
        });
        if (data.status === 'confirmed') order.confirm();
        return order;
    }
    
    toPersistence(order) {
        return {
            id: order.id,
            customerId: order.customerId,
            items: order.items.map(item => ({
                productId: item.productId,
                quantity: item.quantity,
                price: item.price.amount
            })),
            total: order.total.amount,
            status: order.status
        };
    }
}
```

**One repository per aggregate root.** Don't create repositories for entities inside aggregates. Don't expose database queries through repositories—`findByCustomerId` is fine; `findWhereTotalGreaterThan` is probably a query service concern.

## Application Services: Orchestrating Use Cases

Application services coordinate domain objects, manage transactions, and handle infrastructure concerns (sending emails, publishing events). They're thin—business logic stays in the domain.

```javascript
class OrderApplicationService {
    constructor(orderRepository, customerRepository, inventoryService, pricingService) {
        this.orderRepository = orderRepository;
        this.customerRepository = customerRepository;
        this.inventoryService = inventoryService;
        this.pricingService = pricingService;
    }
    
    async createOrder(customerId, items) {
        const customer = await this.customerRepository.findById(customerId);
        if (!customer) throw new Error('Customer not found');
        
        const order = new Order(generateId(), customerId);
        
        for (const item of items) {
            const stock = await this.inventoryService.getStock(item.productId);
            if (stock < item.quantity) {
                throw new Error(`Insufficient stock for product ${item.productId}`);
            }
            const price = await this.inventoryService.getPrice(item.productId);
            order.addItem(item.productId, item.quantity, price);
        }
        
        const discount = this.pricingService.calculateDiscount(order, customer);
        order.applyDiscount(discount);
        
        await this.orderRepository.save(order);
        return order.id;
    }
}
```

If your application service has 200 lines of `if/else` business logic, that logic belongs in domain objects.

## Common Mistakes (I've Made All of These)

**Anemic domain model.** Entities with only getters/setters. All logic in services. You have objects in name only.

**God aggregates.** One `Order` aggregate that includes Customer, Product, Inventory, and Shipping. Every change touches everything. Split it.

**Leaky repositories.** Returning raw database rows to application code. The mapping layer exists for a reason.

**Domain services with database access.** That's application service territory.

**Mutable value objects.** Someone does `money.amount = -5` and your invariants are gone. Freeze them.

## Testing: The Payoff

Rich domain models are trivially unit-testable—no database, no HTTP, no mocks:

```javascript
test('cannot confirm empty order', () => {
    const order = new Order('123', 'customer-1');
    expect(() => order.confirm()).toThrow('Cannot confirm empty order');
});

test('money refuses currency mismatch', () => {
    const usd = new Money(10, 'USD');
    const eur = new Money(10, 'EUR');
    expect(() => usd.add(eur)).toThrow('Cannot add different currencies');
});
```

These tests run in milliseconds and document business rules better than any wiki page.

## Conclusion

Tactical DDD isn't about ceremony—it's about putting business logic where it belongs. Entities for things with identity. Value objects for validated, immutable concepts. Aggregates for consistency boundaries. Repositories for persistence. Application services for orchestration.

The result: code that reads like the business domain, enforces invariants at construction, and tests without infrastructure. Your `Order` can't confirm itself when empty because the `Order` won't let it—not because a service checked first and hoped nobody called it differently elsewhere.

Start with value objects (easy win, immediate validation benefits). Then enrich your entities with behavior. Draw aggregate boundaries around consistency requirements. Add repositories when persistence gets messy.

Strategic patterns tell you where the boundaries are. Tactical patterns tell you what the code looks like inside. Both together—that's DDD worth doing.

---

*Domain-Driven Design tactical patterns from June 2020, covering entities, value objects, aggregates, and repositories.*

---
layout: post
title: "Domain-Driven Design: Tactical Patterns"
date: 2020-06-15
categories: [Architecture]
tags: [DDD, Domain-Driven Design, Patterns]
excerpt: "Learn DDD tactical patterns: entities, value objects, aggregates, domain services, repositories, and how to implement them in code."
---

DDD tactical patterns help implement domain models. After applying these patterns in production, here's how to use them effectively.

## Tactical Patterns Overview

Tactical patterns include:
- **Entities** - Objects with identity
- **Value Objects** - Immutable objects
- **Aggregates** - Consistency boundaries
- **Domain Services** - Domain logic
- **Repositories** - Data access abstraction

## Entities

### Definition

Entities:
- Have unique identity
- Can change over time
- Identified by ID, not attributes

### Implementation

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
    
    get name() {
        return this._name;
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

## Value Objects

### Definition

Value Objects:
- Defined by attributes, not identity
- Immutable
- No identity

### Implementation

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
        Object.freeze(this); // Make immutable
    }
    
    get amount() {
        return this._amount;
    }
    
    get currency() {
        return this._currency;
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
    
    get street() { return this._street; }
    get city() { return this._city; }
    get state() { return this._state; }
    get zipCode() { return this._zipCode; }
    
    equals(other) {
        return other instanceof Address &&
               this._street === other._street &&
               this._city === other._city &&
               this._state === other._state &&
               this._zipCode === other._zipCode;
    }
}
```

## Aggregates

### Definition

Aggregates:
- Consistency boundary
- Root entity
- Enforces invariants
- Accessed through root

### Implementation

```javascript
class Order {
    constructor(id, customerId) {
        this._id = id;
        this._customerId = customerId;
        this._items = [];
        this._status = 'pending';
        this._total = new Money(0, 'USD');
    }
    
    get id() {
        return this._id;
    }
    
    get items() {
        return [...this._items]; // Return copy
    }
    
    get total() {
        return this._total;
    }
    
    addItem(productId, quantity, price) {
        if (this._status !== 'pending') {
            throw new Error('Cannot modify completed order');
        }
        
        if (quantity <= 0) {
            throw new Error('Quantity must be positive');
        }
        
        const itemTotal = price.multiply(quantity);
        this._items.push({
            productId,
            quantity,
            price,
            total: itemTotal
        });
        
        this._total = this._total.add(itemTotal);
    }
    
    removeItem(productId) {
        if (this._status !== 'pending') {
            throw new Error('Cannot modify completed order');
        }
        
        const index = this._items.findIndex(item => item.productId === productId);
        if (index === -1) {
            throw new Error('Item not found');
        }
        
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

## Domain Services

### Definition

Domain Services:
- Operations that don't belong to entities
- Stateless
- Domain logic

### Implementation

```javascript
class OrderPricingService {
    calculateDiscount(order, customer) {
        let discount = new Money(0, 'USD');
        
        // VIP customers get 10% discount
        if (customer.isVIP()) {
            discount = order.total.multiply(0.1);
        }
        
        // Orders over $100 get $10 off
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

## Repositories

### Definition

Repositories:
- Abstract data access
- Collection-like interface
- Domain-focused

### Implementation

```javascript
class OrderRepository {
    constructor(db) {
        this.db = db;
    }
    
    async findById(id) {
        const data = await this.db.orders.findOne({ id });
        if (!data) {
            return null;
        }
        return this.toDomain(data);
    }
    
    async findByCustomerId(customerId) {
        const data = await this.db.orders.find({ customerId });
        return data.map(this.toDomain);
    }
    
    async save(order) {
        const data = this.toPersistence(order);
        await this.db.orders.save(data);
    }
    
    async delete(id) {
        await this.db.orders.delete({ id });
    }
    
    toDomain(data) {
        const order = new Order(data.id, data.customerId);
        // Restore state
        data.items.forEach(item => {
            order.addItem(item.productId, item.quantity, new Money(item.price, 'USD'));
        });
        if (data.status === 'confirmed') {
            order.confirm();
        }
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

## Application Services

### Definition

Application Services:
- Orchestrate domain objects
- Transaction boundaries
- Use case implementation

### Implementation

```javascript
class OrderApplicationService {
    constructor(
        orderRepository,
        customerRepository,
        inventoryService,
        pricingService
    ) {
        this.orderRepository = orderRepository;
        this.customerRepository = customerRepository;
        this.inventoryService = inventoryService;
        this.pricingService = pricingService;
    }
    
    async createOrder(customerId, items) {
        // Load aggregate
        const customer = await this.customerRepository.findById(customerId);
        if (!customer) {
            throw new Error('Customer not found');
        }
        
        // Create aggregate
        const order = new Order(generateId(), customerId);
        
        // Add items
        for (const item of items) {
            // Check inventory
            const stock = await this.inventoryService.getStock(item.productId);
            if (stock < item.quantity) {
                throw new Error(`Insufficient stock for product ${item.productId}`);
            }
            
            const price = await this.inventoryService.getPrice(item.productId);
            order.addItem(item.productId, item.quantity, price);
        }
        
        // Apply discount
        const discount = this.pricingService.calculateDiscount(order, customer);
        order.applyDiscount(discount);
        
        // Save aggregate
        await this.orderRepository.save(order);
        
        return order.id;
    }
    
    async confirmOrder(orderId) {
        const order = await this.orderRepository.findById(orderId);
        if (!order) {
            throw new Error('Order not found');
        }
        
        // Validate inventory
        const errors = this.orderValidationService.validateOrder(
            order,
            await this.inventoryService.getInventory()
        );
        
        if (errors.length > 0) {
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }
        
        // Confirm order
        order.confirm();
        
        // Reserve inventory
        for (const item of order.items) {
            await this.inventoryService.reserve(item.productId, item.quantity);
        }
        
        // Save
        await this.orderRepository.save(order);
    }
}
```

## Best Practices

1. **Keep aggregates small** - Consistency boundaries
2. **Use value objects** - Immutable, validated
3. **Protect invariants** - In aggregate root
4. **Repository per aggregate** - One repository per aggregate
5. **Domain services** - For cross-aggregate logic
6. **Application services** - Orchestration layer
7. **No anemic domain** - Behavior in domain objects
8. **Test domain logic** - Unit tests for domain

## Common Mistakes

1. **Anemic domain model** - Data without behavior
2. **Large aggregates** - Too many entities
3. **Leaky repositories** - Exposing persistence details
4. **Business logic in services** - Should be in domain
5. **Mutable value objects** - Should be immutable

## Conclusion

DDD tactical patterns enable:
- Rich domain models
- Clear boundaries
- Testable code
- Maintainable systems

Start with entities and value objects, then add aggregates and repositories. The patterns shown here handle complex domains.

---

*Domain-Driven Design tactical patterns from June 2020, covering entities, value objects, aggregates, and repositories.*

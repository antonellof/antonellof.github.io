---
layout: post
title: "Domain-Driven Design: Strategic Patterns"
date: 2020-01-25
categories: [Architecture]
tags: [DDD, Domain-Driven Design, Architecture]
excerpt: "Learn Domain-Driven Design strategic patterns: bounded contexts, context mapping, shared kernel, and how to model complex domains effectively."
---

Domain-Driven Design (DDD) helps model complex business domains. After applying DDD in production, here's how to use strategic patterns effectively.

## What is Domain-Driven Design?

DDD is:
- **Domain-focused** - Model reflects business
- **Ubiquitous language** - Shared vocabulary
- **Bounded contexts** - Explicit boundaries
- **Strategic patterns** - Context relationships

## Bounded Contexts

### Definition

A bounded context:
- Has explicit boundaries
- Contains domain model
- Uses ubiquitous language
- Owns data model

### Example: E-Commerce

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│   Catalog Context   │  │   Order Context     │  │  Shipping Context   │
│                     │  │                     │  │                     │
│  Product            │  │  Order              │  │  Shipment           │
│  Category           │  │  OrderItem          │  │  DeliveryAddress    │
│  Price              │  │  Payment            │  │  Tracking            │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

### Implementation

```javascript
// Catalog Context
class Product {
    constructor(id, name, price, category) {
        this.id = id;
        this.name = name;
        this.price = price;
        this.category = category;
    }
    
    updatePrice(newPrice) {
        if (newPrice <= 0) {
            throw new Error('Price must be positive');
        }
        this.price = newPrice;
    }
}

// Order Context
class Order {
    constructor(id, customerId, items) {
        this.id = id;
        this.customerId = customerId;
        this.items = items;
        this.status = 'pending';
    }
    
    addItem(productId, quantity, price) {
        this.items.push({
            productId,
            quantity,
            price
        });
    }
    
    calculateTotal() {
        return this.items.reduce((sum, item) => 
            sum + (item.quantity * item.price), 0
        );
    }
}
```

## Context Mapping

### Patterns

**Customer-Supplier:**
- Upstream provides to downstream
- Downstream depends on upstream
- Upstream prioritizes downstream needs

**Conformist:**
- Downstream conforms to upstream
- No influence on upstream
- Accept upstream model as-is

**Anti-Corruption Layer:**
- Translates between contexts
- Protects domain model
- Isolates external systems

**Shared Kernel:**
- Shared code between contexts
- Requires coordination
- Use sparingly

**Published Language:**
- Well-documented interface
- Stable contract
- Used for integration

### Context Map Example

```
┌──────────────┐
│   Catalog    │ (Upstream)
└──────┬───────┘
       │ Customer-Supplier
       │
┌──────▼───────┐
│    Order     │ (Downstream)
└──────┬───────┘
       │ Anti-Corruption Layer
       │
┌──────▼───────┐
│  Shipping    │ (External)
└──────────────┘
```

## Anti-Corruption Layer

### Implementation

```javascript
// External Shipping Service
class ExternalShippingService {
    async createShipment(orderData) {
        // External API format
        return await fetch('https://shipping-api.com/shipments', {
            method: 'POST',
            body: JSON.stringify({
                order_id: orderData.orderId,
                customer_name: orderData.customerName,
                address: orderData.address
            })
        });
    }
}

// Anti-Corruption Layer
class ShippingAdapter {
    constructor(externalService) {
        this.externalService = externalService;
    }
    
    async createShipment(order) {
        // Translate from domain model to external format
        const externalData = {
            orderId: order.id.value,
            customerName: order.customer.name,
            address: this.mapAddress(order.shippingAddress)
        };
        
        const result = await this.externalService.createShipment(externalData);
        
        // Translate back to domain model
        return this.mapToShipment(result);
    }
    
    mapAddress(address) {
        return {
            street: address.street,
            city: address.city,
            zip: address.postalCode
        };
    }
    
    mapToShipment(externalResult) {
        return new Shipment(
            externalResult.shipment_id,
            externalResult.tracking_number
        );
    }
}
```

## Shared Kernel

### When to Use

**Use when:**
- Tightly coupled contexts
- Shared domain concepts
- Requires coordination

**Avoid when:**
- Contexts can evolve independently
- Different teams
- Different release cycles

### Implementation

```javascript
// Shared Kernel
// shared-kernel/value-objects.js
class Money {
    constructor(amount, currency) {
        if (amount < 0) {
            throw new Error('Amount cannot be negative');
        }
        this.amount = amount;
        this.currency = currency;
    }
    
    add(other) {
        if (this.currency !== other.currency) {
            throw new Error('Cannot add different currencies');
        }
        return new Money(this.amount + other.amount, this.currency);
    }
}

// Catalog Context uses shared kernel
import { Money } from '../shared-kernel/value-objects';

class Product {
    constructor(id, name, price) {
        this.id = id;
        this.name = name;
        this.price = price; // Money object
    }
}

// Order Context uses shared kernel
import { Money } from '../shared-kernel/value-objects';

class Order {
    calculateTotal() {
        return this.items.reduce((total, item) => 
            total.add(item.subtotal), 
            new Money(0, 'USD')
        );
    }
}
```

## Published Language

### Definition

Published language:
- Well-documented interface
- Stable contract
- Versioned
- Used for integration

### Example

```javascript
// Published Language - Order Events
class OrderCreatedEvent {
    constructor(orderId, customerId, items, total) {
        this.eventType = 'OrderCreated';
        this.version = '1.0';
        this.orderId = orderId;
        this.customerId = customerId;
        this.items = items.map(item => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price
        }));
        this.total = total;
        this.timestamp = new Date().toISOString();
    }
}

// Publisher
class OrderService {
    async createOrder(orderData) {
        const order = new Order(orderData);
        await this.orderRepository.save(order);
        
        // Publish event using published language
        const event = new OrderCreatedEvent(
            order.id,
            order.customerId,
            order.items,
            order.total
        );
        
        await this.eventBus.publish(event);
        return order;
    }
}

// Subscriber (different bounded context)
class InventoryService {
    async handleOrderCreated(event) {
        // Consume published language
        for (const item of event.items) {
            await this.decreaseStock(item.productId, item.quantity);
        }
    }
}
```

## Context Integration

### Event-Driven Integration

```javascript
// Order Context publishes events
class OrderService {
    async shipOrder(orderId) {
        const order = await this.orderRepository.findById(orderId);
        order.markAsShipped();
        await this.orderRepository.save(order);
        
        // Publish event
        await this.eventBus.publish({
            type: 'OrderShipped',
            orderId: order.id,
            shippingAddress: order.shippingAddress
        });
    }
}

// Shipping Context subscribes to events
class ShippingService {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.eventBus.subscribe('OrderShipped', this.handleOrderShipped.bind(this));
    }
    
    async handleOrderShipped(event) {
        const shipment = await this.createShipment({
            orderId: event.orderId,
            address: event.shippingAddress
        });
        
        // Publish back
        await this.eventBus.publish({
            type: 'ShipmentCreated',
            orderId: event.orderId,
            trackingNumber: shipment.trackingNumber
        });
    }
}
```

## Best Practices

1. **Identify bounded contexts** - Based on domain
2. **Use ubiquitous language** - Shared vocabulary
3. **Map relationships** - Context mapping
4. **Protect boundaries** - Anti-corruption layers
5. **Minimize shared kernel** - Use sparingly
6. **Version published language** - Stable contracts
7. **Document boundaries** - Clear ownership
8. **Evolve independently** - Minimize coupling

## Common Mistakes

1. **Too many bounded contexts** - Over-engineering
2. **Shared kernel everywhere** - Tight coupling
3. **No context mapping** - Unclear relationships
4. **Ignoring boundaries** - Leaky abstractions
5. **No ubiquitous language** - Miscommunication

## Conclusion

Strategic DDD patterns enable:
- Clear boundaries
- Independent evolution
- Better integration
- Domain focus

Start with bounded contexts, then map relationships. The patterns shown here handle complex domains.

---

*Domain-Driven Design strategic patterns from January 2020, covering bounded contexts and context mapping.*

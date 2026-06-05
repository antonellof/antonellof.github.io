---
layout: post
title: "Domain-Driven Design: Strategic Patterns"
date: 2020-01-25
categories: [Architecture]
tags: [DDD, Domain-Driven Design, Architecture]
excerpt: "Bounded contexts saved us from a monolith where 'Product' meant three different things to three teams. Here's how strategic DDD patterns—context mapping, anti-corruption layers, and published language—keep complex domains sane."
---

I once sat in a meeting where three engineers argued about what a "Product" was. Marketing thought it was a campaign landing page. Catalog owned the SKU and pricing. Fulfillment cared about weight and dimensions. Everyone was right. Everyone was also building against the same `products` table, and nobody was winning.

That meeting was my introduction to why strategic Domain-Driven Design matters. Tactical patterns—entities, value objects, aggregates—get all the blog posts. But strategic patterns are what stop your e-commerce platform from becoming a philosophical debate with a PostgreSQL backend.

Strategic DDD is about drawing boundaries: where one model ends and another begins, how teams talk to each other, and how you integrate with legacy systems without letting their weirdness infect your domain. Eric Evans called this "context mapping," and it's the part of DDD that actually saves projects.

## What Strategic DDD Actually Solves

Most "DDD" implementations I see are just folder reorganization with fancier names. Strategic patterns address a different problem: **your business is too complex for one unified model**.

DDD gives you:
- **Bounded contexts** — explicit boundaries where a specific domain model applies
- **Ubiquitous language** — shared vocabulary *within* a context (not globally)
- **Context mapping** — documented relationships between contexts
- **Integration patterns** — how contexts talk without corrupting each other

The key insight: you don't need one `Product` class. You need three `Product` concepts in three contexts, with clear translation between them.

## Bounded Contexts: Drawing the Lines

A bounded context is a boundary within which a particular domain model is defined and applicable. Inside the boundary, terms have precise meaning. Outside, they might mean something else entirely—and that's fine.

### The E-Commerce Example That Finally Clicked

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│   Catalog Context   │  │   Order Context     │  │  Shipping Context   │
│                     │  │                     │  │                     │
│  Product            │  │  Order              │  │  Shipment           │
│  Category           │  │  OrderItem          │  │  DeliveryAddress    │
│  Price              │  │  Payment            │  │  Tracking           │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

In Catalog, `Product` has marketing copy, categories, and list prices. In Order, you have `OrderItem` with a *snapshot* of price at purchase time (because catalog prices change, but your receipt shouldn't). In Shipping, you care about dimensions and hazmat flags, not whether the product was featured on the homepage.

Same word. Three models. Zero confusion—because the boundaries are explicit.

### Implementation: Same Concept, Different Models

```javascript
// Catalog Context — merchandising view
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

// Order Context — transactional view
class Order {
    constructor(id, customerId, items) {
        this.id = id;
        this.customerId = customerId;
        this.items = items;
        this.status = 'pending';
    }
    
    addItem(productId, quantity, price) {
        // Price is captured at order time — not fetched live from catalog
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

Notice we don't import `Product` from Catalog into Order. We store `productId` and a price snapshot. This isn't duplication—it's intentional denormalization across context boundaries.

### How to Identify Bounded Contexts

I look for:
1. **Different teams** owning different areas (Conway's Law is real)
2. **Different rates of change** (catalog changes weekly, billing changes yearly)
3. **Different language** (support says "ticket," engineering says "incident")
4. **Integration pain** where models keep leaking into each other

Start with 3-5 contexts, not 30. You can always split later. I've never regretted starting too coarse; I've often regretted starting too fine.

## Context Mapping: Relationships Between Worlds

Once you have bounded contexts, you need to document how they relate. Evans defined several patterns:

**Customer-Supplier:** Upstream context provides data/APIs; downstream depends on upstream. Upstream team considers downstream needs in their roadmap. Classic example: Catalog (upstream) → Order (downstream).

**Conformist:** Downstream has no leverage and just accepts upstream's model. Painful but pragmatic when integrating with a vendor API you can't change.

**Anti-Corruption Layer (ACL):** Downstream builds a translation layer to protect its domain model from upstream's messy reality. This is your best friend when integrating with legacy systems.

**Shared Kernel:** Two contexts share a small, explicitly coordinated subset of the model. Use sparingly—it creates coupling. We used this for `Money` value objects across Catalog and Order.

**Published Language:** A well-documented, versioned interchange format (usually events or API schemas) that contexts use to communicate.

### Context Map for Our E-Commerce Platform

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
│  Shipping    │ (External vendor)
└──────────────┘
```

We controlled Catalog and Order. Shipping was a third-party API with its own ideas about addresses (they wanted `zip`, we had `postalCode`; they had no concept of "apartment number"). ACL was non-negotiable.

## Anti-Corruption Layer: Your Domain's Bodyguard

The ACL translates between your clean domain model and the messy external world. Without it, external concepts leak into your codebase like water into a basement—slowly, then all at once.

### The Shipping Integration War Story

Our shipping vendor's API returned `shipment_id` and `tracking_number` as strings, used `customer_name` instead of structured names, and required addresses in a format that didn't match our `Address` value object. We could have just used their format everywhere. We didn't.

```javascript
// External Shipping Service — we don't control this
class ExternalShippingService {
    async createShipment(orderData) {
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

// Anti-Corruption Layer — our domain speaks here
class ShippingAdapter {
    constructor(externalService) {
        this.externalService = externalService;
    }
    
    async createShipment(order) {
        // Translate FROM our domain TO their format
        const externalData = {
            orderId: order.id.value,
            customerName: order.customer.name,
            address: this.mapAddress(order.shippingAddress)
        };
        
        const result = await this.externalService.createShipment(externalData);
        
        // Translate FROM their format TO our domain
        return this.mapToShipment(result);
    }
    
    mapAddress(address) {
        return {
            street: address.street,
            city: address.city,
            zip: address.postalCode  // Their API wants 'zip', we use 'postalCode'
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

When the vendor changed their API (they did, twice), we updated the adapter. Order context didn't know or care. That's the whole point.

## Shared Kernel: Use With Extreme Caution

Shared kernel means two contexts share code. This sounds convenient and quickly becomes a coordination nightmare.

**Use when:**
- Contexts are maintained by the same team
- The shared concept is stable (like `Money` or `Email`)
- You have a process for coordinating changes

**Avoid when:**
- Different teams own the contexts
- Different release cycles
- The shared code changes frequently

We shared only `Money`—amount plus currency, with validation. That's it. Everything else duplicated or translated.

```javascript
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

// Both contexts import from shared kernel
import { Money } from '../shared-kernel/value-objects';
```

If you're sharing more than value objects and basic types, you're probably creating a distributed monolith with extra steps.

## Published Language: Events as Contracts

When contexts communicate asynchronously, you need a stable, versioned contract. We used domain events as our published language:

```javascript
// Published Language — Order Events (versioned contract)
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

// Publisher (Order context)
class OrderService {
    async createOrder(orderData) {
        const order = new Order(orderData);
        await this.orderRepository.save(order);
        
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

// Subscriber (Inventory context — different bounded context)
class InventoryService {
    async handleOrderCreated(event) {
        for (const item of event.items) {
            await this.decreaseStock(item.productId, item.quantity);
        }
    }
}
```

The event schema is the contract. Version it (`1.0`, `1.1`, `2.0`). Document it. Breaking changes require a new version and a migration plan—not a surprise deploy on Friday afternoon.

## Context Integration: Event-Driven Choreography

For loosely coupled contexts, events beat synchronous API calls:

```javascript
// Order Context publishes
class OrderService {
    async shipOrder(orderId) {
        const order = await this.orderRepository.findById(orderId);
        order.markAsShipped();
        await this.orderRepository.save(order);
        
        await this.eventBus.publish({
            type: 'OrderShipped',
            orderId: order.id,
            shippingAddress: order.shippingAddress
        });
    }
}

// Shipping Context subscribes
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
        
        await this.eventBus.publish({
            type: 'ShipmentCreated',
            orderId: event.orderId,
            trackingNumber: shipment.trackingNumber
        });
    }
}
```

Order doesn't know about Shipping's internals. Shipping doesn't call back into Order's database. They exchange events through a published language. If Shipping is down, events queue. If Order changes its model, Shipping's ACL handles translation.

## Practical Advice From the Trenches

1. **Start with a context map on a whiteboard** — before writing code
2. **Name contexts after business capabilities**, not technical layers ("Billing," not "DatabaseService")
3. **Document the ubiquitous language per context** — a glossary saves hours of meetings
4. **Default to ACL for external integrations** — legacy systems will hurt you otherwise
5. **Minimize shared kernel** — every shared line is a future coordination meeting
6. **Version your published language** — events and APIs are contracts
7. **Evolve contexts independently** — that's the whole point of boundaries

## Common Mistakes I've Made (So You Don't Have To)

**Too many bounded contexts.** We once drew 15 contexts for a mid-size app. Nobody could remember which was which. Three to seven is the sweet spot for most products.

**Shared kernel everywhere.** "Let's just share the User model!" Famous last words. Six months later, two teams are blocked on every User change.

**No context map.** Boundaries exist in code but not in docs. New engineers violate them accidentally. The map doesn't need to be fancy—a Miro board or markdown file works.

**Leaky abstractions.** Order context importing Catalog's `Product` entity directly. Congratulations, you've built a monolith with extra network hops.

**Ignoring the business.** Technical boundaries that don't match how the business thinks will be fought constantly.

## Conclusion

Strategic DDD isn't about diagrams and sticky notes—though those help. It's about acknowledging that complex businesses have multiple valid models, and pretending otherwise creates the kind of codebase where every change breaks three teams.

Bounded contexts give you permission to model the same real-world concept differently in different places. Context mapping documents how those places interact. Anti-corruption layers protect your domain from external chaos. Published language gives you stable contracts across team boundaries.

Start with a context map for your current system. You'll probably discover you already have implicit bounded contexts—you just haven't named them or drawn the lines. Naming them is the first step toward independent evolution, clearer ownership, and fewer meetings about what "Product" means.

The tactical patterns (entities, aggregates, repositories) tell you *how* to write code inside a context. Strategic patterns tell you *where* that code belongs and *how* contexts talk. Get the strategy right, and the tactics become straightforward. Get it wrong, and no amount of clean entity code will save you.

---

*Domain-Driven Design strategic patterns from January 2020, covering bounded contexts and context mapping.*

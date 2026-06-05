---
layout: post
title: "Saga Pattern for Distributed Transactions"
date: 2020-11-09
categories: [Architecture]
tags: [Saga, Distributed Transactions, Patterns]
excerpt: "Distributed transactions without two-phase commit: the saga pattern coordinates multi-service workflows with compensation logic for when step 3 of 4 fails and you need to undo steps 1 and 2."
---

Checkout failed at the payment step. Inventory was already reserved. The order existed. The customer's card was never charged—but our system thought it had a pending order with locked stock. Support tickets followed.

This is the distributed transaction problem. In a monolith, you'd wrap order creation, inventory reservation, and payment in a single database transaction. Roll back everything if payment fails. Clean.

In microservices, each step lives in a different service with its own database. You can't use a single ACID transaction across them. Two-phase commit (2PC) exists in theory—XA transactions, distributed locks—but it's slow, brittle, and most cloud-native databases don't support it well.

The **saga pattern** is the pragmatic alternative: a sequence of local transactions, each with a compensating action if things go wrong. Not atomicity—**eventual consistency with a recovery path**.

## What a Saga Is

A saga coordinates a multi-step business process across services:

1. **Create order** → compensate: cancel order
2. **Reserve inventory** → compensate: release inventory
3. **Charge payment** → compensate: refund payment
4. **Create shipment** → compensate: cancel shipment

If step 3 fails, compensating actions run for steps 2 and 1 (in reverse order). The system ends up in a consistent state—not the desired end state, but a valid one.

Sagas accept that distributed transactions are **eventually consistent**, not atomic. The trade-off: availability and scalability over immediate consistency.

## Orchestration vs Choreography

Two ways to coordinate sagas. I've used both. They feel very different.

### Orchestration: Central Conductor

A saga orchestrator tells each service what to do and tracks progress. Services don't know they're part of a saga—they just respond to commands.

```javascript
class OrderSagaOrchestrator {
    constructor(orderService, paymentService, inventoryService, shippingService) {
        this.orderService = orderService;
        this.paymentService = paymentService;
        this.inventoryService = inventoryService;
        this.shippingService = shippingService;
    }
    
    async execute(orderData) {
        const sagaId = generateId();
        const completedSteps = [];
        
        try {
            const order = await this.orderService.createOrder({ ...orderData, sagaId });
            completedSteps.push({ type: 'createOrder', orderId: order.id });
            
            await this.inventoryService.reserveItems({
                orderId: order.id,
                items: orderData.items
            });
            completedSteps.push({ type: 'reserveInventory', orderId: order.id });
            
            await this.paymentService.charge({
                orderId: order.id,
                amount: order.total
            });
            completedSteps.push({ type: 'chargePayment', orderId: order.id });
            
            await this.shippingService.createShipment({
                orderId: order.id,
                address: orderData.shippingAddress
            });
            completedSteps.push({ type: 'createShipment', orderId: order.id });
            
            return order;
            
        } catch (error) {
            await this.compensate(completedSteps.reverse());
            throw error;
        }
    }
    
    async compensate(steps) {
        for (const step of steps) {
            try {
                switch (step.type) {
                    case 'createShipment':
                        await this.shippingService.cancelShipment(step.orderId);
                        break;
                    case 'chargePayment':
                        await this.paymentService.refund(step.orderId);
                        break;
                    case 'reserveInventory':
                        await this.inventoryService.releaseItems(step.orderId);
                        break;
                    case 'createOrder':
                        await this.orderService.cancelOrder(step.orderId);
                        break;
                }
            } catch (compError) {
                // Compensation failure — log, alert, manual intervention
                console.error(`Compensation failed for ${step.type}:`, compError);
                await this.alertOps(step, compError);
            }
        }
    }
}
```

**Orchestration pros:** Easy to understand the flow. Central place for logging, timeouts, monitoring. Simple to add steps.

**Orchestration cons:** Orchestrator is a single point of failure and coupling. Can become a "god service."

**Use orchestration when:** Complex workflows, need visibility, fewer services involved, team prefers explicit control.

### Choreography: Services React to Events

No central coordinator. Each service listens for events and publishes its own. The saga emerges from event reactions.

```javascript
// Order Service
class OrderService {
    async createOrder(orderData) {
        const order = await this.orderRepository.save({ ...orderData, status: 'pending' });
        
        await this.eventBus.publish({
            type: 'OrderCreated',
            orderId: order.id,
            items: order.items,
            total: order.total
        });
        
        return order;
    }
    
    async handlePaymentFailed(event) {
        await this.orderRepository.update(event.orderId, { status: 'cancelled' });
        await this.eventBus.publish({ type: 'OrderCancelled', orderId: event.orderId });
    }
}

// Inventory Service
class InventoryService {
    async handleOrderCreated(event) {
        try {
            await this.reserveItems(event.orderId, event.items);
            await this.eventBus.publish({ type: 'InventoryReserved', orderId: event.orderId });
        } catch (error) {
            await this.eventBus.publish({
                type: 'InventoryReservationFailed',
                orderId: event.orderId,
                error: error.message
            });
        }
    }
    
    async handleOrderCancelled(event) {
        await this.releaseItems(event.orderId);
    }
}

// Payment Service
class PaymentService {
    async handleInventoryReserved(event) {
        try {
            const order = await this.orderService.getOrder(event.orderId);
            await this.charge(order.id, order.total);
            await this.eventBus.publish({ type: 'PaymentCharged', orderId: event.orderId });
        } catch (error) {
            await this.eventBus.publish({
                type: 'PaymentFailed',
                orderId: event.orderId
            });
        }
    }
}
```

**Choreography pros:** Loose coupling. No central point of failure. Services are independent.

**Choreography cons:** Hard to see the full picture. Debugging "why is order 123 stuck?" requires tracing events across services. Risk of cyclic dependencies.

**Use choreography when:** Simple linear flows, teams want independence, event infrastructure is mature.

My default: **orchestration for complex sagas, choreography for simple event chains.**

## Compensation: The Hard Part

Compensation isn't "undo." It's a **semantic rollback**—a business action that reverses the effect.

- Cancel order (not DELETE—mark as cancelled)
- Release inventory (return reserved stock)
- Refund payment (not void—actual refund transaction)
- Cancel shipment (if not yet picked up)

**Compensation must be:**
- **Idempotent** — running twice doesn't double-refund
- **Possible** — you can't "unship" a delivered package; compensate differently
- **Logged** — when compensation fails, humans need to intervene

```javascript
async function compensateSteps(steps) {
    for (const step of steps.reverse()) {
        if (step.status === 'completed') {
            try {
                await step.compensate();
                step.status = 'compensated';
            } catch (error) {
                step.status = 'compensation_failed';
                await alertOps(step, error);
            }
        }
    }
}
```

The nightmare scenario: payment charged, inventory released, order cancellation fails. Now you have money, no stock reservation, and an active order. **Design compensations to be retryable and monitor for `compensation_failed` states.**

## Saga State Management

Long-running sagas need persistent state:

```javascript
class SagaState {
    constructor(sagaId) {
        this.sagaId = sagaId;
        this.status = 'running';  // running | completed | compensating | failed
        this.steps = [];
        this.createdAt = new Date();
    }
    
    addStep(type, data) {
        this.steps.push({
            id: generateId(),
            type,
            data,
            status: 'pending',
            timestamp: new Date()
        });
    }
    
    completeStep(stepId) {
        const step = this.steps.find(s => s.id === stepId);
        if (step) step.status = 'completed';
    }
    
    failStep(stepId, error) {
        const step = this.steps.find(s => s.id === stepId);
        if (step) {
            step.status = 'failed';
            step.error = error;
        }
    }
}
```

Store saga state in a database. On orchestrator restart, resume or compensate in-progress sagas. **Never keep saga state only in memory.**

## Recovery Strategies

**Forward recovery:** Retry the failed step (transient failures—network blip, service restart).

```javascript
async function executeWithRetry(step, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await step.execute();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await sleep(1000 * Math.pow(2, i));
        }
    }
}
```

**Backward recovery:** Compensate completed steps (business failures—insufficient funds, out of stock).

Use forward recovery for infrastructure failures. Use backward recovery for business rule violations. Mixing them up causes infinite retry loops on non-transient errors.

## Order Processing Saga (The Classic)

```
Forward path:
1. Create Order
2. Reserve Inventory
3. Charge Payment
4. Create Shipment

Compensation (reverse order):
4. Cancel Shipment
3. Refund Payment
2. Release Inventory
1. Cancel Order
```

Draw this diagram before writing code. Every engineer should know the happy path and the recovery path.

## Production Checklist

1. **Idempotent operations** — every step and compensation safe to retry
2. **Persistent saga state** — survive restarts
3. **Timeouts** — don't let sagas run forever; compensate on timeout
4. **Monitoring** — dashboard for saga status (running, stuck, failed)
5. **Alerting on compensation failure** — this needs human eyes
6. **Test compensation paths** — not just happy path
7. **Document semantic compensations** — what "cancel" means per service

## Conclusion

Sagas don't give you ACID across services. They give you something more honest: **a defined process for getting back to a valid state when things fail**. In distributed systems, things fail.

The checkout bug that started this post? We implemented an orchestrated saga with persistent state, idempotent compensations, and alerts when compensation failed. Orders got stuck sometimes—but they got stuck in a *known, recoverable state*, not limbo.

Choose orchestration when you need control and visibility. Choose choreography when you need loose coupling and can tolerate harder debugging. Either way, design compensations as carefully as forward steps.

Two-phase commit promises atomicity you'll never get in microservices. Sagas promise something better: a system that fails gracefully and recovers predictably. That's what production actually needs.

---

*Saga pattern for distributed transactions from November 2020, covering orchestration and choreography patterns.*

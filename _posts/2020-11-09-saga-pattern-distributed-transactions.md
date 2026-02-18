---
layout: post
title: "Saga Pattern for Distributed Transactions"
date: 2020-11-09
categories: [Architecture]
tags: [Saga, Distributed Transactions, Patterns]
excerpt: "Implement the Saga pattern for distributed transactions in microservices. Learn orchestration vs choreography, compensation, and handling failures across services."
---

The Saga pattern manages distributed transactions without two-phase commit. After implementing sagas in production, here's how to use them effectively.

## What is the Saga Pattern?

A Saga:
- **Coordinates** multiple services
- **Compensates** on failures
- **No distributed locks** - Eventual consistency
- **Long-running** transactions

## Saga Types

### Orchestration

**Centralized coordinator:**
- Saga orchestrator coordinates steps
- Services don't know about saga
- Easier to understand
- Single point of failure

### Choreography

**Distributed coordination:**
- Services coordinate themselves
- No central orchestrator
- More resilient
- Harder to understand

## Orchestration Pattern

### Saga Orchestrator

```javascript
class OrderSagaOrchestrator {
    constructor(
        orderService,
        paymentService,
        inventoryService,
        shippingService
    ) {
        this.orderService = orderService;
        this.paymentService = paymentService;
        this.inventoryService = inventoryService;
        this.shippingService = shippingService;
    }
    
    async execute(orderData) {
        const sagaId = generateId();
        const steps = [];
        
        try {
            // Step 1: Create order
            const order = await this.orderService.createOrder({
                ...orderData,
                sagaId
            });
            steps.push({ type: 'createOrder', orderId: order.id });
            
            // Step 2: Reserve inventory
            await this.inventoryService.reserveItems({
                orderId: order.id,
                items: orderData.items
            });
            steps.push({ type: 'reserveInventory', orderId: order.id });
            
            // Step 3: Process payment
            await this.paymentService.charge({
                orderId: order.id,
                amount: order.total
            });
            steps.push({ type: 'chargePayment', orderId: order.id });
            
            // Step 4: Create shipment
            await this.shippingService.createShipment({
                orderId: order.id,
                address: orderData.shippingAddress
            });
            steps.push({ type: 'createShipment', orderId: order.id });
            
            // Mark saga as completed
            await this.completeSaga(sagaId);
            
            return order;
            
        } catch (error) {
            // Compensate in reverse order
            await this.compensate(sagaId, steps.reverse());
            throw error;
        }
    }
    
    async compensate(sagaId, steps) {
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
            } catch (error) {
                // Log compensation failure
                console.error(`Compensation failed for ${step.type}:`, error);
            }
        }
    }
}
```

## Choreography Pattern

### Event-Driven Saga

```javascript
// Order Service
class OrderService {
    async createOrder(orderData) {
        const order = await this.orderRepository.save({
            ...orderData,
            status: 'pending'
        });
        
        // Publish event
        await this.eventBus.publish({
            type: 'OrderCreated',
            orderId: order.id,
            items: order.items,
            total: order.total
        });
        
        return order;
    }
    
    async handlePaymentFailed(event) {
        await this.orderRepository.update(event.orderId, {
            status: 'cancelled'
        });
    }
}

// Inventory Service
class InventoryService {
    async handleOrderCreated(event) {
        try {
            await this.reserveItems(event.orderId, event.items);
            
            await this.eventBus.publish({
                type: 'InventoryReserved',
                orderId: event.orderId
            });
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
            
            await this.eventBus.publish({
                type: 'PaymentCharged',
                orderId: event.orderId
            });
        } catch (error) {
            await this.eventBus.publish({
                type: 'PaymentFailed',
                orderId: event.orderId,
                error: error.message
            });
        }
    }
    
    async handleOrderCancelled(event) {
        await this.refund(event.orderId);
    }
}
```

## Compensation Strategies

### Forward Recovery

```javascript
// Retry failed step
async function executeWithRetry(step, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await step.execute();
        } catch (error) {
            if (i === maxRetries - 1) {
                throw error;
            }
            await sleep(1000 * Math.pow(2, i)); // Exponential backoff
        }
    }
}
```

### Backward Recovery

```javascript
// Compensate completed steps
async function compensateSteps(steps) {
    for (const step of steps.reverse()) {
        if (step.status === 'completed') {
            await step.compensate();
        }
    }
}
```

## Saga State Management

### Saga State

```javascript
class SagaState {
    constructor(sagaId) {
        this.sagaId = sagaId;
        this.status = 'pending';
        this.steps = [];
        this.createdAt = new Date();
    }
    
    addStep(step) {
        this.steps.push({
            ...step,
            status: 'pending',
            timestamp: new Date()
        });
    }
    
    completeStep(stepId) {
        const step = this.steps.find(s => s.id === stepId);
        if (step) {
            step.status = 'completed';
        }
    }
    
    failStep(stepId, error) {
        const step = this.steps.find(s => s.id === stepId);
        if (step) {
            step.status = 'failed';
            step.error = error;
        }
    }
    
    getCompletedSteps() {
        return this.steps.filter(s => s.status === 'completed');
    }
}
```

## Best Practices

1. **Idempotent operations** - Safe retries
2. **Compensation logic** - Reversible operations
3. **Timeout handling** - Prevent hanging
4. **State persistence** - Store saga state
5. **Monitoring** - Track saga progress
6. **Error handling** - Graceful failures
7. **Testing** - Test compensation
8. **Documentation** - Clear saga flows

## Common Patterns

### Order Processing Saga

```
1. Create Order
2. Reserve Inventory
3. Charge Payment
4. Create Shipment

Compensation (reverse):
4. Cancel Shipment
3. Refund Payment
2. Release Inventory
1. Cancel Order
```

## Conclusion

The Saga pattern enables:
- Distributed transactions
- Eventual consistency
- Failure handling
- Scalable systems

Use orchestration for control, choreography for resilience. The patterns shown here handle production workloads.

---

*Saga pattern for distributed transactions from November 2020, covering orchestration and choreography patterns.*

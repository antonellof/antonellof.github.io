---
layout: post
title: "Event-Driven Architecture with RabbitMQ"
date: 2016-07-15
categories: [Architecture]
tags: [RabbitMQ, Event-Driven, Message Queue, Microservices]
excerpt: "Building scalable event-driven systems with RabbitMQ, covering exchanges, queues, routing patterns, and real-world examples for decoupled microservices communication."
---

Event-driven architecture transformed how we build distributed systems. Instead of tightly coupled services making synchronous calls, we moved to asynchronous messaging with RabbitMQ. This shift enabled us to scale independently and handle failures gracefully. Here's how we implemented event-driven patterns in production.

## Why Event-Driven Architecture?

Traditional request-response patterns have limitations:
- Tight coupling between services
- Cascading failures
- Difficult to scale independently
- Blocking operations reduce throughput

Event-driven architecture solves these with:
- Loose coupling via message passing
- Resilience through message persistence
- Independent scaling
- Better resource utilization

## RabbitMQ Fundamentals

### Basic Concepts

- **Producer**: Publishes messages
- **Exchange**: Routes messages to queues
- **Queue**: Stores messages
- **Consumer**: Processes messages
- **Binding**: Links exchanges to queues

### Installation and Setup

```bash
# Install RabbitMQ
docker run -d --name rabbitmq \
    -p 5672:5672 \
    -p 15672:15672 \
    rabbitmq:3-management

# Management UI: http://localhost:15672
# Default credentials: guest/guest
```

## Exchange Types

### 1. Direct Exchange

Routes messages to queues based on routing key:

```python
import pika

connection = pika.BlockingConnection(
    pika.ConnectionParameters('localhost')
)
channel = connection.channel()

# Declare exchange
channel.exchange_declare(
    exchange='orders',
    exchange_type='direct'
)

# Declare queue
channel.queue_declare(queue='order-processing')

# Bind queue to exchange with routing key
channel.queue_bind(
    exchange='orders',
    queue='order-processing',
    routing_key='order.created'
)

# Publish message
channel.basic_publish(
    exchange='orders',
    routing_key='order.created',
    body='{"order_id": 123, "amount": 99.99}',
    properties=pika.BasicProperties(
        delivery_mode=2,  # Make message persistent
    )
)

connection.close()
```

### 2. Topic Exchange

Routes messages based on pattern matching:

```python
# Producer
channel.exchange_declare(
    exchange='events',
    exchange_type='topic'
)

# Publish with topic routing key
channel.basic_publish(
    exchange='events',
    routing_key='order.us.created',
    body='Order created in US'
)

channel.basic_publish(
    exchange='events',
    routing_key='order.eu.created',
    body='Order created in EU'
)

# Consumer - bind to pattern
channel.queue_bind(
    exchange='events',
    queue='order-notifications',
    routing_key='order.*.created'  # Matches both us and eu
)
```

### 3. Fanout Exchange

Broadcasts messages to all bound queues:

```python
# Producer
channel.exchange_declare(
    exchange='notifications',
    exchange_type='fanout'
)

# Multiple queues receive same message
channel.queue_bind(exchange='notifications', queue='email-service')
channel.queue_bind(exchange='notifications', queue='sms-service')
channel.queue_bind(exchange='notifications', queue='push-service')

# Publish once, all queues receive
channel.basic_publish(
    exchange='notifications',
    routing_key='',  # Ignored for fanout
    body='User registered'
)
```

## Reliable Message Processing

### Message Acknowledgment

```python
def process_order(ch, method, properties, body):
    try:
        order_data = json.loads(body)
        
        # Process order
        process_order_logic(order_data)
        
        # Acknowledge message
        ch.basic_ack(delivery_tag=method.delivery_tag)
        
    except Exception as e:
        # Reject and requeue
        ch.basic_nack(
            delivery_tag=method.delivery_tag,
            requeue=True
        )
        print(f"Error processing order: {e}")

# Consume with manual ack
channel.basic_consume(
    queue='order-processing',
    on_message_callback=process_order,
    auto_ack=False  # Manual acknowledgment
)

channel.start_consuming()
```

### Dead Letter Queues

Handle failed messages:

```python
# Declare DLQ
channel.queue_declare(
    queue='order-processing-dlq',
    durable=True
)

# Declare main queue with DLQ
channel.queue_declare(
    queue='order-processing',
    durable=True,
    arguments={
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'order-processing-dlq',
        'x-message-ttl': 60000  # 60 seconds TTL
    }
)

def process_with_dlq(ch, method, properties, body):
    try:
        process_order_logic(body)
        ch.basic_ack(delivery_tag=method.delivery_tag)
    except Exception as e:
        # After max retries, message goes to DLQ
        ch.basic_nack(
            delivery_tag=method.delivery_tag,
            requeue=False  # Don't requeue, send to DLQ
        )
```

## Real-World Example: E-Commerce System

```python
# Order Service - Publishes events
class OrderService:
    def __init__(self):
        self.publisher = EventPublisher()
    
    def create_order(self, order_data):
        order = self.save_order(order_data)
        
        # Publish order created event
        self.publisher.publish(
            'order.created',
            {
                'order_id': order.id,
                'user_id': order.user_id,
                'amount': order.total,
                'items': order.items
            }
        )
        
        return order

# Inventory Service - Consumes events
class InventoryService:
    def __init__(self):
        self.subscriber = EventSubscriber(['order.created'])
        self.subscriber.consume(self.handle_order_created)
    
    def handle_order_created(self, ch, method, properties, body):
        event = json.loads(body)
        
        # Reserve inventory
        for item in event['items']:
            self.reserve_inventory(
                item['product_id'],
                item['quantity']
            )
        
        # Publish inventory reserved event
        publisher.publish(
            'inventory.reserved',
            {'order_id': event['order_id']}
        )
```

## Best Practices

1. **Always use durable queues and messages**
2. **Implement proper error handling and DLQs**
3. **Use prefetch_count for fair dispatch**
4. **Monitor queue lengths and consumer lag**
5. **Use connection pooling**
6. **Implement idempotent message processing**
7. **Use correlation IDs for request-response**
8. **Set appropriate message TTLs**

## Conclusion

RabbitMQ enables robust event-driven architectures:
- Decouple services with messaging
- Scale independently
- Handle failures gracefully
- Process asynchronously

Start with simple direct exchanges, then evolve to topic exchanges as your system grows. The patterns shown here handle millions of messages per day in production.

---

*Event-driven patterns with RabbitMQ 3.6, reflecting best practices from mid-2016.*

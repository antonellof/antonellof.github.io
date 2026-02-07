---
layout: post
title: "Message Queue Patterns: Fan-out, Priority Queues, and Dead Letter Queues"
date: 2019-10-15
categories: [Architecture]
tags: [Message Queues, Patterns, Architecture]
excerpt: "Implement advanced message queue patterns: fan-out, priority queues, dead letter queues, and message ordering. Learn production patterns for reliable message processing."
---

Message queues enable reliable asynchronous processing. After implementing various queue patterns in production, here are the patterns that work.

## Fan-Out Pattern

### One Producer, Multiple Consumers

```javascript
// Producer
const sns = require('aws-sdk').SNS();
const sqs = require('aws-sdk').SQS();

// Publish to SNS topic
await sns.publish({
    TopicArn: 'arn:aws:sns:us-east-1:123456789:order-events',
    Message: JSON.stringify({
        event: 'order.created',
        orderId: '123',
        userId: '456',
        total: 99.99
    })
}).promise();

// Multiple SQS queues subscribe to topic
// - order-processing queue
// - email-notification queue
// - analytics-tracking queue
```

### Implementation

```javascript
// Subscribe queues to topic
const queues = [
    'order-processing',
    'email-notification',
    'analytics-tracking'
];

for (const queueName of queues) {
    const queueUrl = await sqs.getQueueUrl({ QueueName: queueName }).promise();
    const queueArn = await sqs.getQueueAttributes({
        QueueUrl: queueUrl.QueueUrl,
        AttributeNames: ['QueueArn']
    }).promise();
    
    await sns.subscribe({
        TopicArn: topicArn,
        Protocol: 'sqs',
        Endpoint: queueArn.Attributes.QueueArn
    }).promise();
}
```

## Priority Queues

### RabbitMQ Priority

```javascript
const amqp = require('amqplib');

const connection = await amqp.connect('amqp://localhost');
const channel = await connection.createChannel();

// Declare priority queue
await channel.assertQueue('priority-queue', {
    arguments: {
        'x-max-priority': 10
    }
});

// Publish with priority
await channel.sendToQueue('priority-queue', Buffer.from(JSON.stringify({
    task: 'process-payment',
    priority: 9 // High priority
})), {
    priority: 9
});

// Consumer
channel.consume('priority-queue', (msg) => {
    const task = JSON.parse(msg.content.toString());
    console.log('Processing:', task);
    channel.ack(msg);
}, { noAck: false });
```

### SQS FIFO Priority

```javascript
// Use message group ID for ordering
// Use message deduplication ID for deduplication

await sqs.sendMessage({
    QueueUrl: fifoQueueUrl,
    MessageBody: JSON.stringify({
        task: 'process-payment',
        priority: 'high'
    }),
    MessageGroupId: 'payments', // Same group = ordered
    MessageDeduplicationId: `payment-${orderId}`, // Deduplication
    MessageAttributes: {
        Priority: {
            DataType: 'String',
            StringValue: 'high'
        }
    }
}).promise();
```

## Dead Letter Queues

### Setup DLQ

```javascript
// Create DLQ
const dlqResponse = await sqs.createQueue({
    QueueName: 'order-processing-dlq'
}).promise();

const dlqArn = await sqs.getQueueAttributes({
    QueueUrl: dlqResponse.QueueUrl,
    AttributeNames: ['QueueArn']
}).promise();

// Configure main queue with DLQ
await sqs.setQueueAttributes({
    QueueUrl: mainQueueUrl,
    Attributes: {
        RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn.Attributes.QueueArn,
            maxReceiveCount: 3 // Move to DLQ after 3 failures
        })
    }
}).promise();
```

### Process DLQ

```javascript
async function processDLQ() {
    while (true) {
        const messages = await sqs.receiveMessage({
            QueueUrl: dlqQueueUrl,
            MaxNumberOfMessages: 10
        }).promise();
        
        if (!messages.Messages) {
            await sleep(5000);
            continue;
        }
        
        for (const message of messages.Messages) {
            // Log for manual review
            console.error('Failed message:', message.Body);
            
            // Or retry after fixing issue
            // await republishToMainQueue(message);
            
            await sqs.deleteMessage({
                QueueUrl: dlqQueueUrl,
                ReceiptHandle: message.ReceiptHandle
            }).promise();
        }
    }
}
```

## Message Ordering

### FIFO Queue

```javascript
// SQS FIFO queue maintains order within message group
await sqs.sendMessage({
    QueueUrl: fifoQueueUrl,
    MessageBody: JSON.stringify({ step: 1 }),
    MessageGroupId: 'order-123' // Same group = ordered
}).promise();

await sqs.sendMessage({
    QueueUrl: fifoQueueUrl,
    MessageBody: JSON.stringify({ step: 2 }),
    MessageGroupId: 'order-123' // Processed after step 1
}).promise();
```

### RabbitMQ Single Active Consumer

```javascript
// Only one consumer processes messages
await channel.assertQueue('ordered-queue', {
    arguments: {
        'x-single-active-consumer': true
    }
});
```

## Retry Patterns

### Exponential Backoff

```javascript
async function processMessage(message, retryCount = 0) {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second
    
    try {
        await processOrder(message);
        return; // Success
    } catch (error) {
        if (retryCount >= maxRetries) {
            // Move to DLQ
            await sendToDLQ(message, error);
            return;
        }
        
        // Exponential backoff
        const delay = baseDelay * Math.pow(2, retryCount);
        await sleep(delay);
        
        // Retry
        return processMessage(message, retryCount + 1);
    }
}
```

### SQS Visibility Timeout

```javascript
// Extend visibility timeout for long-running tasks
await sqs.changeMessageVisibility({
    QueueUrl: queueUrl,
    ReceiptHandle: message.ReceiptHandle,
    VisibilityTimeout: 600 // 10 minutes
}).promise();
```

## Batch Processing

### Batch Messages

```javascript
// Send batch
const entries = messages.map((msg, index) => ({
    Id: `msg-${index}`,
    MessageBody: JSON.stringify(msg)
}));

await sqs.sendMessageBatch({
    QueueUrl: queueUrl,
    Entries: entries
}).promise();

// Receive batch
const response = await sqs.receiveMessage({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10 // Batch size
}).promise();

// Process batch
for (const message of response.Messages) {
    await processMessage(message);
    await sqs.deleteMessage({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle
    }).promise();
}
```

## Message Filtering

### SNS Message Filtering

```javascript
// Subscribe with filter
await sns.subscribe({
    TopicArn: topicArn,
    Protocol: 'sqs',
    Endpoint: queueArn,
    Attributes: {
        FilterPolicy: JSON.stringify({
            event_type: ['order.created', 'order.updated'],
            priority: ['high']
        })
    }
}).promise();
```

### RabbitMQ Headers Exchange

```javascript
// Publish with headers
await channel.publish('headers-exchange', '', Buffer.from(message), {
    headers: {
        event_type: 'order.created',
        priority: 'high'
    }
});

// Bind queue with headers
await channel.bindQueue('order-queue', 'headers-exchange', '', {
    'x-match': 'all', // All headers must match
    event_type: 'order.created',
    priority: 'high'
});
```

## Best Practices

1. **Use DLQs** - Handle failed messages
2. **Implement retries** - With exponential backoff
3. **Set visibility timeout** - Based on processing time
4. **Use batching** - Reduce API calls
5. **Monitor queue depth** - Alert on backlog
6. **Use message attributes** - For filtering
7. **Idempotent processing** - Handle duplicates
8. **Order when needed** - Use FIFO queues

## Conclusion

Message queue patterns enable:
- Reliable processing
- Scalable architecture
- Error handling
- Flexible routing

Use fan-out for broadcasting, priority queues for ordering, and DLQs for failures. The patterns shown here handle production workloads.

---

*Message queue patterns from October 2019, covering production patterns.*

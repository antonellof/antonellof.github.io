---
layout: post
title: "Message Queue Patterns: Fan-out, Priority Queues, and Dead Letter Queues"
date: 2019-10-09
categories: [Architecture]
tags: [Message Queues, Patterns, Architecture]
excerpt: "Message queues are where your architecture goes to become asynchronous — or to hide failures until 3 AM. These are the patterns that kept our production systems honest."
---

The first time I felt like a real distributed systems engineer was not when I deployed Kubernetes. It was when I watched a dead letter queue fill up at 2 AM and realized my "fire and forget" email job had been silently failing for six hours.

Message queues are the duct tape of scalable architecture — unglamorous, essential, and catastrophic when applied incorrectly. They decouple services, absorb traffic spikes, and let you process work asynchronously. They also introduce an entirely new category of bugs: messages that disappear, messages that process twice, messages that sit in a queue forever while your on-call pager gently weeps.

After running SQS, SNS, and RabbitMQ in production across order processing, notifications, and analytics pipelines, these are the patterns that actually worked — and the ones that taught expensive lessons.

## Fan-Out: One Event, Many Reactions

The most common queue mistake is building a single worker that does everything. Order created? Update inventory, send email, track analytics, notify the warehouse, update search index. One message, one consumer, one very long processing chain that fails halfway through and leaves you wondering which steps completed.

Fan-out fixes this. One event publishes to a topic. Multiple independent consumers react.

### Publishing the Event

```javascript
const sns = require('aws-sdk').SNS();
const sqs = require('aws-sdk').SQS();

await sns.publish({
    TopicArn: 'arn:aws:sns:us-east-1:123456789:order-events',
    Message: JSON.stringify({
        event: 'order.created',
        orderId: '123',
        userId: '456',
        total: 99.99
    })
}).promise();

// Multiple SQS queues subscribe to this topic:
// - order-processing (inventory, fulfillment)
// - email-notification (confirmation email)
// - analytics-tracking (revenue metrics)
```

Each queue has its own consumer, its own retry policy, its own failure domain. Email service down? Orders still process. Analytics lagging? Customers still get confirmation emails.

### Wiring the Subscriptions

```javascript
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

The lesson fan-out taught us: **decouple by failure domain, not just by service.** Group work that can fail together, separate work that shouldn't.

## Priority Queues: When Not All Messages Are Equal

A payment retry and a weekly newsletter digest should not wait in the same line. Priority queues let urgent work jump ahead — with caveats that vary by broker.

### RabbitMQ Native Priority

```javascript
const amqp = require('amqplib');

const connection = await amqp.connect('amqp://localhost');
const channel = await connection.createChannel();

await channel.assertQueue('priority-queue', {
    arguments: {
        'x-max-priority': 10
    }
});

await channel.sendToQueue('priority-queue', Buffer.from(JSON.stringify({
    task: 'process-payment',
    priority: 9
})), {
    priority: 9
});

channel.consume('priority-queue', (msg) => {
    const task = JSON.parse(msg.content.toString());
    console.log('Processing:', task);
    channel.ack(msg);
}, { noAck: false });
```

RabbitMQ priority queues work well for moderate volumes with clear priority levels. The `x-max-priority` setting defines the range (0–10 here). Higher priority messages dequeue first.

The trap: if high-priority messages arrive faster than you process them, low-priority messages starve indefinitely. Monitor your queue depth per priority level, not just total depth.

### SQS FIFO: Ordering Over Priority

SQS doesn't have native priority queues. The workaround in 2019 was separate queues by priority tier, or FIFO queues with message groups:

```javascript
await sqs.sendMessage({
    QueueUrl: fifoQueueUrl,
    MessageBody: JSON.stringify({
        task: 'process-payment',
        priority: 'high'
    }),
    MessageGroupId: 'payments',
    MessageDeduplicationId: `payment-${orderId}`,
    MessageAttributes: {
        Priority: {
            DataType: 'String',
            StringValue: 'high'
        }
    }
}).promise();
```

`MessageGroupId` ensures ordering within a group (all payments process in order). `MessageDeduplicationId` prevents duplicate processing in the 5-minute deduplication window. For true priority with SQS, most teams ran separate high-priority and low-priority queues with different consumer counts.

## Dead Letter Queues: Where Failed Messages Go to Be Judged

A message fails processing. Your consumer retries. It fails again. Without a dead letter queue (DLQ), one poison message blocks the entire queue — or gets retried until the heat death of the universe.

DLQs are the safety valve. After N failed attempts, the message moves to a separate queue for inspection, manual retry, or dignified deletion.

### Setting Up a DLQ

```javascript
const dlqResponse = await sqs.createQueue({
    QueueName: 'order-processing-dlq'
}).promise();

const dlqArn = await sqs.getQueueAttributes({
    QueueUrl: dlqResponse.QueueUrl,
    AttributeNames: ['QueueArn']
}).promise();

await sqs.setQueueAttributes({
    QueueUrl: mainQueueUrl,
    Attributes: {
        RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn.Attributes.QueueArn,
            maxReceiveCount: 3
        })
    }
}).promise();
```

`maxReceiveCount: 3` means three failed processing attempts before the message moves to the DLQ. Tune this based on your retry strategy — too low and transient failures become DLQ noise; too high and poison messages waste compute.

### Processing the DLQ

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
            console.error('Failed message:', message.Body);
            
            // Option A: Log and delete (manual investigation)
            // Option B: Fix the bug, then republish to main queue
            
            await sqs.deleteMessage({
                QueueUrl: dlqQueueUrl,
                ReceiptHandle: message.ReceiptHandle
            }).promise();
        }
    }
}
```

The DLQ is not a graveyard — it's a triage ward. Alert when DLQ depth exceeds zero. A growing DLQ means something is systematically broken, not randomly flaky. We learned this after ignoring a DLQ for two days and discovering 4,000 failed payment confirmations.

## Message Ordering: When Sequence Matters

Most queue workloads don't need strict ordering. When they do — payment steps, state machine transitions, inventory deductions — getting it wrong causes data corruption that's painful to untangle.

### SQS FIFO Queues

```javascript
await sqs.sendMessage({
    QueueUrl: fifoQueueUrl,
    MessageBody: JSON.stringify({ step: 1 }),
    MessageGroupId: 'order-123'
}).promise();

await sqs.sendMessage({
    QueueUrl: fifoQueueUrl,
    MessageBody: JSON.stringify({ step: 2 }),
    MessageGroupId: 'order-123'
}).promise();
```

Messages with the same `MessageGroupId` process in order. Different groups process in parallel. This gives you per-entity ordering without sacrificing overall throughput.

The cost: FIFO queues have lower throughput limits (3,000 messages/second with batching in 2019) and cost more. Use them only where ordering is a hard requirement, not a nice-to-have.

### RabbitMQ Single Active Consumer

```javascript
await channel.assertQueue('ordered-queue', {
    arguments: {
        'x-single-active-consumer': true
    }
});
```

Only one consumer processes messages at a time, preserving strict order. Simpler than FIFO message groups, but you're sacrificing parallelism entirely. Fine for low-volume ordered workflows. Terrible for high-throughput pipelines.

## Retry Patterns: Failing Gracefully (Not Infinitely)

### Exponential Backoff

```javascript
async function processMessage(message, retryCount = 0) {
    const maxRetries = 3;
    const baseDelay = 1000;
    
    try {
        await processOrder(message);
        return;
    } catch (error) {
        if (retryCount >= maxRetries) {
            await sendToDLQ(message, error);
            return;
        }
        
        const delay = baseDelay * Math.pow(2, retryCount);
        await sleep(delay);
        
        return processMessage(message, retryCount + 1);
    }
}
```

Exponential backoff (1s, 2s, 4s) prevents a failing downstream service from getting hammered by retry storms. The queue absorbs the delay; the downstream service gets breathing room to recover.

Combine this with jitter in production — `delay + Math.random() * 1000` — so retries don't synchronize into thundering herds.

### SQS Visibility Timeout

```javascript
await sqs.changeMessageVisibility({
    QueueUrl: queueUrl,
    ReceiptHandle: message.ReceiptHandle,
    VisibilityTimeout: 600
}).promise();
```

When processing takes longer than the queue's visibility timeout, another consumer picks up the same message. Now you're processing it twice. For long-running jobs, extend visibility timeout during processing, or use a heartbeat pattern that periodically resets it.

We debugged a "duplicate charge" incident for three days before realizing the visibility timeout was 30 seconds and payment processing averaged 45.

## Batch Processing: Fewer API Calls, More Throughput

```javascript
const entries = messages.map((msg, index) => ({
    Id: `msg-${index}`,
    MessageBody: JSON.stringify(msg)
}));

await sqs.sendMessageBatch({
    QueueUrl: queueUrl,
    Entries: entries
}).promise();

const response = await sqs.receiveMessage({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10
}).promise();

for (const message of response.Messages) {
    await processMessage(message);
    await sqs.deleteMessage({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle
    }).promise();
}
```

SQS batch operations handle up to 10 messages per call. At scale, the API cost savings are significant. RabbitMQ supports batch publishing via publisher confirms.

The trade-off: batch processing complicates error handling. If one message in a batch fails, what happens to the other nine? Design for partial batch failure — process individually, ack individually.

## Message Filtering: Not Every Consumer Needs Everything

### SNS Subscription Filters

```javascript
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

Filter at the subscription level so consumers only receive relevant messages. Without filtering, every queue gets every event, and your analytics consumer is parsing payment failure messages it will never act on.

### RabbitMQ Headers Exchange

```javascript
await channel.publish('headers-exchange', '', Buffer.from(message), {
    headers: {
        event_type: 'order.created',
        priority: 'high'
    }
});

await channel.bindQueue('order-queue', 'headers-exchange', '', {
    'x-match': 'all',
    event_type: 'order.created',
    priority: 'high'
});
```

Header-based routing gives fine-grained control in RabbitMQ. More flexible than SNS filter policies, more complex to configure.

## What Keeps Queue-Based Systems Healthy

Dead letter queues are non-negotiable — if you don't have one, failed messages either block your queue or vanish. Every queue needs a DLQ, and every DLQ needs an alert when depth is greater than zero.

Retries need exponential backoff with jitter, not immediate hammering of a failing downstream service. Set visibility timeouts longer than your p99 processing time, and extend them for genuinely long-running jobs.

Monitor queue depth, not just consumer health. A consumer that's "running" but processing slower than messages arrive will eventually drown. Alert on age of oldest message, not just queue length.

Make every handler idempotent. At-least-once delivery means duplicates will happen — design for it with idempotency keys, deduplication tables, or natural idempotency in your business logic. "Process payment for order-123" should be safe to run twice.

Use batching at scale to reduce API costs, but handle partial failures explicitly. Add message attributes for routing and filtering — stuffing metadata in the JSON body works until you need SNS filter policies.

Reach for FIFO ordering only when sequence is a hard requirement. Strict ordering costs throughput. Most workflows tolerate eventual consistency fine.

## Putting It Together

A production-ready queue architecture in 2019 looked something like this:

1. **SNS topic** for event fan-out
2. **Filtered SQS queues** per consumer domain
3. **DLQ on every queue** with CloudWatch alarms
4. **Exponential backoff** with max retry limits
5. **Idempotent consumers** that handle duplicates gracefully
6. **FIFO queues** only for workflows where order is critical
7. **Batch processing** for high-volume producers and consumers

Message queues won't make your system reliable by themselves. They give you the primitives — decoupling, buffering, retry, routing — to build reliability on top of. The patterns above are how you use those primitives without creating new categories of 2 AM emergencies.

The next time your queue depth graph spikes, you'll know whether it's a traffic surge (good problem) or a poison message in a DLQ you forgot to monitor (bad problem, but at least now you have a DLQ to check).

---

*Written October 2019, covering message queue patterns with AWS SQS/SNS and RabbitMQ. Managed queue services have evolved since (SQS FIFO improvements, Kafka adoption for event streaming), but fan-out, DLQs, retry backoff, and idempotent consumers remain foundational patterns.*

---
layout: post
title: "Building Event-Driven Microservices with AWS SNS and SQS"
date: 2018-03-07
categories: [Architecture]
tags: [AWS, SNS, SQS, Event-Driven, Microservices]
excerpt: "Our order service didn't need to know about email, inventory, or analytics. It needed to shout 'order created' and get on with its life. SNS and SQS made that possible."
---

The order service was getting fat.

Every time someone placed an order, we updated inventory, sent a confirmation email, pushed data to analytics, and triggered a fraud check. All synchronous. All in the same request handler. When the email provider slowed down, orders slowed down. When analytics threw an error, orders failed. The order service had become a distributed monolith one HTTP call at a time.

The fix wasn't more try/catch blocks. It was admitting that most of those operations didn't need to happen *before* we told the customer "your order is confirmed." They needed to happen *eventually*, and they didn't need to know about each other.

AWS SNS and SQS gave us a way to decouple all of it. The order service publishes an event. Everything else reacts on its own schedule. This is how we built that architecture—and what we learned when messages started piling up at 3 AM.

## SNS and SQS: The Pub/Sub Sandwich

These two services work together constantly, but they do different jobs:

**SNS (Simple Notification Service)** is the broadcaster. You publish a message to a topic, and SNS pushes copies to every subscriber. One event, many recipients. Think of it as a megaphone.

**SQS (Simple Queue Service)** is the inbox. Messages sit in a queue until a consumer pulls them out and processes them. Pull-based, buffered, guaranteed delivery (with the right configuration). Think of it as a to-do list that doesn't lose items when your server restarts.

The pattern that ties them together:

```
Service A → SNS Topic → SQS Queues → Services B, C, D
```

Service A publishes once. SNS fans out to multiple SQS queues. Each downstream service has its own queue, its own processing speed, its own failure handling. The order service doesn't wait for any of them.

## Setting Up the Broadcast: SNS Topics

### Creating a Topic

```python
import boto3

sns = boto3.client('sns')

# Create topic
topic_response = sns.create_topic(Name='order-events')
topic_arn = topic_response['TopicArn']

print(f"Topic ARN: {topic_arn}")
```

One topic per event domain. `order-events`, not `everything-that-happens`. You'll want to filter and subscribe selectively, and a grab-bag topic makes that painful.

### Publishing Events

The order service's job is simple: something happened, here's the payload.

```python
def publish_order_created(order_id, user_id, amount):
    sns = boto3.client('sns')
    
    message = {
        'event': 'order.created',
        'order_id': order_id,
        'user_id': user_id,
        'amount': amount,
        'timestamp': datetime.utcnow().isoformat()
    }
    
    response = sns.publish(
        TopicArn='arn:aws:sns:us-east-1:123456789:order-events',
        Message=json.dumps(message),
        MessageAttributes={
            'event_type': {
                'DataType': 'String',
                'StringValue': 'order.created'
            }
        }
    )
    
    return response['MessageId']
```

Message attributes are worth the extra lines. They let SNS filter which subscribers receive which messages, so your analytics service doesn't wake up for every `order.cancelled` event if it only cares about creations.

A few rules we learned the hard way: keep payloads small (reference IDs, not full objects), include a timestamp, and make events past-tense (`order.created`, not `create.order`). Events describe things that already happened.

## Setting Up the Inboxes: SQS Queues

### Creating a Queue

```python
sqs = boto3.client('sqs')

# Create queue
queue_response = sqs.create_queue(
    QueueName='order-processing',
    Attributes={
        'VisibilityTimeout': '300',  # 5 minutes
        'MessageRetentionPeriod': '1209600',  # 14 days
        'ReceiveMessageWaitTimeSeconds': '20'  # Long polling
    }
)

queue_url = queue_response['QueueUrl']
```

**Visibility timeout** is the big one. When a consumer picks up a message, it becomes invisible to other consumers for this duration. Set it longer than your worst-case processing time. Set it too short, and another consumer will pick up the same message while the first is still working on it. Ask me how I know.

**Long polling** (`ReceiveMessageWaitTimeSeconds: 20`) means SQS waits up to 20 seconds for a message to arrive instead of returning empty immediately. Fewer API calls, lower cost, less CPU spent on "nope, nothing yet" loops.

### Wiring SNS to SQS

This is the step everyone forgets the permissions for:

```python
# Get queue ARN
queue_attrs = sqs.get_queue_attributes(
    QueueUrl=queue_url,
    AttributeNames=['QueueArn']
)
queue_arn = queue_attrs['Attributes']['QueueArn']

# Subscribe queue to SNS topic
sns.subscribe(
    TopicArn='arn:aws:sns:us-east-1:123456789:order-events',
    Protocol='sqs',
    Endpoint=queue_arn
)

# Grant SNS permission to send to queue
sqs_policy = {
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "sns.amazonaws.com"},
        "Action": "sqs:SendMessage",
        "Resource": queue_arn,
        "Condition": {
            "ArnEquals": {
                "aws:SourceArn": "arn:aws:sns:us-east-1:123456789:order-events"
            }
        }
    }]
}

sqs.set_queue_attributes(
    QueueUrl=queue_url,
    Attributes={'Policy': json.dumps(sqs_policy)}
)
```

Without that queue policy, SNS publishes into the void. Messages go nowhere. You stare at an empty queue wondering why event-driven architecture is supposed to be better. The policy is not optional.

## The Consumer: Where Messages Become Actions

### Polling and Processing

```python
import boto3
import json
from botocore.exceptions import ClientError

sqs = boto3.client('sqs')
queue_url = 'https://sqs.us-east-1.amazonaws.com/123456789/order-processing'

def process_messages():
    while True:
        try:
            # Receive messages (long polling)
            response = sqs.receive_message(
                QueueUrl=queue_url,
                MaxNumberOfMessages=10,
                WaitTimeSeconds=20,
                MessageAttributeNames=['All']
            )
            
            messages = response.get('Messages', [])
            
            if not messages:
                continue
            
            for message in messages:
                try:
                    # Parse SNS message wrapper
                    sns_message = json.loads(message['Body'])
                    event_data = json.loads(sns_message['Message'])
                    
                    # Process event
                    handle_event(event_data)
                    
                    # Delete message only after successful processing
                    sqs.delete_message(
                        QueueUrl=queue_url,
                        ReceiptHandle=message['ReceiptHandle']
                    )
                    
                except Exception as e:
                    print(f"Error processing message: {e}")
                    # Message becomes visible again after visibility timeout
                    
        except ClientError as e:
            print(f"AWS error: {e}")
            time.sleep(5)

def handle_event(event_data):
    event_type = event_data['event']
    
    if event_type == 'order.created':
        process_order_created(event_data)
    elif event_type == 'order.cancelled':
        process_order_cancelled(event_data)
    else:
        print(f"Unknown event type: {event_type}")
```

Two layers of JSON parsing—welcome to SNS-to-SQS. The outer body is the SNS notification wrapper; the inner `Message` field is your actual event payload. You'll write a helper function for this approximately once and then copy it into every service forever.

The critical rule: **delete the message only after successful processing**. If you delete before processing finishes and then crash, that message is gone. If you don't delete after processing, the message comes back after the visibility timeout. The latter is annoying; the former is data loss.

## Dead Letter Queues: The Safety Net

Some messages will never succeed. Bad data, code bugs, downstream services that permanently reject certain payloads. Without a dead letter queue, those messages cycle forever—consuming processing capacity and polluting your logs.

### Setting Up a DLQ

```python
# Create DLQ
dlq_response = sqs.create_queue(
    QueueName='order-processing-dlq'
)
dlq_arn = sqs.get_queue_attributes(
    QueueUrl=dlq_response['QueueUrl'],
    AttributeNames=['QueueArn']
)['Attributes']['QueueArn']

# Configure main queue to redirect failures
sqs.set_queue_attributes(
    QueueUrl=queue_url,
    Attributes={
        'RedrivePolicy': json.dumps({
            'deadLetterTargetArn': dlq_arn,
            'maxReceiveCount': 3  # Move to DLQ after 3 failures
        })
    }
)
```

After three failed processing attempts, the message moves to the DLQ. It stops cycling. You can inspect it, fix the bug, and decide whether to replay it.

### Processing the DLQ

```python
def process_dlq():
    dlq_url = 'https://sqs.us-east-1.amazonaws.com/123456789/order-processing-dlq'
    
    while True:
        response = sqs.receive_message(
            QueueUrl=dlq_url,
            MaxNumberOfMessages=10
        )
        
        messages = response.get('Messages', [])
        
        for message in messages:
            # Log for manual review
            log_failed_message(message)
            
            # Or retry after fixing the underlying issue
            # republish_to_main_queue(message)
            
            sqs.delete_message(
                QueueUrl=dlq_url,
                ReceiptHandle=message['ReceiptHandle']
            )
```

Set a CloudWatch alarm on DLQ depth. A growing DLQ is a growing to-do list of things your system couldn't handle. You want to know about that before a customer does.

## Filtering: Not Every Service Needs Every Event

### SNS Subscription Filters

```python
# Subscribe with filter—only order.created and order.updated
sns.subscribe(
    TopicArn='arn:aws:sns:us-east-1:123456789:order-events',
    Protocol='sqs',
    Endpoint=queue_arn,
    Attributes={
        'FilterPolicy': json.dumps({
            'event_type': ['order.created', 'order.updated']
        })
    }
)
```

This is why you added `MessageAttributes` when publishing. SNS filters before delivery, so unwanted messages never hit the queue. Cheaper and cleaner than having every consumer ignore events it doesn't care about.

## Fan-Out: One Event, Many Services

The whole point of this architecture:

```python
# One SNS topic
topic_arn = 'arn:aws:sns:us-east-1:123456789:order-events'

# Multiple SQS queues—one per downstream service
queues = [
    'order-processing',
    'inventory-update',
    'email-notification',
    'analytics-tracking'
]

# Subscribe all queues
for queue_name in queues:
    queue_url = sqs.get_queue_url(QueueName=queue_name)['QueueUrl']
    queue_arn = sqs.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=['QueueArn']
    )['Attributes']['QueueArn']
    
    sns.subscribe(
        TopicArn=topic_arn,
        Protocol='sqs',
        Endpoint=queue_arn
    )
```

Add a new downstream service? Create a queue, subscribe it, deploy a consumer. The order service doesn't change. The SNS topic doesn't change. This is the decoupling you were buying.

## Error Handling That Actually Works

### Retry with Backoff

```python
def process_with_retry(message, max_retries=3):
    for attempt in range(max_retries):
        try:
            handle_event(message)
            return True
        except TransientError as e:
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # Exponential backoff
                continue
            else:
                raise
        except PermanentError as e:
            # Don't retry permanent errors—send to DLQ
            log_error(e)
            return False
    
    return False
```

Distinguish transient failures (network timeout, downstream 503) from permanent ones (invalid payload, unknown event type). Retrying a permanent failure is how you get messages that cycle until the heat death of the universe.

### Extending Visibility Timeout

For long-running tasks, the default visibility timeout might not be enough:

```python
# Extend visibility timeout for long-running tasks
sqs.change_message_visibility(
    QueueUrl=queue_url,
    ReceiptHandle=message['ReceiptHandle'],
    VisibilityTimeout=600  # 10 minutes
)
```

Call this periodically during processing if your task might exceed the original timeout. Otherwise another consumer will pick up the same message and you'll process it twice. Which brings us to the most important rule.

### Idempotency: Assume Duplicates Will Happen

At-least-once delivery means you *will* process the same message more than once. Network timeouts cause redelivery. Visibility timeout extensions fail. Consumers crash after processing but before deleting.

Design every handler to be idempotent. Use the `order_id` as a deduplication key. Check if you've already processed this event before acting. Your database unique constraints are your friend here.

## Monitoring: The 3 AM Wake-Up Call

### Custom Metrics

```python
import boto3

cloudwatch = boto3.client('cloudwatch')

def publish_metric(metric_name, value, unit='Count'):
    cloudwatch.put_metric_data(
        Namespace='OrderProcessing',
        MetricData=[{
            'MetricName': metric_name,
            'Value': value,
            'Unit': unit,
            'Timestamp': datetime.utcnow()
        }]
    )

# Track processing
publish_metric('MessagesProcessed', 1)
publish_metric('ProcessingDuration', duration_ms, 'Milliseconds')
```

### Alarms That Matter

```python
cloudwatch.put_metric_alarm(
    AlarmName='HighDLQMessages',
    ComparisonOperator='GreaterThanThreshold',
    EvaluationPeriods=1,
    MetricName='ApproximateNumberOfMessagesVisible',
    Namespace='AWS/SQS',
    Period=300,
    Statistic='Average',
    Threshold=100.0,
    ActionsEnabled=True,
    AlarmActions=['arn:aws:sns:us-east-1:123456789:alerts']
)
```

Watch three things: queue depth (messages backing up), DLQ depth (messages failing), and consumer lag (time between publish and process). Queue depth growing means your consumers can't keep up—scale them or optimize processing. DLQ depth growing means something is broken—fix the code or the data.

Yes, we use SNS to alert about SQS problems. It's SNS all the way down.

## Lessons From Production

**Use long polling.** The difference between short polling and long polling is the difference between asking "anything yet?" every second versus waiting patiently. Your AWS bill and your CPU will thank you.

**Set visibility timeout based on actual processing time.** Measure P99 processing duration, add buffer, set the timeout. Don't guess.

**Implement DLQs from day one.** Adding a DLQ after messages have been cycling for a month means wading through a backlog of poison messages. Start with the safety net.

**Use message attributes for filtering.** They're cheap, they're effective, and they keep irrelevant messages out of queues entirely.

**Monitor queue depth.** A queue that's growing is a consumer that's falling behind. Catch it at 1,000 messages, not 100,000.

**Batch when you can.** `MaxNumberOfMessages=10` amortizes the API call cost. Process in batches if your handler supports it.

**Design for at-least-once delivery.** Idempotency isn't optional. It's the cost of admission for distributed messaging.

**Use FIFO queues when order matters.** Standard queues guarantee at-least-once delivery with best-effort ordering. FIFO queues guarantee exactly-once processing and strict ordering—at the cost of lower throughput. Payment processing? FIFO. Analytics tracking? Standard.

## The Payoff

SNS and SQS won't make your distributed system simple. Distributed systems aren't simple. But they make it *honest*—each service owns its failure modes, processes at its own pace, and doesn't cascade failures to its neighbors.

Our order service went from 800ms p99 (waiting on email and analytics) to 120ms (publish event, return confirmation). Email failures stopped killing orders. We added two new downstream services without touching the order service at all.

Start with one topic, one queue, one consumer. Get the publish-process-delete loop working. Add a DLQ. Add monitoring. Then fan out.

The patterns here handled millions of messages a month for us. They're not exotic—they're the baseline for event-driven microservices on AWS.

---

*Written in March 2018, covering production patterns with AWS SNS and SQS. SQS FIFO queues and SNS message filtering were available at this time; Kinesis and EventBridge would later offer alternative paths for high-volume streaming and event routing.*

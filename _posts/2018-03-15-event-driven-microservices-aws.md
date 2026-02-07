---
layout: post
title: "Building Event-Driven Microservices with AWS SNS and SQS"
date: 2018-03-15
categories: [Architecture]
tags: [AWS, SNS, SQS, Event-Driven, Microservices]
excerpt: "Architect event-driven microservices using AWS SNS and SQS for pub/sub messaging, covering topics, queues, dead-letter queues, and real-world patterns."
---

Event-driven microservices on AWS use SNS (Simple Notification Service) and SQS (Simple Queue Service). After building production systems with these services, here's how to architect them effectively.

## AWS Messaging Services

### SNS (Pub/Sub)
- Topics for broadcasting
- Multiple subscribers
- Push-based delivery

### SQS (Queues)
- Message queues
- Pull-based delivery
- Guaranteed delivery

## Architecture Pattern

```
Service A → SNS Topic → SQS Queues → Services B, C, D
```

## SNS Topics

### Create Topic

```python
import boto3

sns = boto3.client('sns')

# Create topic
topic_response = sns.create_topic(Name='order-events')
topic_arn = topic_response['TopicArn']

print(f"Topic ARN: {topic_arn}")
```

### Publish Message

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

## SQS Queues

### Create Queue

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

### Subscribe Queue to SNS

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

## Consumer Implementation

### Poll Messages

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
                WaitTimeSeconds=20,  # Long polling
                MessageAttributeNames=['All']
            )
            
            messages = response.get('Messages', [])
            
            if not messages:
                continue
            
            for message in messages:
                try:
                    # Parse SNS message
                    sns_message = json.loads(message['Body'])
                    event_data = json.loads(sns_message['Message'])
                    
                    # Process event
                    handle_event(event_data)
                    
                    # Delete message
                    sqs.delete_message(
                        QueueUrl=queue_url,
                        ReceiptHandle=message['ReceiptHandle']
                    )
                    
                except Exception as e:
                    print(f"Error processing message: {e}")
                    # Message will become visible again after visibility timeout
                    
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

## Dead Letter Queues

### Setup DLQ

```python
# Create DLQ
dlq_response = sqs.create_queue(
    QueueName='order-processing-dlq'
)
dlq_arn = sqs.get_queue_attributes(
    QueueUrl=dlq_response['QueueUrl'],
    AttributeNames=['QueueArn']
)['Attributes']['QueueArn']

# Configure main queue with DLQ
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

### Process DLQ

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
            
            # Or retry after fixing issue
            # republish_to_main_queue(message)
            
            sqs.delete_message(
                QueueUrl=dlq_url,
                ReceiptHandle=message['ReceiptHandle']
            )
```

## Filtering Messages

### SNS Message Filtering

```python
# Subscribe with filter
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

### SQS Message Filtering

```python
# Receive with filter
response = sqs.receive_message(
    QueueUrl=queue_url,
    MessageAttributeNames=['event_type'],
    MessageAttributeFilters={
        'event_type': {
            'StringValue': 'order.created',
            'DataType': 'String'
        }
    }
)
```

## Fan-Out Pattern

```python
# One SNS topic
topic_arn = 'arn:aws:sns:us-east-1:123456789:order-events'

# Multiple SQS queues
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

## Error Handling

### Retry Logic

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
            # Don't retry permanent errors
            log_error(e)
            return False
    
    return False
```

### Visibility Timeout

```python
# Extend visibility timeout for long-running tasks
sqs.change_message_visibility(
    QueueUrl=queue_url,
    ReceiptHandle=message['ReceiptHandle'],
    VisibilityTimeout=600  # 10 minutes
)
```

## Monitoring

### CloudWatch Metrics

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

### Alarms

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

## Best Practices

1. **Use long polling** - Reduce empty responses
2. **Set appropriate visibility timeout** - Based on processing time
3. **Implement DLQ** - Handle failed messages
4. **Use message attributes** - For filtering and routing
5. **Monitor queue depth** - Alert on backlog
6. **Batch operations** - Process multiple messages
7. **Idempotent processing** - Handle duplicates
8. **Use FIFO queues** - When order matters

## Conclusion

SNS + SQS enable:
- Decoupled microservices
- Reliable message delivery
- Scalable architecture
- AWS-native integration

Start with simple pub/sub, add filtering and DLQs as needed. The patterns shown here handle millions of messages in production.

---

*Event-driven microservices with AWS SNS/SQS from March 2018, covering production patterns.*

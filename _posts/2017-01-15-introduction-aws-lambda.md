---
layout: post
permalink: /2017/01-introduction-aws-lambda
title: "Introduction to AWS Lambda: Serverless Computing"
date: 2017-01-19
categories: [How-To]
tags: [AWS, Lambda, Serverless]
excerpt: "Learn how AWS Lambda enables you to run code without managing servers. This guide covers Lambda fundamentals, use cases, and best practices for building serverless applications."
---

# Introduction to AWS Lambda: Serverless Computing

## Introduction

In early 2017, serverless computing was beginning to transform how we think about application infrastructure. AWS Lambda, launched in 2014, had matured enough to handle production workloads. As we expanded PostPickr's architecture beyond traditional servers, Lambda became a crucial tool for handling event-driven workloads without the operational overhead of managing EC2 instances.

This article introduces AWS Lambda and shares practical lessons from our early serverless implementations.

## What is AWS Lambda?

AWS Lambda is a compute service that runs your code in response to events without requiring you to provision or manage servers. You pay only for the compute time you consume—there's no charge when your code isn't running.

### Key Characteristics

- **Event-driven execution** - Triggered by AWS services or HTTP requests
- **Automatic scaling** - Handles 1 or 1,000,000 requests per second
- **Pay-per-use** - Billed in 100ms increments
- **No server management** - AWS handles infrastructure
- **Multiple language support** - Node.js, Python, Java, C#, Go

## Your First Lambda Function

Let's create a simple Lambda function that processes an S3 upload event:

```javascript
// Node.js Lambda handler
exports.handler = async (event, context) => {
    console.log('Event:', JSON.stringify(event, null, 2));
    
    // Extract S3 bucket and object key from event
    const bucket = event.Records[0].s3.bucket.name;
    const key = decodeURIComponent(
        event.Records[0].s3.object.key.replace(/\+/g, ' ')
    );
    
    console.log(`Processing file: ${key} from bucket: ${bucket}`);
    
    try {
        // Your processing logic here
        // For example: resize image, process video, analyze document
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'File processed successfully',
                bucket: bucket,
                key: key
            })
        };
    } catch (error) {
        console.error('Error processing file:', error);
        throw error;
    }
};
```

## Lambda Execution Model

Understanding Lambda's execution model is crucial:

### Handler Function

Every Lambda has a handler function—the entry point for execution:

```javascript
exports.handler = async (event, context) => {
    // event: Contains data about the triggering event
    // context: Provides runtime information
    
    return {
        statusCode: 200,
        body: 'Response body'
    };
};
```

### Event Object

The `event` object structure varies by trigger source:

```javascript
// API Gateway Event
{
    "httpMethod": "POST",
    "path": "/users",
    "headers": { "Content-Type": "application/json" },
    "body": "{\"name\":\"John\"}"
}

// S3 Event
{
    "Records": [{
        "s3": {
            "bucket": { "name": "my-bucket" },
            "object": { "key": "image.jpg" }
        }
    }]
}

// DynamoDB Stream Event
{
    "Records": [{
        "eventName": "INSERT",
        "dynamodb": {
            "NewImage": { "id": { "S": "123" } }
        }
    }]
}
```

### Context Object

Provides runtime information:

```javascript
exports.handler = async (event, context) => {
    console.log('Request ID:', context.requestId);
    console.log('Function name:', context.functionName);
    console.log('Remaining time:', context.getRemainingTimeInMillis());
    console.log('Memory limit:', context.memoryLimitInMB);
    
    // Context methods
    // context.getRemainingTimeInMillis() - Time before timeout
    // context.callbackWaitsForEmptyEventLoop - Control callback behavior
};
```

## Common Use Cases

### 1. Real-Time File Processing

Process uploads immediately after they arrive in S3:

```javascript
const AWS = require('aws-sdk');
const sharp = require('sharp');

const s3 = new AWS.S3();

exports.handler = async (event) => {
    const bucket = event.Records[0].s3.bucket.name;
    const key = event.Records[0].s3.object.key;
    
    // Download image from S3
    const image = await s3.getObject({ Bucket: bucket, Key: key }).promise();
    
    // Create thumbnail using sharp
    const thumbnail = await sharp(image.Body)
        .resize(200, 200)
        .toBuffer();
    
    // Upload thumbnail back to S3
    const thumbnailKey = key.replace(/\.[^.]+$/, '_thumb.jpg');
    await s3.putObject({
        Bucket: bucket,
        Key: thumbnailKey,
        Body: thumbnail,
        ContentType: 'image/jpeg'
    }).promise();
    
    return { message: 'Thumbnail created successfully' };
};
```

### 2. API Backend

Lambda can serve as your entire API backend:

```javascript
exports.handler = async (event) => {
    const { httpMethod, path, body } = event;
    
    // Route based on HTTP method and path
    if (httpMethod === 'GET' && path === '/users') {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ users: await getUsers() })
        };
    }
    
    if (httpMethod === 'POST' && path === '/users') {
        const userData = JSON.parse(body);
        const user = await createUser(userData);
        
        return {
            statusCode: 201,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user })
        };
    }
    
    return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Not found' })
    };
};
```

### 3. Scheduled Tasks

Run cron-like jobs using CloudWatch Events:

```javascript
// Runs every hour to clean up old records
exports.handler = async (event) => {
    const AWS = require('aws-sdk');
    const dynamodb = new AWS.DynamoDB.DocumentClient();
    
    const cutoffDate = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days ago
    
    // Query items older than cutoff date
    const params = {
        TableName: 'TempRecords',
        FilterExpression: 'created_at < :cutoff',
        ExpressionAttributeValues: { ':cutoff': cutoffDate }
    };
    
    const result = await dynamodb.scan(params).promise();
    
    // Delete old items
    for (const item of result.Items) {
        await dynamodb.delete({
            TableName: 'TempRecords',
            Key: { id: item.id }
        }).promise();
    }
    
    return { deletedCount: result.Items.length };
};
```

### 4. Stream Processing

Process DynamoDB or Kinesis streams in real-time:

```javascript
exports.handler = async (event) => {
    for (const record of event.Records) {
        if (record.eventName === 'INSERT') {
            const newItem = record.dynamodb.NewImage;
            
            // Send notification
            await sendNotification({
                userId: newItem.userId.S,
                message: `New item created: ${newItem.id.S}`
            });
        }
    }
    
    return { processed: event.Records.length };
};
```

## Best Practices

### 1. Keep Functions Small and Focused

Each Lambda should do one thing well:

```javascript
// Good: Single responsibility
exports.processOrder = async (event) => {
    const order = JSON.parse(event.body);
    await validateOrder(order);
    await saveOrder(order);
    await sendConfirmation(order);
    return { success: true };
};

// Better: Break into multiple functions
exports.validateOrder = async (event) => { /* ... */ };
exports.saveOrder = async (event) => { /* ... */ };
exports.sendConfirmation = async (event) => { /* ... */ };
```

### 2. Minimize Cold Start Impact

- **Keep deployment package small** - Only include necessary dependencies
- **Use connection pooling** - Reuse database connections
- **Initialize outside handler** - Reuse across invocations

```javascript
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient(); // Initialized once

exports.handler = async (event) => {
    // Handler code - reuses dynamodb client
    const result = await dynamodb.get({
        TableName: 'Users',
        Key: { id: event.userId }
    }).promise();
    
    return result.Item;
};
```

### 3. Handle Errors Gracefully

```javascript
exports.handler = async (event) => {
    try {
        const result = await processData(event);
        return {
            statusCode: 200,
            body: JSON.stringify(result)
        };
    } catch (error) {
        console.error('Error:', error);
        
        // Return error response instead of throwing
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Internal server error',
                message: error.message
            })
        };
    }
};
```

### 4. Use Environment Variables

Store configuration in environment variables:

```javascript
const TABLE_NAME = process.env.TABLE_NAME;
const API_KEY = process.env.API_KEY;

exports.handler = async (event) => {
    const dynamodb = new AWS.DynamoDB.DocumentClient();
    
    const result = await dynamodb.get({
        TableName: TABLE_NAME,
        Key: { id: event.id }
    }).promise();
    
    return result.Item;
};
```

### 5. Set Appropriate Timeouts and Memory

- **Timeout**: Set based on expected execution time (max 15 minutes)
- **Memory**: More memory = more CPU power (128 MB to 10,240 MB)

```javascript
// In AWS Console or CloudFormation
{
    "Timeout": 30,        // 30 seconds
    "MemorySize": 512     // 512 MB
}
```

## Monitoring and Debugging

### CloudWatch Logs

All console output goes to CloudWatch Logs:

```javascript
exports.handler = async (event) => {
    console.log('Starting execution');
    console.log('Event:', JSON.stringify(event, null, 2));
    
    try {
        const result = await processData(event);
        console.log('Success:', result);
        return result;
    } catch (error) {
        console.error('Error:', error);
        throw error;
    }
};
```

### CloudWatch Metrics

Key metrics to monitor:

- **Invocations** - Number of times function is invoked
- **Duration** - Execution time
- **Errors** - Failed invocations
- **Throttles** - Rate-limited invocations
- **Concurrent executions** - Simultaneous runs

## Cost Considerations

Lambda pricing (as of 2017):

- **Free tier**: 1M requests/month, 400,000 GB-seconds
- **Requests**: $0.20 per 1M requests
- **Compute**: $0.00001667 per GB-second

Example calculation:

```
Function: 512 MB memory, 200ms average duration
Monthly invocations: 10,000,000

Requests cost: (10M requests - 1M free) × $0.20 / 1M = $1.80
Compute cost: 10M × 0.2s × 0.5 GB × $0.00001667 = $16.67
Total: $18.47/month
```

Compare to EC2: A t2.small instance (1 vCPU, 2GB RAM) costs ~$17/month but runs 24/7.

## Limitations to Consider

In 2017, Lambda had some constraints:

- **Execution timeout**: 5 minutes maximum (now 15 minutes)
- **Deployment package**: 50 MB (zipped), 250 MB (unzipped)
- **Concurrent executions**: 1,000 per account (can be increased)
- **/tmp storage**: 512 MB
- **Cold starts**: Latency on first invocation

## Conclusion

AWS Lambda represents a fundamental shift in how we build and deploy applications. By eliminating server management and enabling true pay-per-use pricing, it opened new possibilities for building scalable, cost-effective systems.

At PostPickr, we started using Lambda for background tasks—processing social media webhooks, generating reports, and cleaning up expired data. The operational simplicity and automatic scaling made it a natural fit for event-driven workloads.

Key takeaways:

- Lambda is ideal for event-driven, stateless workloads
- Keep functions small, focused, and well-monitored
- Understand cold starts and optimization techniques
- Use environment variables for configuration
- Monitor costs and set appropriate memory/timeout settings

As serverless computing matures, Lambda is becoming a cornerstone of modern cloud architecture.

---

*Posted on January 19, 2017 | Tags: AWS, Lambda, Serverless | Category: How-To*

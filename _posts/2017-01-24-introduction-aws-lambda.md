---
layout: post
permalink: /2017/01-introduction-aws-lambda
title: "Introduction to AWS Lambda: Serverless Computing"
date: 2017-01-24
categories: [How-To]
tags: [AWS, Lambda, Serverless]
excerpt: "I stopped babysitting EC2 instances and started shipping functions instead. Here's what AWS Lambda actually is, how it works, and what we learned running it in production at PostPickr."
---

# Introduction to AWS Lambda: Serverless Computing

It was 2 AM. Our webhook processor had been chewing through a traffic spike for three hours, and I was staring at a CloudWatch graph that looked like a toddler had drawn a mountain range. The EC2 auto-scaling group was doing its best impression of a confused accordion—scaling up, scaling down, scaling up again—while we paid for idle capacity between bursts.

That week, we pointed our first real workload at AWS Lambda. No servers to patch. No capacity planning spreadsheet. Upload a function, wire up a trigger, walk away. When nothing happened, we paid nothing. It felt almost suspicious.

This is the guide I wish I'd had before that migration—not a dry AWS brochure, but the practical stuff: what Lambda actually does, how the execution model works, where it shines, and where it'll make you cry.

## What Is AWS Lambda, Really?

AWS Lambda is a compute service that runs your code in response to events. You don't provision servers. You don't SSH into anything. You write a handler, deploy it, and AWS figures out how many copies to run and when to shut them down.

The billing model is the part that changes how you think about architecture:

- **Event-driven execution** — Something happens (S3 upload, API request, DynamoDB change), your function runs
- **Automatic scaling** — One request or a million; Lambda handles the fan-out
- **Pay-per-use** — Billed in 100ms increments; zero cost when idle
- **No server management** — AWS owns the infrastructure, patching, and scaling
- **Multiple language support** — Node.js, Python, Java, C#, Go (in 2017; more languages followed)

The mental shift: you're not renting a machine. You're renting *executions*.

## Your First Lambda Function

Let's start with the classic scenario—someone uploads a file to S3 and you want to react immediately. No cron job polling a bucket every five minutes like it's 2009.

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

A few things worth noting before you copy-paste this into production:

The `key.replace(/\+/g, ' ')` bit isn't paranoia—S3 event notifications URL-encode keys, and `+` signs in filenames will ruin your day if you skip decoding. Ask me how I know.

Also, `throw error` vs returning a 500 response depends on your trigger. For S3 events, throwing triggers automatic retries (which is usually what you want). For API Gateway, you typically want a structured error response instead. Context matters.

## The Execution Model (Read This Twice)

Lambda isn't magic. It's a very opinionated runtime with rules. Understanding those rules saves you from 3 AM debugging sessions.

### The Handler

Every Lambda has exactly one entry point—the handler:

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

The `event` is your input. The `context` is metadata about *this specific invocation*. The return value goes back to whatever triggered you (API Gateway, Step Functions, etc.)—unless you throw, in which case AWS decides what retry logic applies.

### The Event Object Changes Shape

This trips up everyone at least once. The `event` structure depends entirely on who invoked your function:

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

Pro tip: log the full event during development. You'll build a collection of sample payloads that make local testing possible. Your future self will send you a thank-you note.

### The Context Object

The context tells you about the runtime environment and how much time you have left before Lambda pulls the plug:

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

That `getRemainingTimeInMillis()` call is your best friend for long-running operations. Check it before starting expensive work. If you're at 500ms remaining and your database query takes 2 seconds, you're about to get a timeout—not a graceful error.

## Where Lambda Actually Shines

Not every workload belongs on Lambda. But these four patterns? We ran all of them at PostPickr.

### Real-Time File Processing

Someone uploads an image. You generate a thumbnail before they refresh the page. Lambda + S3 events make this embarrassingly straightforward:

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

Why Lambda here? Traffic is spiky. Image uploads cluster around campaign launches. With EC2, you'd over-provision for peak or accept slow processing during bursts. Lambda scales with the upload rate and you only pay for actual processing time.

Watch the deployment package size though—`sharp` with native bindings can push you toward Lambda's size limits. More on that later.

### API Backend

Yes, you can build an entire REST API in a single Lambda function. Should you? Debatable. Can you? Absolutely:

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

This works fine for small APIs. Once you have more than a handful of routes, split into multiple functions or use a lightweight router. Your handler shouldn't read like a phone book.

### Scheduled Tasks

Cron jobs without cron servers. CloudWatch Events triggers your function on a schedule:

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

We used this pattern for cleaning expired social media tokens and pruning temporary upload records. A full EC2 instance running 24/7 to delete rows once an hour felt wasteful even before we did the math.

Fair warning: `scan` on large tables is expensive and slow. For production cleanup jobs, use GSIs or TTL instead of scanning the world every hour.

### Stream Processing

DynamoDB Streams and Kinesis let you react to data changes in near real-time:

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

This is event-driven architecture without running your own message broker. The trade-off: you're now debugging distributed systems. Keep your handlers idempotent—streams can deliver duplicates.

## Lessons From Production (Not a Checklist, Just Hard-Won Advice)

### One Function, One Job

The temptation to build a Swiss Army Lambda is strong. Resist it.

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

Small functions deploy independently, fail independently, and scale independently. When your "do everything" function breaks, everything breaks.

### Cold Starts Are Real (But Manageable)

The first invocation after idle time spins up a new execution environment. That's the "cold start" everyone complains about on Twitter.

What actually helps:

- **Keep deployment packages small** — Every megabyte adds to init time
- **Initialize outside the handler** — Connections, SDK clients, config parsing
- **Reuse database connections** — Don't reconnect on every invocation

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

Code outside the handler runs once per container lifetime, not once per invocation. That distinction is worth real milliseconds—and real money at scale.

### Errors Need a Strategy

Throwing errors triggers retries. Sometimes that's exactly what you want (S3 processing). Sometimes it creates an infinite retry loop that eats your budget (API Gateway with a bug in your validation).

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

Log everything. Return structured errors to clients. Throw only when you *want* AWS to retry.

### Configuration Belongs in Environment Variables

Hardcoding table names is how you accidentally write to production from your laptop. Don't do that.

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

Environment variables are the right place for config that changes between stages (dev/staging/prod). Secrets belong in AWS Secrets Manager or Parameter Store—not environment variables committed to git. We learned that one the embarrassing way.

### Memory and Timeout Are Tuning Knobs, Not Defaults

Lambda lets you allocate 128 MB to 10,240 MB. More memory means more CPU. Yes, counterintuitively, *more memory can cost less* if your function finishes faster.

```javascript
// In AWS Console or CloudFormation
{
    "Timeout": 30,        // 30 seconds
    "MemorySize": 512     // 512 MB
}
```

Set timeout based on your slowest legitimate operation plus buffer—not the 15-minute maximum "just in case." A hung function burning GB-seconds is an expensive way to learn about missing timeouts in your database client.

## Monitoring: Your Safety Net

### CloudWatch Logs

Every `console.log`, `console.error`, and stack trace lands in CloudWatch. This is your primary debugging tool:

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

Structure your logs. Include request IDs. Log inputs (carefully—no passwords). When something breaks at 2 AM, you'll be reading these on your phone.

### CloudWatch Metrics

AWS tracks the basics automatically. Watch these:

- **Invocations** — Is traffic what you expect?
- **Duration** — Getting slower? Cold starts or code regression?
- **Errors** — The obvious one
- **Throttles** — You've hit concurrency limits
- **Concurrent executions** — How many copies are running right now?

Set alarms on errors and throttles. "I'll check the dashboard eventually" is not a monitoring strategy.

## The Money Conversation

Lambda pricing in 2017:

- **Free tier**: 1M requests/month, 400,000 GB-seconds
- **Requests**: $0.20 per 1M requests
- **Compute**: $0.00001667 per GB-second

Example for a moderately busy function:

```
Function: 512 MB memory, 200ms average duration
Monthly invocations: 10,000,000

Requests cost: (10M requests - 1M free) × $0.20 / 1M = $1.80
Compute cost: 10M × 0.2s × 0.5 GB × $0.00001667 = $16.67
Total: $18.47/month
```

Compare to a t2.small EC2 instance (~$17/month) running 24/7 regardless of traffic.

Lambda wins when traffic is spiky or low. EC2 wins when you have sustained, predictable load. The honest answer for most startups in 2017: Lambda for event-driven work, EC2 (or containers) for your always-on API core. Hybrid architectures aren't failure—they're pragmatism.

## Know the Limits Before They Know You

Lambda in 2017 had real constraints. Plan around them:

- **Execution timeout**: 5 minutes maximum (later increased to 15)
- **Deployment package**: 50 MB zipped, 250 MB unzipped
- **Concurrent executions**: 1,000 per account (request increases via support)
- **/tmp storage**: 512 MB
- **Cold starts**: Noticeable on first invocation, worse with large packages

None of these are dealbreakers. They're design constraints—like building on a city lot instead of an empty prairie. You architect around them.

## What We Actually Used It For

At PostPickr, Lambda became our go-to for work that was *event-driven, bursty, and annoying to keep servers around for*:

- Processing social media webhooks (spiky, must be fast)
- Generating scheduled reports (once a day, why keep a server?)
- Cleaning up expired data (hourly cron without a cron server)
- Thumbnail generation on upload (classic S3 trigger pattern)

We didn't move everything to Lambda. Our core API stayed on traditional infrastructure. Lambda handled the edges—the async, the spiky, the "I don't want to manage a server for this one job" work.

That's the pattern I'd recommend: start with one painful workload, prove the model, expand from there.

## The Bottom Line

AWS Lambda isn't just "servers but someone else manages them." It's a different contract with your infrastructure—you trade control for operational simplicity and pay-per-use economics.

What actually matters:

- Lambda excels at event-driven, stateless, bursty workloads
- Small focused functions beat monolithic handlers every time
- Cold starts are manageable with package discipline and init-outside-handler patterns
- Environment variables for config, proper secret management for secrets
- Monitor costs, duration, and errors from day one—not after the surprise bill

Serverless was still finding its footing in early 2017. Lambda had been around since 2014, but production patterns were still being written. We were writing them. You are too.

---

*Written January 2017. Covers AWS Lambda as it existed then—Node.js 6.x/8.x runtimes, 5-minute timeout cap, and pre-Provisioned Concurrency. The fundamentals still hold; the limits have mostly relaxed.*

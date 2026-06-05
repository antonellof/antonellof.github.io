---
layout: post
title: "Serverless Pros and Cons: When to Go Serverless"
date: 2017-12-20
categories: [Analysis]
tags: [Serverless, AWS Lambda, Architecture, Pros and Cons]
excerpt: "Serverless promised no servers and infinite scale. What we got was cold starts, vendor lock-in, and a surprisingly large AWS bill — plus some genuine wins."
---

"We don't need servers anymore."

I heard this in a meeting in late 2016, right after someone returned from re:Invent with a Lambda sticker on their laptop and a dream. Six months later, we had a serverless API, three Lambda functions processing uploads, and a WebSocket server that absolutely could not run on Lambda no matter how hard we squinted at it.

Serverless isn't a religion. It's a pricing model with tradeoffs. After building several serverless applications in production — and one very educational bill spike — here's an honest assessment of when it helps, when it hurts, and when you need both.

## What "Serverless" Actually Means

The marketing version:
- No server management
- Automatic scaling
- Pay-per-execution pricing
- Event-driven architecture

The reality version: servers absolutely exist. You just don't SSH into them. Someone at AWS is patching those machines. You're just not that someone — which is either liberating or terrifying, depending on your ops team's maturity.

## The Wins (They're Real)

### No Server Management

The pitch: no OS updates, no security patches, no capacity planning. Deploy code, go home.

What they don't put on the slide: you now manage cold starts, deployment packaging, IAM permissions, and CloudWatch log groups instead. You've traded one ops surface for another. For teams without dedicated infrastructure people, that's often a good trade.

### Automatic Scaling

```javascript
// Handles 1 or 1,000,000 requests automatically
exports.handler = async (event) => {
    // Your code
    return { statusCode: 200, body: 'OK' };
};
```

Lambda scales concurrency automatically. One request or ten thousand — AWS provisions instances. No "quick, launch more EC2 boxes" panic.

The catch: cold starts. The first request after idle time pays a 2–5 second penalty while AWS boots your runtime, loads your dependencies, and runs your handler. Users notice. Monitoring dashboards notice. Your product manager definitely notices.

Concurrent execution limits exist too. Default account limits can throttle you during spikes. Request limit increases before you need them, not during the incident.

### Cost Efficiency (Sometimes)

The classic example:

```
Traditional: EC2 t2.small = $15/month (24/7)
Serverless: 1M requests × 200ms × 512MB = ~$3/month
```

For sporadic, bursty workloads, serverless is genuinely cheaper. A cron job that runs twice a day doesn't need a server humming 24/7.

For high-traffic, always-on APIs? The math flips. We'll get to that.

### Faster Deployment

```javascript
// Deploy in seconds
serverless deploy

// No infrastructure setup
// No server configuration
```

`serverless deploy` and you're live. No AMI selection, no security group configuration, no "which instance type?" paralysis.

Local development and debugging are harder, though. No SSH, no local breakpoints in the traditional sense. SAM and Serverless Framework help, but the dev experience still lags behind "run Express on localhost."

## The Pain (Also Real)

### Cold Starts: The Tax on Idle

```javascript
// First request: 2-5 seconds (cold start)
// Subsequent: 50-200ms (warm)
```

A 3-second API response because nobody visited your endpoint in twenty minutes is a tough conversation with the frontend team.

Mitigation strategies we tried:

```javascript
// Keep functions warm
setInterval(() => {
    fetch('https://api.example.com/keep-warm');
}, 5 * 60 * 1000); // Every 5 minutes
```

Keeping functions warm works — and costs money. You're paying to defeat the cost optimization that made serverless attractive in the first place. Pick your poison.

Smaller deployment packages help. A Lambda with a 50MB `node_modules` cold-starts slower than one with tree-shaken dependencies. Every megabyte matters.

### Vendor Lock-In: The Migration You'll Never Schedule

AWS Lambda doesn't run on Azure Functions. API Gateway is AWS-specific. DynamoDB triggers, S3 events, CloudWatch rules — all AWS dialect.

Mitigation is possible but rarely worth it early:

```javascript
// Abstract vendor-specific code
class ServerlessAdapter {
    async invoke(functionName, payload) {
        // AWS-specific
        return await lambda.invoke({
            FunctionName: functionName,
            Payload: JSON.stringify(payload)
        }).promise();
    }
}

// Use adapter everywhere
const adapter = new ServerlessAdapter();
await adapter.invoke('my-function', data);
```

Abstraction layers add complexity. Use them when multi-cloud is a real requirement, not a theoretical one.

### Debugging: Where Did My Error Go?

No SSH. No `console.log` attached to a terminal you can stare at. Logs in CloudWatch, distributed across invocations, correlated by `requestId` if you're disciplined.

```javascript
// Comprehensive logging
exports.handler = async (event, context) => {
    const logger = {
        info: (msg, data) => console.log(JSON.stringify({
            level: 'info',
            message: msg,
            data,
            requestId: context.requestId
        })),
        error: (msg, error) => console.error(JSON.stringify({
            level: 'error',
            message: msg,
            error: error.message,
            stack: error.stack,
            requestId: context.requestId
        }))
    };
    
    logger.info('Function started', { event });
    
    try {
        // Your logic
        return { statusCode: 200 };
    } catch (error) {
        logger.error('Function failed', error);
        throw error;
    }
};
```

Structured JSON logging with `requestId` correlation isn't optional — it's how you debug a system you can't log into.

### The 15-Minute Wall

AWS Lambda max execution time: 15 minutes (increased from 5 during our early experiments). Video transcoding, large ETL jobs, and batch processing that takes an hour don't fit.

The workaround is function chaining:

```javascript
// Break into smaller functions
exports.processBatch = async (event) => {
    const batch = event.items.slice(0, 100);
    
    // Process batch
    await processItems(batch);
    
    // If more items, invoke next function
    if (event.items.length > 100) {
        await lambda.invoke({
            FunctionName: 'processBatch',
            Payload: JSON.stringify({
                items: event.items.slice(100)
            })
        }).promise();
    }
};
```

You've rebuilt a job queue with Lambda invocations. At some point, ask whether a worker on EC2 would be simpler.

### Cost at Scale: The Surprise Bill

```
1M requests/day
× 200ms average duration
× 512MB memory
= ~$30/month (Lambda)
+ $3.50/month (API Gateway)
+ Data transfer costs
= Can exceed EC2 costs
```

API Gateway pricing at volume is the silent killer. Lambda compute looks cheap; API Gateway at 100M requests/month does not.

Serverless gets expensive when:
- Traffic is high and consistent (always-on workloads)
- Functions run long or use lots of memory
- Data transfer crosses regions or exits AWS

## When Serverless Shines

**Event-driven workloads** — file processing on S3 upload, webhook handlers, scheduled cron tasks. Something triggers the function, it runs, it stops. Perfect fit.

**Sporadic traffic** — low baseline with occasional spikes. A reporting API called a few hundred times a day doesn't need a dedicated server.

**Small, focused microservices** — independent deploy, independent scale, single responsibility. A function that resizes images doesn't need to share a process with your user authentication service.

**API backends where latency tolerance exists** — REST endpoints where 200ms warm / 2s cold is acceptable. Internal tools, background-facing APIs, admin dashboards.

## When Serverless Fights You

**Long-running processes** — video encoding, data ETL, anything over 15 minutes. Use a proper worker.

**High, consistent traffic** — an API serving 100M requests/month is often cheaper on EC2 with a load balancer. Do the math for your specific workload.

**Stateful applications** — WebSocket servers, long-lived connections, in-memory session state. Lambda is stateless by design. Fighting that design is expensive.

**Tight latency requirements** — real-time gaming, trading systems, anything where cold-start jitter is unacceptable. Dedicated servers with warm processes win.

We learned this last one with WebSockets. Lambda can't hold a persistent connection. We ran WebSockets on EC2 and everything else on Lambda. It worked.

## The Hybrid Approach (What We Actually Did)

```javascript
// Architecture
┌─────────────┐
│   API GW    │ → Lambda (API endpoints)
└─────────────┘
      │
      ├──→ Lambda (File processing)
      ├──→ Lambda (Scheduled tasks)
      └──→ EC2 (WebSocket server)
           └──→ Lambda (Background jobs)
```

Use serverless where the workload fits. Use traditional infrastructure where it doesn't. This isn't a compromise — it's engineering.

- API endpoints: Lambda
- File processing (S3 trigger): Lambda
- Scheduled tasks (CloudWatch Events): Lambda
- WebSocket server: EC2
- Background jobs triggered from WebSocket: Lambda

## The Cost Math, Honestly

### Low Traffic (100K requests/month)

```
Lambda: $0.20
API Gateway: $3.50
Total: ~$4/month
```

```
EC2 t2.micro: $8.50/month
Total: ~$9/month
```

**Serverless wins.** Not even close.

### High Traffic (100M requests/month)

```
Lambda: $20
API Gateway: $3,500
Data transfer: $100
Total: ~$3,620/month
```

```
3x t2.large: $150/month
Load balancer: $20/month
Total: ~$170/month
```

**EC2 wins.** Painfully clearly.

The crossover point depends on your function duration, memory, and API Gateway usage. Calculate it for your workload before committing.

## Making Serverless Work When You Choose It

Keep functions small — one job per function. A Lambda that validates input, queries a database, calls two external APIs, generates a PDF, and sends an email is four functions pretending to be one. When something fails, you'll want to know which step broke, not grep a monolith's worth of logs.

Minimize package size to reduce cold starts. We shaved two seconds off cold start time by removing unused AWS SDK modules and switching to webpack tree-shaking. Two seconds doesn't sound heroic until you multiply it by every first request after idle.

Database connections are the silent killer. Lambda spins up, opens a connection, handles the request, and — if you're not careful — leaves the connection open. Do that a thousand times concurrently and your database hits `max_connections` faster than you can open the RDS console.

Reuse connections across warm invocations by creating the pool outside the handler:

```javascript
// Connection OUTSIDE the handler — reused across warm invocations
const mysql = require('serverless-mysql')({
    config: {
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    }
});

exports.handler = async (event) => {
    const results = await mysql.query('SELECT * FROM users WHERE id = ?', [event.userId]);
    return { statusCode: 200, body: JSON.stringify(results) };
};
```

Set billing alerts on day one, not after the surprise invoice. AWS Budgets is free. Regret is not.

Handle errors with retry logic and dead-letter queues. Lambda retries failed invocations automatically (up to two times by default), which is great for transient failures and terrible for bugs that will never succeed. Configure dead-letter queues so poison messages don't loop forever.

Use environment variables for configuration — never hardcode ARNs, table names, or API keys. Version functions with aliases for safe rollbacks. Test locally with SAM or Serverless Framework before deploying to prod. "Works on my laptop" is only useful if your laptop can simulate API Gateway, IAM roles, and DynamoDB streams.

## Migration: Start Small, Measure Everything

```javascript
// Phase 1: Move background jobs
// Old: Cron job on EC2
// New: Lambda + CloudWatch Events

// Phase 2: Move API endpoints
// Old: Express.js on EC2
// New: Lambda + API Gateway

// Phase 3: Move file processing
// Old: Worker on EC2
// New: Lambda + S3 trigger
```

Don't lift-and-shift your entire architecture. Move the workloads that fit. Measure execution time, cold start frequency, error rate, cost per request, and actual user-facing latency.

If a migrated function is slower, more expensive, or harder to debug than the EC2 version — move it back. Serverless isn't a moral victory. It's a tool.

## The Bottom Line

Serverless is powerful and genuinely useful for the right workloads. It's not cheaper, faster, or simpler in every case — it's different.

Use it for event-driven, sporadic, stateless work where you want to minimize ops overhead. Avoid it for long-running, high-traffic, stateful, or latency-sensitive workloads where dedicated infrastructure still wins.

The teams that succeed with serverless aren't the ones that go all-in. They're the ones that know which piece of their architecture fits the model — and which pieces need a server with a name.

We still use Lambda for background jobs and file processing. We still use EC2 for WebSockets and high-traffic APIs. Nobody in those meetings talks about eliminating servers anymore. They talk about eliminating the *wrong* servers.

---

*Written December 2017, based on production experience with AWS Lambda, API Gateway, and the Serverless Framework. Lambda limits, pricing, and tooling have evolved — but the workload-fit framework still holds.*

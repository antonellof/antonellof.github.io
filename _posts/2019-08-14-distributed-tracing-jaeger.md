---
layout: post
title: "Distributed Tracing with Jaeger and OpenTelemetry"
date: 2019-08-14
categories: [How-To]
tags: [Distributed Tracing, Observability, Jaeger]
excerpt: "Your microservice works in isolation and fails in production. Distributed tracing with Jaeger and OpenTelemetry is how you stop guessing which service lied to you."
---

The bug report was perfect in its uselessness: "checkout is slow sometimes."

Which service? Which database query? Which downstream API call decided to take a scenic route through latency? In a monolith you'd grep the logs and find the answer in twenty minutes. In microservices you grep twelve log streams, find nothing coherent, and start blaming the network team.

That's the moment distributed tracing stops being a conference buzzword and becomes the best debugging tool you've never properly set up.

After wiring Jaeger into production services — and watching it save us from at least three "mystery latency" incidents — here's the practical guide to getting tracing working without turning your observability budget into a line item that makes finance cry.

## What Distributed Tracing Actually Gives You

A **trace** is the full journey of a single request through your system. A **span** is one unit of work within that journey — an HTTP call, a database query, a message publish.

Together they answer questions logs struggle with:

- Where did this request spend its time?
- Which service in the chain is the bottleneck?
- Did the failure happen here, or three hops upstream?
- What was the exact path when things went wrong at 3:47 AM?

Logs tell you what happened at a point in time. Traces tell you how a request flowed through a distributed system. You need both. Traces without logs is a pretty waterfall chart with no error details. Logs without traces is twelve grep sessions and a prayer.

## Jaeger Architecture (The Plumbing)

```
Application → OpenTelemetry SDK → Jaeger Agent → Jaeger Collector → Storage
```

Your app creates spans via the OpenTelemetry SDK. The Jaeger exporter ships them to a collector. Storage (Elasticsearch, Cassandra, or in-memory for dev) persists them. The Jaeger UI lets you search and visualize traces.

In 2019, OpenTelemetry was still consolidating from OpenTracing and OpenCensus — but the direction was clear: one standard instrumentation layer, multiple backends. Jaeger was (and remains) a solid open-source backend choice.

## Getting Started with OpenTelemetry in Node.js

### Installation

```bash
npm install @opentelemetry/api
npm install @opentelemetry/sdk-node
npm install @opentelemetry/instrumentation
npm install @opentelemetry/exporter-jaeger
npm install @opentelemetry/instrumentation-http
npm install @opentelemetry/instrumentation-express
```

Yes, that's a lot of packages. Observability tax is real.

### Basic Setup

Initialize tracing **before** your application code loads. If you import Express first and tracing second, you've already missed the HTTP calls you cared about:

```javascript
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

const sdk = new NodeSDK({
    resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'my-service',
        [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
    }),
    traceExporter: new JaegerExporter({
        endpoint: 'http://localhost:14268/api/traces',
    }),
    instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
    ],
});

sdk.start();
```

Auto-instrumentation gets you 80% of the value with 20% of the effort. HTTP requests, Express routes — traced automatically. You'll see spans before you've written a single manual `startSpan`.

The `SERVICE_NAME` attribute matters more than it sounds. In the Jaeger UI, "unknown-service" is where traces go to die unnoticed.

## Manual Instrumentation: When Auto-Instrumentation Isn't Enough

Auto-instrumentation tells you *that* a request happened. Manual spans tell you *what your code did* inside that request.

### Creating Spans

```javascript
const { trace } = require('@opentelemetry/api');

const tracer = trace.getTracer('my-service');

async function getUser(userId) {
    const span = tracer.startSpan('getUser', {
        attributes: {
            'user.id': userId,
        },
    });
    
    try {
        const user = await db.users.findById(userId);
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute('user.name', user.name);
        return user;
    } catch (error) {
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
        });
        span.recordException(error);
        throw error;
    } finally {
        span.end();
    }
}
```

The `finally { span.end() }` pattern is non-negotiable. Unclosed spans leak memory and produce traces that look like your service is still working on a request from last Tuesday.

Add attributes that help you debug: user IDs, order totals, cache hit/miss. Don't add passwords, API keys, or full credit card numbers. Traces get stored, searched, and occasionally screenshotted in Slack. Treat them like logs for PII purposes.

### Nested Spans: See Where Time Actually Goes

```javascript
async function processOrder(orderId) {
    const span = tracer.startSpan('processOrder');
    
    try {
        const validateSpan = tracer.startSpan('validateOrder', {
            parent: span,
        });
        await validateOrder(orderId);
        validateSpan.end();
        
        const paymentSpan = tracer.startSpan('processPayment', {
            parent: span,
        });
        await processPayment(orderId);
        paymentSpan.end();
        
        span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
        });
        throw error;
    } finally {
        span.end();
    }
}
```

This is where tracing pays for itself. You open a slow checkout trace and see: validation took 12ms, payment took 4.2 seconds. Now you know where to look. Without nested spans, you just know "processOrder was slow" — which is like knowing your car is broken without knowing which part.

## Context Propagation: The Part Everyone Gets Wrong

Tracing only works across services if trace context travels with the request. Service A creates a trace ID. Service B must continue that trace, not start a fresh one.

### HTTP Headers

```javascript
const { propagation, context } = require('@opentelemetry/api');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');

propagation.setGlobalPropagator(new W3CTraceContextPropagator());

function extractContext(req) {
    const headers = req.headers;
    const parentContext = propagation.extract(
        context.active(),
        headers
    );
    return parentContext;
}

function injectContext(headers) {
    propagation.inject(context.active(), headers);
    return headers;
}
```

W3C Trace Context (`traceparent` header) was becoming the standard in 2019. If your services use different propagation formats, you get disconnected traces — separate waterfalls that should be one. It's like trying to follow a story where every chapter is a different book.

### Express Middleware

```javascript
const express = require('express');
const { trace, context } = require('@opentelemetry/api');

const app = express();

app.use((req, res, next) => {
    const parentContext = propagation.extract(
        context.active(),
        req.headers
    );
    
    const span = tracer.startSpan('http_request', {
        kind: SpanKind.SERVER,
        attributes: {
            'http.method': req.method,
            'http.url': req.url,
        },
    });
    
    context.with(parentContext, () => {
        context.with(trace.setSpan(context.active(), span), () => {
            next();
        });
    });
    
    res.on('finish', () => {
        span.setAttribute('http.status_code', res.statusCode);
        span.setStatus({
            code: res.statusCode >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.end();
    });
});
```

The first thing I check when traces look disconnected: is context being extracted on incoming requests and injected on outgoing ones? Miss either direction and your distributed trace becomes a collection of lonely spans.

## Instrumenting the Rest of Your Stack

### gRPC

```javascript
const grpc = require('@grpc/grpc-js');
const { GrpcInstrumentation } = require('@opentelemetry/instrumentation-grpc');

const instrumentation = new GrpcInstrumentation();

const server = new grpc.Server();
instrumentation.enable();

const client = new userProto.UserService(
    'localhost:50051',
    grpc.credentials.createInsecure()
);
```

gRPC metadata carries trace context similarly to HTTP headers. Enable the instrumentation package and verify propagation in the Jaeger UI — gRPC's binary headers are easier to misconfigure than HTTP's text headers.

### PostgreSQL

```javascript
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');

const instrumentation = new PgInstrumentation({
    enhancedDatabaseReporting: true,
});

instrumentation.enable();

const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
```

Suddenly your traces show individual query durations. That "mystery 800ms" in your API handler? It's three sequential queries that should've been one. Database spans make this obvious.

## Enriching Spans for Actual Debugging

```javascript
span.setAttributes({
    'user.id': userId,
    'order.total': order.total,
    'payment.method': 'credit_card',
    'db.query': 'SELECT * FROM users',
    'cache.hit': true,
});
```

Good attributes turn traces from pretty charts into actionable evidence. When filtering traces in Jaeger, `http.status_code=500` and `payment.method=credit_card` narrow thousands of traces to the handful that matter.

### Error Tracking

```javascript
try {
    await processOrder(orderId);
} catch (error) {
    span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
    });
    span.recordException(error, {
        'error.type': error.constructor.name,
        'error.stack': error.stack,
    });
    throw error;
}
```

`recordException` attaches stack traces to spans. When you're debugging a production failure at 2 AM, finding the stack trace in the trace view beats correlating trace IDs with log entries across four services.

## Sampling: Because You Can't Trace Everything

At scale, tracing every request will overwhelm your collector, inflate storage costs, and make the UI unusable. Sampling is how you balance visibility with cost.

### Probabilistic Sampling

```javascript
const { TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');

const sdk = new NodeSDK({
    sampler: new TraceIdRatioBasedSampler(0.1), // Sample 10% of traces
    // ...
});
```

10% sampling means you see one in ten requests — usually enough to catch patterns. Latency outliers, error spikes, and slow dependencies show up in sampled data if your traffic is meaningful.

### Custom Sampling: Always Catch Errors

```javascript
class CustomSampler {
    shouldSample(context, traceId, spanName, spanKind, attributes) {
        if (attributes['error']) {
            return { decision: SamplingDecision.RECORD_AND_SAMPLE };
        }
        
        if (Math.random() < 0.1) {
            return { decision: SamplingDecision.RECORD_AND_SAMPLE };
        }
        
        return { decision: SamplingDecision.NOT_RECORD };
    }
}
```

Sample everything that fails. Sample a fraction of successes. This gives you error visibility without paying to store traces for every health check.

## Deploying Jaeger

### Docker Compose (Development)

```yaml
version: '3'
services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"  # UI
      - "14268:14268"  # HTTP collector
      - "6831:6831/udp" # UDP agent
    environment:
      - COLLECTOR_ZIPKIN_HTTP_PORT=9411
```

The all-in-one image is perfect for local development. One `docker-compose up`, open `localhost:16686`, and you're staring at traces. Don't run all-in-one in production — it stores everything in memory and forgets it on restart.

### Kubernetes (Production-ish)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: jaeger
        image: jaegertracing/all-in-one:latest
        ports:
        - containerPort: 16686
        - containerPort: 14268
        env:
        - name: COLLECTOR_ZIPKIN_HTTP_PORT
          value: "9411"
```

For real production workloads in 2019, you'd separate collector, query, and agent components with persistent storage (Elasticsearch was the common choice). The all-in-one deployment gets you started; persistent storage keeps your traces when pods restart.

## Querying and Analyzing Traces

### Finding Traces Programmatically

```javascript
const traces = await jaegerClient.findTraces({
    serviceName: 'my-service',
    startTime: Date.now() - 3600000, // Last hour
    tags: {
        'http.status_code': '500',
    },
});
```

Automate trace queries for incident response. "Show me all 500 errors in the payment service in the last hour" beats clicking through the UI when production is on fire.

### Analyzing Where Time Went

```javascript
function analyzeTrace(trace) {
    const spans = trace.spans;
    const totalDuration = trace.duration;
    
    const spanDurations = spans.map(span => ({
        name: span.operationName,
        duration: span.duration,
        percentage: (span.duration / totalDuration) * 100,
    }));
    
    return spanDurations.sort((a, b) => b.duration - a.duration);
}
```

Sort spans by duration percentage and the bottleneck announces itself. The span consuming 78% of total trace time is your optimization target. Everything else is noise until that's fixed.

## What We Learned Running This in Production

**Instrument every service or accept incomplete pictures.** A trace that dies at the service boundary is a cliffhanger, not debugging data. Roll out instrumentation service by service, but don't stop halfway.

**Consistent span naming saves your sanity.** Pick a convention (`service.operation` or `HTTP GET /users/:id`) and enforce it. "getUser", "get_user", and "UserService.get" in the same system makes the Jaeger UI feel like a ransom note.

**Meaningful attributes are worth more than more spans.** A well-attributed span beats five generic ones. Tag the things you'll search for during incidents.

**Sample intelligently, not frugally to the point of blindness.** 1% sampling on low-traffic services means you might not see an error for hours. Tune per environment: higher sampling in staging, error-biased sampling in production.

**Watch trace volume like you watch log volume.** A misconfigured instrumentation loop can generate millions of spans per hour. Set alerts on collector queue depth and storage growth.

**Propagate context everywhere.** HTTP, gRPC, message queues — if a request crosses a boundary, the trace ID must cross with it. This is the single most common reason tracing "doesn't work."

**Review traces proactively, not just during incidents.** Weekly trace review catches slow regressions before they become outage postmortems. That payment service didn't suddenly become slow — it drifted over three deploys.

## Start Here

1. Deploy Jaeger locally with Docker Compose
2. Add OpenTelemetry auto-instrumentation to one service
3. Verify traces appear in the UI for incoming HTTP requests
4. Add manual spans around your slowest business logic
5. Fix context propagation to the next service in the chain
6. Add sampling before you point this at production traffic
7. Repeat for every service until the full request path is visible

Distributed tracing won't fix your architecture. It will show you exactly which part of your architecture needs fixing — and that's worth more than another dashboard of aggregate metrics.

The next time someone says "it's slow sometimes," you'll open Jaeger, find the trace, and point at the exact span that took 4.2 seconds. The network team will appreciate not being blamed. You'll appreciate sleeping through the night.

---

*Written August 2019, covering Jaeger and early OpenTelemetry patterns. The OpenTelemetry ecosystem has matured significantly since — unified SDKs, OTLP exporters, and broader language support — but the core concepts of spans, traces, context propagation, and sampling remain the same.*

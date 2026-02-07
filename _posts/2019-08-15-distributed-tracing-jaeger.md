---
layout: post
title: "Distributed Tracing with Jaeger and OpenTelemetry"
date: 2019-08-15
categories: [How-To]
tags: [Distributed Tracing, Observability, Jaeger]
excerpt: "Implement distributed tracing in microservices using Jaeger and OpenTelemetry. Learn about spans, traces, context propagation, and production patterns."
---

Distributed tracing helps debug microservices. After implementing Jaeger in production, here's how to set it up effectively.

## What is Distributed Tracing?

Distributed tracing:
- Tracks requests across services
- Shows request flow
- Identifies bottlenecks
- Debugs failures

## Jaeger Architecture

```
Application → OpenTelemetry SDK → Jaeger Agent → Jaeger Collector → Storage
```

## OpenTelemetry Setup

### Node.js Installation

```bash
npm install @opentelemetry/api
npm install @opentelemetry/sdk-node
npm install @opentelemetry/instrumentation
npm install @opentelemetry/exporter-jaeger
npm install @opentelemetry/instrumentation-http
npm install @opentelemetry/instrumentation-express
```

### Basic Setup

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

## Manual Instrumentation

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

### Nested Spans

```javascript
async function processOrder(orderId) {
    const span = tracer.startSpan('processOrder');
    
    try {
        // Child span
        const validateSpan = tracer.startSpan('validateOrder', {
            parent: span,
        });
        await validateOrder(orderId);
        validateSpan.end();
        
        // Another child span
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

## Context Propagation

### HTTP Headers

```javascript
const { propagation, context } = require('@opentelemetry/api');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');

// Set propagator
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

// Extract context from headers
function extractContext(req) {
    const headers = req.headers;
    const parentContext = propagation.extract(
        context.active(),
        headers
    );
    return parentContext;
}

// Inject context into headers
function injectContext(headers) {
    propagation.inject(context.active(), headers);
    return headers;
}
```

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

## gRPC Instrumentation

```javascript
const grpc = require('@grpc/grpc-js');
const { GrpcInstrumentation } = require('@opentelemetry/instrumentation-grpc');

const instrumentation = new GrpcInstrumentation();

// Server
const server = new grpc.Server();
instrumentation.enable();

// Client
const client = new userProto.UserService(
    'localhost:50051',
    grpc.credentials.createInsecure()
);
```

## Database Instrumentation

```javascript
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');

const instrumentation = new PgInstrumentation({
    enhancedDatabaseReporting: true,
});

instrumentation.enable();

// Queries are automatically traced
const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
```

## Custom Attributes

```javascript
span.setAttributes({
    'user.id': userId,
    'order.total': order.total,
    'payment.method': 'credit_card',
    'db.query': 'SELECT * FROM users',
    'cache.hit': true,
});
```

## Error Tracking

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

## Sampling

### Probabilistic Sampling

```javascript
const { TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');

const sdk = new NodeSDK({
    sampler: new TraceIdRatioBasedSampler(0.1), // Sample 10% of traces
    // ...
});
```

### Custom Sampler

```javascript
class CustomSampler {
    shouldSample(context, traceId, spanName, spanKind, attributes) {
        // Sample all errors
        if (attributes['error']) {
            return { decision: SamplingDecision.RECORD_AND_SAMPLE };
        }
        
        // Sample 10% of others
        if (Math.random() < 0.1) {
            return { decision: SamplingDecision.RECORD_AND_SAMPLE };
        }
        
        return { decision: SamplingDecision.NOT_RECORD };
    }
}
```

## Jaeger Deployment

### Docker Compose

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

### Kubernetes

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

## Querying Traces

### Find Traces

```javascript
// Query traces by service
const traces = await jaegerClient.findTraces({
    serviceName: 'my-service',
    startTime: Date.now() - 3600000, // Last hour
    tags: {
        'http.status_code': '500',
    },
});
```

### Trace Analysis

```javascript
// Analyze trace duration
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

## Best Practices

1. **Instrument all services** - Complete visibility
2. **Use consistent naming** - Standardize span names
3. **Add meaningful attributes** - Context for debugging
4. **Sample appropriately** - Balance cost and visibility
5. **Propagate context** - Across service boundaries
6. **Monitor trace volume** - Prevent overload
7. **Set up alerts** - On error rates
8. **Review traces regularly** - Identify issues

## Conclusion

Distributed tracing provides:
- Request visibility
- Performance insights
- Error debugging
- Service dependencies

Start with basic instrumentation, then add custom spans and attributes. The patterns shown here handle production workloads.

---

*Distributed tracing with Jaeger from August 2019, covering OpenTelemetry and Jaeger patterns.*

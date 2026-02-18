---
layout: post
title: "Cloudflare Workers: Serverless at the Edge"
date: 2024-01-12
categories: [How-To]
tags: [Cloudflare Workers, Edge Computing, Serverless]
excerpt: "Build serverless applications with Cloudflare Workers: edge computing, global distribution, Durable Objects, and how to deploy JavaScript at the edge."
---

Cloudflare Workers run JavaScript at the edge using V8 isolates, providing sub-millisecond cold starts and global distribution across 300+ cities. I've been using Workers in production since their early days, and they've fundamentally changed how I think about deploying web applications.

Unlike traditional serverless platforms that spin up containers, Workers use V8 isolates—the same technology that powers Chrome. This means your code starts in under 5ms, often faster than a single TCP round-trip. When you're serving requests from São Paulo, Singapore, or Stockholm, those milliseconds compound into a noticeably faster experience.

## What are Cloudflare Workers?

Workers are serverless functions that run on [Cloudflare's global network](https://www.cloudflare.com/network/). Instead of deploying to us-east-1 and hoping for the best, your code runs in the data center closest to each request.

The key technology is **V8 isolates**. Rather than spinning up a Node.js process or container for each request, Workers use the same isolation primitive that keeps different tabs secure in your browser. This architectural choice means:

- **Cold starts under 5ms**: Faster than most database queries
- **Minimal memory overhead**: ~5MB per isolate vs 100+MB for containers  
- **No infrastructure to manage**: No VMs, no container orchestration
- **Automatic scaling**: From 0 to millions of requests without configuration

Read more about the architecture in Cloudflare's [blog post on isolates](https://blog.cloudflare.com/cloud-computing-without-containers/).

## Basic Worker

Here's the minimal Worker—the "Hello World" of edge computing:

```javascript
// Basic worker using the ES modules syntax
export default {
    async fetch(request) {
        return new Response('Hello from Cloudflare Workers!', {
            headers: { 'content-type': 'text/plain' }
        });
    }
};
```

Deploy this with [Wrangler](https://developers.cloudflare.com/workers/wrangler/), Cloudflare's CLI:

```bash
npm install -g wrangler
wrangler init my-worker
wrangler deploy
```

Within seconds, your code is live across 300+ data centers worldwide.

## Request Handling

```javascript
export default {
    async fetch(request) {
        const url = new URL(request.url);
        
        if (url.pathname === '/api/users') {
            return handleUsers(request);
        }
        
        return new Response('Not found', { status: 404 });
    }
};

async function handleUsers(request) {
    const users = await fetch('https://api.example.com/users');
    return new Response(users.body, {
        headers: { 'content-type': 'application/json' }
    });
}
```

## Durable Objects

The real power comes with [Durable Objects](https://developers.cloudflare.com/durable-objects/)—strongly consistent, stateful objects that live at the edge. Think of them as tiny, persistent actors that can coordinate WebSocket connections, maintain real-time state, and provide transactional guarantees.

I use Durable Objects for things like real-time collaboration, chat systems, and distributed counters. Here's a simple counter:

```javascript
// counter.ts - Durable Object class
export class Counter {
    constructor(state, env) {
        this.state = state;
    }
    
    async fetch(request) {
        // Load current value from durable storage
        let count = (await this.state.storage.get('count')) || 0;
        count++;
        
        // Persist atomically
        await this.state.storage.put('count', count);
        
        return new Response(JSON.stringify({ count }), {
            headers: { 'content-type': 'application/json' }
        });
    }
}

// Worker that routes to the Durable Object
export default {
    async fetch(request, env) {
        // Each counter ID gets its own Durable Object instance
        const id = env.COUNTER.idFromName('global');
        const stub = env.COUNTER.get(id);
        return stub.fetch(request);
    }
};
```

Each Durable Object instance runs in a single location at a time, giving you strong consistency without the complexity of distributed consensus. When a user in Tokyo accesses a counter, Cloudflare routes requests to the same physical instance, ensuring atomic operations.

For more on the consistency model, see [Durable Objects: Easy, Fast, Correct](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/).

## Best Practices

After running Workers in production serving millions of requests:

1. **Use edge caching aggressively** - Cache API responses at the edge with `caches.default`
2. **Keep Workers lightweight** - Each Worker has CPU time limits (10-50ms depending on plan)
3. **Handle errors gracefully** - Network failures happen; implement retries with backoff
4. **Monitor with Analytics** - Use [Workers Analytics](https://developers.cloudflare.com/workers/observability/analytics/) to track requests, errors, and CPU time
5. **Test locally with Wrangler** - `wrangler dev` gives you a local development environment
6. **Use Durable Objects for state** - Don't try to maintain state in the Worker itself
7. **Leverage KV for read-heavy data** - [Workers KV](https://developers.cloudflare.com/kv/) is eventually consistent but extremely fast
8. **Mind the bundle size** - Keep your Worker under 1MB; use tree-shaking and code splitting

## Production considerations

### Performance optimization

Workers have near-instantaneous cold starts, but you still need to optimize:

- **CPU time limits**: Free tier has 10ms CPU time per request; paid goes up to 50ms. Use `performance.now()` to measure your execution time during development.
- **Memory limits**: 128MB per request. Stream large responses rather than buffering:

```javascript
// Good: Stream responses
export default {
    async fetch(request) {
        const response = await fetch('https://api.example.com/large-data');
        return new Response(response.body, response);  // Stream through
    }
};

// Avoid: Buffering large payloads
const data = await response.text();  // Loads everything into memory
```

- **Subrequest limits**: 50 subrequests per Worker invocation on free tier, 1000 on paid. Chain Workers carefully.

### Edge caching

Cloudflare's [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) gives you programmatic control over edge caching:

```javascript
export default {
  async fetch(request, env, ctx) {
    const cache = caches.default;
    
    // Try cache first
    let response = await cache.match(request);
    if (response) return response;
    
    // Fetch from origin
    response = await fetch(request);
    
    // Cache for 1 hour
    const cacheableResponse = new Response(response.body, response);
    cacheableResponse.headers.set('Cache-Control', 'public, max-age=3600');
    
    // Don't await - cache in background
    ctx.waitUntil(cache.put(request, cacheableResponse.clone()));
    
    return response;
  }
};
```

### Error handling

Network failures, origin timeouts, and API errors are inevitable. Build resilience:

```javascript
async function fetchWithRetry(url, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, {
                // 10 second timeout
                signal: AbortSignal.timeout(10000)
            });
            
            if (response.ok) return response;
            
            // Don't retry 4xx errors
            if (response.status >= 400 && response.status < 500) {
                return response;
            }
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            // Exponential backoff: 100ms, 200ms, 400ms
            await new Promise(r => setTimeout(r, 100 * Math.pow(2, i)));
        }
    }
}
```

### Monitoring and observability

Use [Logpush](https://developers.cloudflare.com/logs/get-started/) to send logs to your observability stack:

- **Request duration**: Track P50, P95, P99 latencies
- **Error rates**: Alert on spikes in 5xx responses  
- **CPU time**: Monitor to avoid hitting limits
- **Cache hit ratio**: Optimize caching strategy

Third-party tools like [Sentry](https://docs.sentry.io/platforms/javascript/guides/cloudflare-workers/) and [Axiom](https://axiom.co/docs/apps/cloudflare-workers) integrate well with Workers.

### Cost optimization

Workers pricing (as of 2024):
- **Free tier**: 100,000 requests/day
- **Paid tier**: $5/month for 10M requests, then $0.50 per million
- **Durable Objects**: $5/month for 1M requests + $0.20/GB-month storage

For a typical API serving 50M requests/month with light Durable Objects usage, expect around $30-40/month—far cheaper than running dedicated servers.

## Conclusion

Cloudflare Workers fundamentally change the deployment model for web applications. By running code at the edge with minimal cold starts and automatic global distribution, they enable experiences that simply aren't possible with traditional serverless platforms.

I've moved most of my side projects to Workers, and the difference in global latency is dramatic. A user in Sydney gets the same sub-100ms response time as someone in San Francisco. No CDN configuration, no multi-region deployments—just code that runs everywhere.

The combination of Workers for compute, Durable Objects for state, and R2 for storage creates a complete edge stack. If you're building APIs, webhooks, or any service where latency matters, Workers are worth serious consideration.

**Further reading:**
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Workers Examples](https://developers.cloudflare.com/workers/examples/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Miniflare](https://miniflare.dev/) - Local Workers simulator

---

*Cloudflare Workers from January 2024 — updated with production guidance.*

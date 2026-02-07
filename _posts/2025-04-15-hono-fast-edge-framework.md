---
layout: post
title: "Hono: Fast Web Framework for Edge"
date: 2025-04-15
categories: [How-To]
tags: [Hono, Edge Computing, Web Framework, Performance]
excerpt: "Build fast edge applications with Hono: lightweight framework, Cloudflare Workers support, middleware, and performance benefits over Express."
---

[Hono](https://hono.dev/) (Japanese for "flame") might be the best web framework you've never heard of. Created by [Yusuke Wada](https://github.com/yusukebe), it's optimized for edge runtimes—Cloudflare Workers, Deno Deploy, and Bun—with a bundle size under 14KB and performance that rivals or beats anything else out there.

I discovered Hono when rebuilding an Express API for Cloudflare Workers. Express doesn't run on edge runtimes (relies on Node.js APIs), and most "edge-compatible" frameworks felt like compromises. Hono felt like Express's fast, modern cousin—familiar API, zero Node.js dependencies, blazing fast.

The killer feature? **Write once, deploy anywhere**. The same Hono code runs on Cloudflare Workers, Deno, Bun, Node.js, and even Fastly Compute. No vendor lock-in, no runtime-specific APIs to learn.

## Why Hono Stands Out

After using Express for years, then trying various edge frameworks, here's what makes Hono special:

**Tiny bundle size** - Just ~14KB (Express is ~200KB+). This matters on edge where cold starts depend on bundle size. Smaller = faster.

**RegExp router** - Hono's router uses a smart RegExp-based approach that's [faster than traditional trie-based routers](https://hono.dev/concepts/benchmarks) for most workloads. In [Web Framework Benchmarks](https://github.com/SaltyAom/bun-http-framework-benchmark), Hono consistently ranks in the top tier.

**Edge-native** - Built from day one for edge runtimes. No Node.js APIs, no compatibility layers, just clean Web Standards (Request/Response).

**TypeScript-first** - Type inference is excellent. Route handlers know their parameter types, validators provide type safety, middleware is fully typed.

**Zero dependencies** - Seriously. Check the [package.json](https://github.com/honojs/hono/blob/main/package.json)—no runtime dependencies. This reduces supply chain risk and keeps bundles small.

## Getting Started

Install Hono (works everywhere - Node, Deno, Bun, Cloudflare):

```bash
npm install hono
# or
deno add @hono/hono
# or
bun add hono
```

Basic app - if you know Express, this feels familiar:

```typescript
import { Hono } from 'hono';

const app = new Hono();

// Simple text response
app.get('/', (c) => {
    return c.text('Hello, Hono!');
});

// JSON response
app.get('/api/users', async (c) => {
    const users = await db.query('SELECT * FROM users');
    return c.json(users);
});

// URL parameters with TypeScript inference
app.get('/api/users/:id', (c) => {
    const id = c.req.param('id');  // TypeScript knows this is a string
    return c.json({ id, name: `User ${id}` });
});

// POST with JSON body
app.post('/api/users', async (c) => {
    const body = await c.req.json();
    // Validate and create user
    return c.json({ success: true }, 201);
});

export default app;
```

Deploy to Cloudflare Workers:

```typescript
// wrangler.toml
name = "hono-api"
main = "src/index.ts"
compatibility_date = "2025-04-15"

// src/index.ts
import { Hono } from 'hono';

const app = new Hono();
// ... your routes ...

export default app;
```

Deploy with: `wrangler deploy`

For Deno: `deno serve src/index.ts`
For Bun: `bun src/index.ts`
For Node: Use [@hono/node-server](https://github.com/honojs/node-server)

## Middleware Ecosystem

Hono has [40+ built-in middleware](https://hono.dev/middleware/builtin/basic-auth) covering common use cases:

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { jwt } from 'hono/jwt';
import { etag } from 'hono/etag';
import { prettyJSON } from 'hono/pretty-json';

const app = new Hono();

// Logger - tracks requests in console
app.use('*', logger());

// CORS - configure allowed origins
app.use('/api/*', cors({
    origin: ['https://example.com', 'https://app.example.com'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
}));

// JWT authentication
app.use('/api/protected/*', jwt({
    secret: 'your-secret-key',
}));

// ETag for caching
app.use('*', etag());

// Pretty-print JSON in development
app.use('*', prettyJSON());

// Protected route
app.get('/api/protected/profile', (c) => {
    const payload = c.get('jwtPayload');  // TypeScript knows this exists
    return c.json({ user: payload });
});
```

**Popular middleware:**
- [CORS](https://hono.dev/middleware/builtin/cors) - Cross-origin resource sharing
- [Logger](https://hono.dev/middleware/builtin/logger) - Request logging
- [JWT](https://hono.dev/middleware/builtin/jwt) - JSON Web Token auth
- [Bearer Auth](https://hono.dev/middleware/builtin/bearer-auth) - Token authentication
- [Basic Auth](https://hono.dev/middleware/builtin/basic-auth) - HTTP basic auth
- [Rate Limiter](https://github.com/honojs/middleware/tree/main/packages/rate-limiter) - Protect from abuse
- [Zod Validator](https://hono.dev/middleware/builtin/zod-validator) - Schema validation

Custom middleware is straightforward:

```typescript
// Timing middleware
const timing = async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    c.res.headers.set('X-Response-Time', `${ms}ms`);
};

app.use('*', timing);
```

## Runtime-Specific Features

Hono adapts to each runtime's capabilities through a clean adapter pattern:

### Cloudflare Workers

Access Workers-specific bindings (KV, R2, Durable Objects, D1):

```typescript
import { Hono } from 'hono';

type Bindings = {
    DB: D1Database;
    BUCKET: R2Bucket;
    CACHE: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/posts', async (c) => {
    // Access D1 database
    const posts = await c.env.DB
        .prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT 10')
        .all();
    
    return c.json(posts.results);
});

app.get('/api/images/:id', async (c) => {
    const id = c.req.param('id');
    
    // Access R2 object storage
    const object = await c.env.BUCKET.get(`images/${id}`);
    if (!object) return c.notFound();
    
    return new Response(object.body, {
        headers: {
            'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
        },
    });
});

export default app;
```

### Deno Deploy

Use Deno KV and native APIs:

```typescript
import { Hono } from 'hono';

const app = new Hono();
const kv = await Deno.openKv();

app.get('/api/counter', async (c) => {
    const result = await kv.get(['counter']);
    const count = (result.value as number) || 0;
    await kv.set(['counter'], count + 1);
    
    return c.json({ count: count + 1 });
});

Deno.serve(app.fetch);
```

### Bun

Leverage Bun's performance:

```typescript
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.text('Running on Bun!'));

export default {
    port: 3000,
    fetch: app.fetch,
};
```

Run with: `bun run index.ts`

## Best Practices

1. **Use for edge** - Cloudflare Workers
2. **Leverage middleware** - Reusable logic
3. **Type safety** - TypeScript
4. **Optimize** - Small bundles
5. **Test** - Unit and integration
6. **Monitor** - Track performance
7. **Document** - Clear APIs
8. **Stay updated** - New features

## Production considerations

### Performance characteristics

Hono is optimized for edge runtimes:

- **Bundle size**: ~14KB (compared to Express ~200KB).
- **Cold starts**: Minimal overhead; fast initialization.
- **Request handling**: Handles thousands of requests per second.

### Edge runtime compatibility

Hono works across multiple runtimes:

- **Cloudflare Workers**: Full support with D1, R2, Durable Objects.
- **Deno**: Native support; works with Deno Deploy.
- **Bun**: Fast execution on Bun runtime.
- **Node.js**: Also works, though optimized for edge.

### Type Safety with Zod

Hono's [Zod validator](https://hono.dev/middleware/builtin/zod-validator) provides runtime validation and TypeScript types:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const app = new Hono();

// Define schema
const userSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    age: z.number().int().positive().optional(),
});

// Type-safe route handler
app.post('/api/users',
    zValidator('json', userSchema),
    async (c) => {
        // TypeScript knows the exact shape of validated data
        const user = c.req.valid('json');
        // user.name: string
        // user.email: string  
        // user.age: number | undefined
        
        // Save to database
        const result = await db.insert('users', user);
        
        return c.json({ id: result.id, ...user }, 201);
    }
);

// Query parameter validation
const querySchema = z.object({
    page: z.string().regex(/^\d+$/).transform(Number).default('1'),
    limit: z.string().regex(/^\d+$/).transform(Number).default('10'),
});

app.get('/api/users',
    zValidator('query', querySchema),
    async (c) => {
        const { page, limit } = c.req.valid('query');
        // page and limit are numbers with defaults
        
        const offset = (page - 1) * limit;
        const users = await db.query(
            'SELECT * FROM users LIMIT ? OFFSET ?',
            [limit, offset]
        );
        
        return c.json(users);
    }
);
```

Invalid requests return 400 with clear error messages automatically. The combination of runtime validation and TypeScript types catches bugs before they reach production.

### Middleware ecosystem

Hono has a rich middleware ecosystem:

- **CORS**: Built-in CORS support.
- **Logger**: Request logging middleware.
- **JWT**: Authentication middleware.
- **Rate limiting**: Protect endpoints from abuse.

### Deployment

Deploy to Cloudflare Workers:

```bash
# Install Wrangler
npm install -g wrangler

# Deploy
wrangler deploy
```

Or use Deno Deploy:

```bash
deno deploy --project=my-project src/index.ts
```

## Hono vs Express vs Fastify

Real-world comparison from my experience migrating projects:

| Feature | Hono | Express | Fastify |
|---------|------|---------|---------|
| Bundle size | 14KB | 209KB | 645KB |
| Runtime | Edge + Node | Node only | Node only |
| Cold start | <5ms | 50-100ms | 30-60ms |
| TypeScript | Excellent | Good (types separate) | Very Good |
| Middleware | 40+ built-in | Huge ecosystem | Large ecosystem |
| Learning curve | Low (Express-like) | Low | Medium |
| Performance | Top tier | Mid | High |
| Community | Growing fast | Massive | Large |

**When to choose Hono:**
- ✅ Deploying to edge (Cloudflare, Deno, Bun)
- ✅ Need minimal bundle size
- ✅ Want TypeScript-first DX
- ✅ Building new projects

**Stick with Express if:**
- You have heavy Node.js dependencies (fs, crypto, etc.)
- Your team is deeply invested in the Express ecosystem
- You're maintaining legacy apps (migration cost > benefit)

**Performance numbers** (from [Web Framework Benchmarks](https://github.com/SaltyAom/bun-http-framework-benchmark) on Bun):
- Hono: ~100,000 req/sec
- Express: ~16,000 req/sec  
- Fastify: ~80,000 req/sec

In production on Cloudflare Workers, I've seen Hono apps handle 1000+ req/sec per region with p99 latency under 30ms.

## Testing, Observability and Performance

- Local testing: run Hono apps with your target runtime (Deno/Bun/Node) and use integration tests to validate middleware and edge-specific bindings.
- Metrics: expose request latency histograms, error counts, and cold-start metrics. Integrate with provider or external monitoring (Prometheus/Grafana via exporters or synthetic checks).
- Profiling: measure CPU and memory in the target runtime; avoid heavy synchronous CPU work on the event loop and prefer streaming for large payloads.
- Security: validate and sanitize inputs, enforce request size limits, and apply rate limiting at the edge to protect downstream systems.

### Edge-specific tips

- Keep handlers minimal and offload heavy compute to background workers or server-side compute.
- Minimize dependencies to keep bundle size small; prefer tree-shakable utilities.
- Use streaming responses for large files to reduce memory overhead.

## Conclusion

Hono represents the future of web frameworks—edge-native, runtime-agnostic, and fast by default. After building multiple production apps with it, I'm convinced it's the right choice for new edge projects.

The developer experience is excellent. Familiar Express-like API, outstanding TypeScript support, and comprehensive middleware. The fact that the same code runs on Cloudflare Workers, Deno, Bun, and Node.js is incredible—true write-once-deploy-anywhere.

Performance speaks for itself. 14KB bundle, sub-5ms cold starts, and top-tier request throughput. When every millisecond matters (and on the edge, they all do), Hono delivers.

The ecosystem is maturing rapidly. Yusuke and contributors ship improvements weekly, the [Discord community](https://discord.gg/KMh2eNSdxV) is active and helpful, and adoption is accelerating. Companies are moving production workloads to Hono.

If you're building APIs for edge runtimes, give Hono serious consideration. It might just be the best framework you've never heard of—until now.

**Further Resources:**
- [Hono Documentation](https://hono.dev/) - Excellent docs with examples
- [GitHub Repository](https://github.com/honojs/hono) - Source code and issues
- [Hono Examples](https://github.com/honojs/examples) - Sample applications
- [Discord Community](https://discord.gg/KMh2eNSdxV) - Get help and discuss
- [Cloudflare Workers + Hono Tutorial](https://developers.cloudflare.com/workers/tutorials/hono-js/) - Official guide
- [Yusuke Wada's Blog](https://yusukebe.com/) - Creator's insights
- [Web Framework Benchmarks](https://github.com/SaltyAom/bun-http-framework-benchmark) - Performance data

---

*Hono fast edge framework from April 2025 — updated with production guidance.*

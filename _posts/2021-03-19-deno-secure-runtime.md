---
layout: post
title: "Deno: A Secure Runtime for JavaScript and TypeScript"
date: 2021-03-19
categories: [How-To]
tags: [Deno, JavaScript, TypeScript, Runtime]
excerpt: "Node.js runs with full system access by default. Deno asks permission first. After building CLI tools and APIs with Deno, here's when that security model—and built-in TypeScript—actually matters."
---

A junior developer on our team ran `npm install` on a package that, among other things, read environment variables and POSTed them to an external server. Supply chain attacks aren't theoretical. Node.js runs with full system access by default—file system, network, environment variables, subprocess execution. Every `npm install` is an act of trust.

Ryan Dahl (who created Node.js) built [Deno](https://deno.land/) to address what he saw as Node's design mistakes: security as opt-in rather than default, `node_modules` complexity, and CommonJS/ESM friction. Deno is provocative. It's also genuinely useful for specific workloads.

I wouldn't rewrite our production API in Deno tomorrow. But for CLI tools, scripts, and edge functions where security and TypeScript matter? It's become my default.

## What Makes Deno Different

| Feature | Deno | Node.js |
|---------|------|---------|
| Security | Explicit permissions | Full access by default |
| TypeScript | Built-in, no config | Requires setup |
| Modules | URL imports, no node_modules | npm + node_modules |
| Standard library | First-party, reviewed | Community packages |
| Tooling | fmt, lint, test, bundle built-in | Ecosystem tools |

Deno isn't "Node but newer." It's a different philosophy: secure by default, batteries included, web standards first.

## Getting Started

```bash
# Install
curl -fsSL https://deno.land/install.sh | sh
# Or: brew install deno

deno --version
```

No `package.json`. No `node_modules`. No `tsconfig.json`. Write TypeScript, run it:

```typescript
// hello.ts
console.log('Hello, Deno!');

deno run hello.ts
```

The simplicity is refreshing after years of JavaScript toolchain archaeology.

## Permissions: Security by Default

This is Deno's killer feature. By default, Deno can do nothing—no file access, no network, no environment variables, no subprocesses.

```bash
# Network only
deno run --allow-net server.ts

# File read + write
deno run --allow-read=./data --allow-write=./output script.ts

# Environment variables (specific)
deno run --allow-env=DATABASE_URL app.ts

# Everything (escape hatch)
deno run --allow-all script.ts  # Use sparingly
```

When you run without permissions, Deno tells you exactly what flag to add:

```
error: Requires net access to "api.example.com:443"
```

**For production scripts and CLIs distributed to users**, this matters. Your tool can't secretly phone home without the user explicitly granting network access.

### Runtime Permission Requests

```typescript
const status = await Deno.permissions.request({ name: "net", host: "api.example.com" });
if (status.state === "granted") {
    const response = await fetch("https://api.example.com/data");
}
```

Interactive permission prompts for user-facing applications.

## HTTP Server: Web Standards

Deno uses web platform APIs—`fetch`, `Request`, `Response`, `WebSocket`:

```typescript
Deno.serve({ port: 8000 }, (req) => {
    const url = new URL(req.url);
    
    if (url.pathname === "/api/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "content-type": "application/json" },
        });
    }
    
    return new Response("Not found", { status: 404 });
});
```

```bash
deno run --allow-net server.ts
```

No Express import. No framework required for simple APIs. The same `fetch` API you use in browsers works in Deno—skills transfer.

## Standard Library: Curated, Not Crowdsourced

```typescript
// File operations
const text = await Deno.readTextFile("./config.json");
await Deno.writeTextFile("./output.txt", "result");

// Directory iteration
for await (const entry of Deno.readDir("./src")) {
    console.log(entry.name);
}

// HTTP server (older std pattern — Deno.serve preferred now)
import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
```

Deno's standard library is reviewed by the core team. No guessing if a package is maintained or compromised—at least for std.

## Module System: URLs, Not node_modules

```typescript
// Import from URL — version pinned
import { serve } from "https://deno.land/std@0.200.0/http/server.ts";

// Import local files (TypeScript natively)
import { validateEmail } from "./utils/validation.ts";
```

No `npm install`. Dependencies are URLs, cached globally on your machine. `deno cache main.ts` pre-downloads everything.

**Import maps** for cleaner imports:

```json
{
    "imports": {
        "std/": "https://deno.land/std@0.200.0/",
        "@utils/": "./src/utils/"
    }
}
```

```typescript
import { serve } from "std/http/server.ts";
import { validateEmail } from "@utils/validation.ts";
```

```bash
deno run --import-map=import_map.json app.ts
```

**npm compatibility** arrived in Deno 1.28+ (`deno install npm:express`). You can use npm packages when needed, but the Deno-native approach is URL imports.

## Built-in Tooling

```bash
deno fmt          # Format code
deno lint         # Lint code
deno test         # Run tests
deno check app.ts # Type-check without running
deno compile      # Build standalone executable
```

No Prettier, ESLint, Jest, or Webpack configuration. One toolchain.

### Testing

```typescript
import { assertEquals, assertExists } from "https://deno.land/std@0.200.0/testing/asserts.ts";

Deno.test("adds numbers correctly", () => {
    assertEquals(1 + 1, 2);
});

Deno.test("fetches user data", async () => {
    const response = await fetch("https://api.example.com/users/1");
    assertEquals(response.status, 200);
    const user = await response.json();
    assertExists(user.name);
});
```

```bash
deno test --allow-net
```

## When I Reach for Deno

**Good fit:**
- CLI tools and scripts (especially distributed to others)
- Internal tools where security matters
- Prototyping APIs quickly
- Edge functions (Deno Deploy)
- Teaching JavaScript/TypeScript (less toolchain friction)
- Greenfield projects wanting TypeScript from line one

**Stick with Node.js:**
- Large existing Node codebases
- npm ecosystem dependencies you can't live without
- Teams deeply invested in Node tooling
- Libraries targeting maximum distribution

## Deno Deploy: Edge Runtime

Deno's hosted platform runs Deno at the edge globally:

```typescript
// Deploy to Deno Deploy — no config needed
Deno.serve(async (req) => {
    const data = await fetch("https://api.example.com/data");
    return new Response(data.body, {
        headers: { "content-type": "application/json" },
    });
});
```

Git push → global deployment. Free tier for side projects. Competitive with Cloudflare Workers for simple edge APIs.

## Practical Tips

1. **Start restrictive on permissions** — add only what you need
2. **Pin dependency versions** in URLs — `std@0.200.0`, not `std@latest`
3. **Use `deno.json`** for project config (tasks, imports, lint rules)
4. **Compile standalone binaries** — `deno compile --allow-net -o mycli main.ts`
5. **Leverage web APIs** — `fetch`, `crypto`, `WebSocket` work identically to browsers
6. **Check npm compatibility** — many packages work; some don't (native addons)

## Conclusion

Deno won't replace Node.js in most production environments tomorrow. The npm ecosystem's gravity is immense. But Deno's ideas—secure by default, TypeScript native, web standard APIs, integrated tooling—are influencing the entire JavaScript runtime space.

For scripts that touch sensitive data, CLI tools you distribute, quick APIs, and edge functions, Deno is my first choice. The permission model alone justifies it: code can't access the network or file system without explicit user consent.

Node taught the world JavaScript on the server. Deno asks: what if we designed it differently knowing what we know now? Whether you adopt Deno or not, that question produces better tools everywhere.

Try it for your next script. You'll miss `node_modules` exactly zero times.

---

*Deno secure runtime from March 2021, covering permissions, standard library, and modern JavaScript features.*

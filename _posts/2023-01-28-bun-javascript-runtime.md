---
layout: post
title: "Bun: The Fast All-in-One JavaScript Runtime"
date: 2023-01-28
categories: [How-To]
tags: [Bun, JavaScript, Runtime, Performance]
excerpt: "I replaced Node.js with Bun on a side project and cut cold-start times by 90%. Here's what Bun actually is, where it shines, and where it still makes you reach for Node."
---

My CI pipeline was spending more time installing dependencies than running tests. Forty-five seconds for `npm install` on a project with maybe thirty packages. I was debugging a flaky test suite when a colleague sent me a link to [Bun](https://bun.sh) with the subject line "this can't be real."

It was real. `bun install` finished in under two seconds. I was skeptical — I'd been burned by "Node killers" before — but I spent a weekend porting a small API and the numbers didn't lie. Startup time dropped from ~50ms to ~5ms. The test runner was built in. TypeScript ran without a compile step. I wasn't ready to rip Node out of production, but I understood why people were excited.

Bun isn't just a faster Node.js. It's a runtime, bundler, test runner, and package manager in one binary, built on JavaScriptCore (Safari's engine) instead of V8. That architectural choice matters: different tradeoffs, different performance profile, and a bet that the JavaScript ecosystem is tired of juggling five tools to ship one service.

## What Bun Actually Is (And Isn't)

When I first heard "all-in-one JavaScript runtime," I assumed marketing fluff. Then I looked at what ships in the box:

- **Runtime** — executes JavaScript and TypeScript, similar role to Node.js
- **Bundler** — esbuild-class bundling without adding webpack to your life
- **Test runner** — Jest-compatible API, no separate install
- **Package manager** — npm-compatible, dramatically faster installs

The "isn't" part is important. Bun is not a drop-in replacement for every Node.js workload today. Native modules, obscure `node:*` APIs, and enterprise tooling that hardcodes `npm`/`node` will trip you up. I hit a `sharp` image-processing issue on day one that took an hour to debug. Compatibility is good and improving fast, but "good" and "complete" aren't the same thing.

Check the [official compatibility docs](https://bun.sh/docs/runtime/nodejs-apis) before you promise your team a weekend migration.

## Getting Started

Installation is refreshingly simple:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Verify
bun --version
```

On macOS I also use Homebrew (`brew install oven-sh/bun/bun`), but the curl installer works everywhere and matches what CI expects. After install, `bun --version` should print something like `1.x` — if it doesn't, your shell probably needs a restart to pick up the PATH change.

## Running Code: The First "Wait, Really?" Moment

### Scripts and TypeScript

```bash
# Run JavaScript file
bun run index.js

# Run TypeScript directly
bun run index.ts
```

No `ts-node`. No `tsc --watch` in another terminal. I threw a messy TypeScript file at it — generics, async/await, path imports — and it just ran. For small services and scripts, that alone saves real cognitive overhead.

The mental model: `bun run` is your entry point for anything you'd previously do with `node` or `ts-node`.

### Package Management

```bash
# Install package
bun install express

# Add dependency
bun add express

# Remove dependency
bun remove express
```

`bun install` reads your existing `package-lock.json` or generates a `bun.lockb` (binary lockfile). The speed comes from parallel downloads and a native implementation — not magic, just engineering focused on the one thing every developer does fifty times a day.

One gotcha I learned: some CI caches don't know about `bun.lockb` yet. Add it to your cache key or you'll wonder why installs are still slow.

## API Compatibility: Where Bun Meets the Real World

### Node.js APIs

Bun implements a large subset of Node.js APIs. The stuff you actually use in most backends works:

```javascript
// File system
import { readFile } from 'fs/promises';
const data = await readFile('file.txt');

// HTTP server
import { createServer } from 'http';
const server = createServer((req, res) => {
    res.end('Hello from Bun!');
});
server.listen(3000);
```

I ported a file-processing script that used `fs/promises` and `http` without changes. That's the happy path. The unhappy path is reaching for a niche `node:dgram` or `node:worker_threads` edge case and finding partial support. Always test your specific dependency tree.

### Web APIs

Bun leans into Web Standard APIs, which is where things get interesting for code that runs in both browser and server:

```javascript
// Fetch API
const response = await fetch('https://api.example.com/data');
const data = await response.json();

// WebSocket
const ws = new WebSocket('ws://localhost:8080');
```

`fetch` is built-in — no `node-fetch` polyfill, no version mismatch between your runtime and your bundler. For API clients and glue scripts, this is genuinely nicer than the Node.js experience was in 2022.

## Performance: Numbers With Context

### Startup Time

```bash
# Node.js
time node index.js
# ~50ms

# Bun
time bun run index.js
# ~5ms
```

Ten times faster startup sounds like a benchmark flex until you're running CLI tools hundreds of times in CI, or spinning up serverless-adjacent workers, or building a dev server that restarts on every save. The aggregate time savings add up.

These numbers vary by machine, import graph, and what your script does at module load time. Don't quote "5ms" to your VP — measure your actual entry point.

### HTTP Server

Bun also ships a native HTTP server that's absurdly fast for simple workloads:

```javascript
// Bun HTTP server
export default {
    port: 3000,
    fetch(request) {
        return new Response('Hello from Bun!');
    }
};
```

This uses the Web `fetch` handler pattern — same shape as Cloudflare Workers and Deno. I built a health-check endpoint and a JSON API with this in an afternoon. For production services with complex middleware stacks, I still reach for Express or Hono, but for microservices and internal tools, the built-in server is plenty.

See the [Bun HTTP server docs](https://bun.sh/docs/api/http) for routing, WebSockets, and TLS.

## Testing Without the Jest Tax

Bun's test runner was the feature that sold me on using it for greenfield projects:

```javascript
import { test, expect } from 'bun:test';

test('adds numbers', () => {
    expect(2 + 2).toBe(4);
});
```

```bash
bun test
```

No `jest.config.js`. No `ts-jest` fighting your ESM setup. No twenty-second test startup. For a new library or internal package, this alone justifies trying Bun.

The API is Jest-compatible enough that migration isn't painful, but it's not identical. Read the [testing docs](https://bun.sh/docs/cli/test) before porting a 2,000-test suite.

## Bundling: One Fewer Config File

```bash
bun build ./src/index.ts --outdir ./dist --target node
```

I replaced a webpack config that nobody on the team fully understood with a one-liner. For application bundling with code splitting and complex asset pipelines, you might still want Vite or esbuild directly. For "compile my TypeScript library to JavaScript," Bun's bundler is enough.

## Where I Actually Use Bun (And Where I Don't)

**Use Bun when:**

- Starting a new project and you control the dependency list
- Scripts and CLIs that run frequently (startup time matters)
- Internal tools where "fast install + fast test" improves daily life
- Prototyping APIs before committing to a full framework

**Stick with Node when:**

- You depend on native modules with limited Bun support
- Production infrastructure is standardized on Node (Docker images, observability agents, vendor SDKs)
- Your team has deep Node expertise and no pain point Bun solves

I run Bun for dev tooling and side projects. Production services that touch money still run on Node LTS until I've validated every dependency in staging. Pragmatism beats hype.

## Lessons From a Weekend Migration

The project that convinced me was a small REST API — Express, PostgreSQL, JWT auth. Migration took six hours, not six minutes:

1. **Dependency audit first** — I listed every `require`/`import` and checked Bun compatibility before touching code
2. **Run tests early** — `bun test` exposed a subtle `Buffer` behavior difference I would have missed manually
3. **Keep Node in CI temporarily** — dual-running both runtimes for a week caught one production-only issue
4. **Measure, don't assume** — startup was faster; one database-heavy endpoint was identical (Bun doesn't fix slow SQL)

The migration succeeded because the scope was small and the team wasn't betting the business on it.

## Practical Takeaways

Bun is the most compelling JavaScript runtime release since Deno, and more immediately useful for day-to-day development. The all-in-one tooling story isn't marketing — it genuinely removes friction. The performance gains are real for startup-bound workloads.

But it's January 2023 technology. Ecosystem maturity takes years. Treat Bun as a power tool in your belt, not a religion.

**My current setup:** Bun for scripts, tests, and new small services. Node for production monoliths and anything with a gnarly native dependency tree. Revisit every quarter as the [compatibility table](https://bun.sh/docs/runtime/nodejs-apis) grows.

If your `npm install` is eating your soul, install Bun this afternoon and time the difference. Worst case, you lose ten minutes. Best case, you stop waiting for your tools and start writing code.

---

*Bun JavaScript runtime — January 2023. The ecosystem moves fast; check [bun.sh](https://bun.sh) for current compatibility and release notes.*

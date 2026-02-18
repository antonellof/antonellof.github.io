---
layout: post
title: "Bun: The Fast All-in-One JavaScript Runtime"
date: 2023-01-28
categories: [How-To]
tags: [Bun, JavaScript, Runtime, Performance]
excerpt: "Explore Bun: fast JavaScript runtime, bundler, test runner, and package manager. Learn installation, API compatibility, performance benefits, and when to use Bun."
---

Bun is a fast all-in-one JavaScript runtime. After using Bun in production, here's how to leverage it effectively.

## What is Bun?

Bun provides:
- **JavaScript runtime** - Like Node.js
- **Bundler** - Build tool
- **Test runner** - Testing framework
- **Package manager** - npm alternative

## Installation

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Verify
bun --version
```

## Basic Usage

### Run Scripts

```bash
# Run JavaScript file
bun run index.js

# Run TypeScript directly
bun run index.ts
```

### Package Management

```bash
# Install package
bun install express

# Add dependency
bun add express

# Remove dependency
bun remove express
```

## API Compatibility

### Node.js APIs

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

### Web APIs

```javascript
// Fetch API
const response = await fetch('https://api.example.com/data');
const data = await response.json();

// WebSocket
const ws = new WebSocket('ws://localhost:8080');
```

## Performance

### Startup Time

```bash
# Node.js
time node index.js
# ~50ms

# Bun
time bun run index.js
# ~5ms
```

### HTTP Server

```javascript
// Bun HTTP server
export default {
    port: 3000,
    fetch(request) {
        return new Response('Hello from Bun!');
    }
};
```

## Best Practices

1. **Use for new projects** - Better performance
2. **Test compatibility** - Verify Node.js APIs
3. **Leverage speed** - Fast startup
4. **Use bundler** - Built-in bundling
5. **TypeScript support** - Native TS
6. **Monitor** - Track performance
7. **Stay updated** - New features
8. **Document** - Team knowledge

## Conclusion

Bun enables:
- Fast runtime
- All-in-one tooling
- Better performance
- Modern features

Use Bun for new projects or performance-critical applications. The runtime shown here provides significant performance improvements.

---

*Bun JavaScript runtime from January 2023, covering installation, usage, and performance.*

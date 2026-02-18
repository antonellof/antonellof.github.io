---
layout: post
title: "Deno: A Secure Runtime for JavaScript and TypeScript"
date: 2021-03-19
categories: [How-To]
tags: [Deno, JavaScript, TypeScript, Runtime]
excerpt: "Learn Deno: secure by default, built-in TypeScript, modern JavaScript runtime. Build web servers, CLI tools, and applications with Deno's security model and standard library."
---

Deno provides a secure JavaScript/TypeScript runtime. After building applications with Deno, here's how to use it effectively.

## What is Deno?

Deno features:
- **Secure by default** - Explicit permissions
- **TypeScript** - Built-in support
- **Standard library** - No external dependencies
- **Modern** - ES modules, async/await

## Installation

```bash
# Install Deno
curl -fsSL https://deno.land/install.sh | sh

# Or with Homebrew
brew install deno

# Verify
deno --version
```

## Basic Usage

### Hello World

```typescript
// hello.ts
console.log('Hello, Deno!');

// Run
deno run hello.ts
```

### HTTP Server

```typescript
// server.ts
Deno.serve((req) => {
    return new Response('Hello, Deno!', {
        headers: { 'content-type': 'text/plain' },
    });
}, { port: 8000 });
```

## Permissions

### Explicit Permissions

```bash
# Network permission
deno run --allow-net server.ts

# File system permission
deno run --allow-read --allow-write script.ts

# All permissions
deno run --allow-all script.ts
```

### Permission Prompts

```typescript
// Request permission
const status = await Deno.permissions.request({ name: 'net', host: 'example.com' });
if (status.state === 'granted') {
    // Use network
}
```

## Standard Library

### HTTP Server

```typescript
import { serve } from 'https://deno.land/std@0.200.0/http/server.ts';

serve((req) => {
    return new Response('Hello from Deno!');
}, { port: 8000 });
```

### File Operations

```typescript
// Read file
const text = await Deno.readTextFile('./data.txt');

// Write file
await Deno.writeTextFile('./output.txt', 'Hello, Deno!');

// Read directory
for await (const dirEntry of Deno.readDir('./')) {
    console.log(dirEntry.name);
}
```

## Web APIs

### Fetch

```typescript
const response = await fetch('https://api.example.com/data');
const data = await response.json();
console.log(data);
```

### WebSocket

```typescript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
    ws.send('Hello, Server!');
};

ws.onmessage = (event) => {
    console.log('Received:', event.data);
};
```

## Modules

### Import from URL

```typescript
// Import from URL
import { serve } from 'https://deno.land/std@0.200.0/http/server.ts';

// Import from local file
import { helper } from './helper.ts';
```

### Import Maps

```json
// import_map.json
{
    "imports": {
        "http/": "https://deno.land/std@0.200.0/http/",
        "fs/": "https://deno.land/std@0.200.0/fs/"
    }
}
```

```typescript
// Use import map
import { serve } from 'http/server.ts';

// Run with import map
deno run --import-map=import_map.json app.ts
```

## Testing

### Deno Test

```typescript
// test.ts
import { assertEquals } from 'https://deno.land/std@0.200.0/testing/asserts.ts';

Deno.test('should add numbers', () => {
    assertEquals(1 + 1, 2);
});
```

```bash
# Run tests
deno test
```

## Best Practices

1. **Use permissions** - Explicit and minimal
2. **TypeScript** - Leverage type safety
3. **Standard library** - Use built-in modules
4. **Import maps** - Manage dependencies
5. **Testing** - Write tests
6. **Formatting** - Use deno fmt
7. **Linting** - Use deno lint
8. **Documentation** - Clear code

## Conclusion

Deno provides:
- Secure runtime
- TypeScript support
- Modern features
- Standard library

Use Deno for secure, modern applications. The patterns shown here work for production.

---

*Deno secure runtime from March 2021, covering permissions, standard library, and modern JavaScript features.*

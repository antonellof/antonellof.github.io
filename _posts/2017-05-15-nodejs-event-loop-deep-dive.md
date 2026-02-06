---
layout: post
title: "Node.js Event Loop Deep Dive"
date: 2017-05-15
categories: [Deep Dive]
tags: [Node.js, JavaScript, Performance, Event Loop]
excerpt: "Understanding Node.js event loop internals, phases, timers, and how asynchronous operations work under the hood for better performance optimization."
---

Understanding the Node.js event loop is crucial for writing performant applications. After debugging countless performance issues, I've learned that knowing how the event loop works separates good Node.js developers from great ones.

## What is the Event Loop?

The event loop is what allows Node.js to perform non-blocking I/O operations. Despite JavaScript being single-threaded, Node.js achieves concurrency through the event loop.

```
┌───────────────────────────┐
│   JavaScript Code         │
│   (Call Stack)            │
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│   Event Loop              │
│   ┌─────────────────────┐ │
│   │ Timers              │ │
│   │ Pending Callbacks   │ │
│   │ Idle, Prepare       │ │
│   │ Poll                │ │
│   │ Check               │ │
│   │ Close Callbacks     │ │
│   └─────────────────────┘ │
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│   Thread Pool (libuv)     │
│   - File System           │
│   - DNS                   │
│   - Crypto                │
└───────────────────────────┘
```

## Event Loop Phases

The event loop has 6 phases that execute in order:

### 1. Timers Phase

Executes callbacks scheduled by `setTimeout()` and `setInterval()`:

```javascript
setTimeout(() => {
    console.log('Timer 1');
}, 0);

setTimeout(() => {
    console.log('Timer 2');
}, 0);

// Both execute in Timers phase
```

### 2. Pending Callbacks Phase

Executes I/O callbacks deferred to the next loop iteration:

```javascript
const fs = require('fs');

fs.readFile('file.txt', (err, data) => {
    // Executes in Pending Callbacks phase
    console.log('File read');
});
```

### 3. Idle, Prepare Phase

Internal use only.

### 4. Poll Phase

Retrieves new I/O events and executes I/O related callbacks:

```javascript
// Poll phase checks for:
// - New I/O events
// - Timers that are ready
// - setImmediate callbacks

const http = require('http');

const server = http.createServer((req, res) => {
    // Executes in Poll phase
    res.end('Hello');
});

server.listen(3000);
```

### 5. Check Phase

Executes `setImmediate()` callbacks:

```javascript
setImmediate(() => {
    console.log('setImmediate 1');
});

setImmediate(() => {
    console.log('setImmediate 2');
});

// Both execute in Check phase
```

### 6. Close Callbacks Phase

Executes close callbacks (e.g., `socket.on('close')`):

```javascript
const server = require('http').createServer();

server.on('close', () => {
    // Executes in Close Callbacks phase
    console.log('Server closed');
});

server.close();
```

## Understanding Execution Order

```javascript
console.log('1. Start');

setTimeout(() => console.log('2. setTimeout'), 0);

setImmediate(() => console.log('3. setImmediate'));

process.nextTick(() => console.log('4. nextTick'));

Promise.resolve().then(() => console.log('5. Promise'));

console.log('6. End');

// Output:
// 1. Start
// 6. End
// 4. nextTick        (highest priority)
// 5. Promise         (microtask queue)
// 2. setTimeout      (timers phase)
// 3. setImmediate    (check phase)
```

## Microtasks: nextTick and Promises

### process.nextTick()

Highest priority, executes before any other async operation:

```javascript
console.log('1');

process.nextTick(() => {
    console.log('2');
});

console.log('3');

// Output: 1, 3, 2
```

### Promise Queue

Executes after `nextTick` but before timers:

```javascript
Promise.resolve().then(() => {
    console.log('Promise 1');
});

process.nextTick(() => {
    console.log('nextTick 1');
});

Promise.resolve().then(() => {
    console.log('Promise 2');
});

// Output:
// nextTick 1
// Promise 1
// Promise 2
```

## Blocking the Event Loop

### CPU-Intensive Operations

```javascript
// BAD: Blocks event loop
function fibonacci(n) {
    if (n < 2) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

app.get('/fib/:n', (req, res) => {
    const result = fibonacci(parseInt(req.params.n));
    res.json({ result });
    // Blocks event loop for large n!
});

// GOOD: Use worker threads or break up work
const { Worker } = require('worker_threads');

app.get('/fib/:n', (req, res) => {
    const worker = new Worker('./fib-worker.js', {
        workerData: { n: parseInt(req.params.n) }
    });
    
    worker.on('message', (result) => {
        res.json({ result });
    });
});
```

### Synchronous File Operations

```javascript
// BAD: Blocks event loop
const data = fs.readFileSync('large-file.txt');

// GOOD: Non-blocking
fs.readFile('large-file.txt', (err, data) => {
    // Handled asynchronously
});
```

## Event Loop Best Practices

### 1. Break Up Long-Running Tasks

```javascript
// Process array in chunks
function processArray(array, chunkSize = 1000) {
    let index = 0;
    
    function processChunk() {
        const chunk = array.slice(index, index + chunkSize);
        
        for (const item of chunk) {
            processItem(item);
        }
        
        index += chunkSize;
        
        if (index < array.length) {
            // Yield to event loop
            setImmediate(processChunk);
        }
    }
    
    processChunk();
}
```

### 2. Use setImmediate for Deferring

```javascript
// Defer execution to next event loop iteration
function processRequest(req, res) {
    // Do some work
    
    setImmediate(() => {
        // This runs after current phase completes
        sendResponse(res);
    });
}
```

### 3. Avoid process.nextTick in Recursion

```javascript
// BAD: Can starve event loop
function recursive() {
    process.nextTick(recursive);
    // Never yields to other operations
}

// GOOD: Use setImmediate
function recursive() {
    setImmediate(recursive);
    // Yields to other phases
}
```

## Monitoring Event Loop

### Check Event Loop Lag

```javascript
const { performance } = require('perf_hooks');

let lastCheck = performance.now();

setInterval(() => {
    const now = performance.now();
    const lag = now - lastCheck - 1000; // Should be ~0
    
    if (lag > 10) {
        console.warn(`Event loop lag: ${lag}ms`);
    }
    
    lastCheck = now;
}, 1000);
```

### Monitor Blocking Operations

```javascript
const { performance, PerformanceObserver } = require('perf_hooks');

const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        if (entry.duration > 100) {
            console.warn(`Long operation: ${entry.name} took ${entry.duration}ms`);
        }
    }
});

obs.observe({ entryTypes: ['measure'] });

// Measure operation
performance.mark('start');
// ... do work ...
performance.mark('end');
performance.measure('operation', 'start', 'end');
```

## Common Pitfalls

### 1. Unbounded Recursion

```javascript
// BAD
function process() {
    // Do work
    process(); // Infinite recursion
}

// GOOD
function process() {
    // Do work
    setImmediate(process); // Yields to event loop
}
```

### 2. Synchronous Loops

```javascript
// BAD: Blocks event loop
for (let i = 0; i < 1000000; i++) {
    processItem(items[i]);
}

// GOOD: Yield periodically
async function processItems(items) {
    for (let i = 0; i < items.length; i++) {
        processItem(items[i]);
        
        if (i % 1000 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
}
```

### 3. Memory Leaks in Closures

```javascript
// BAD: Keeps references alive
function createHandler() {
    const largeData = new Array(1000000).fill(0);
    
    return function(req, res) {
        // largeData stays in memory
        res.send('OK');
    };
}

// GOOD: Clear references
function createHandler() {
    return function(req, res) {
        const data = getData(); // Get when needed
        res.send('OK');
        // data can be garbage collected
    };
}
```

## Performance Optimization

### Use Worker Threads for CPU-Intensive Tasks

```javascript
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
    // Main thread
    function processData(data) {
        return new Promise((resolve, reject) => {
            const worker = new Worker(__filename, {
                workerData: data
            });
            
            worker.on('message', resolve);
            worker.on('error', reject);
        });
    }
} else {
    // Worker thread
    const result = heavyComputation(workerData);
    parentPort.postMessage(result);
}
```

### Batch Operations

```javascript
// Instead of many small operations
items.forEach(item => {
    processItem(item); // Many event loop ticks
});

// Batch operations
const batch = [];
items.forEach(item => {
    batch.push(item);
    
    if (batch.length === 100) {
        processBatch(batch);
        batch.length = 0;
    }
});
```

## Conclusion

Understanding the event loop helps you:
- Write non-blocking code
- Optimize performance
- Debug issues faster
- Make better architectural decisions

Key takeaways:
- Event loop has 6 phases
- `nextTick` and Promises are microtasks
- Break up long-running tasks
- Monitor event loop lag
- Use worker threads for CPU-intensive work

Master the event loop, and you'll write better Node.js applications.

---

*Event loop deep dive from May 2017, covering Node.js 8.x event loop behavior.*

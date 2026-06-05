---
layout: post
title: "Node.js Event Loop Deep Dive"
date: 2017-05-14
categories: [Deep Dive]
tags: [Node.js, JavaScript, Performance, Event Loop]
excerpt: "Your API was fast until one endpoint computed Fibonacci and froze everything. Here's how the Node.js event loop actually works—and how to stop accidentally DDOS-ing yourself."
---

# Node.js Event Loop Deep Dive

Our API was humming along at 200 requests per second when someone shipped a "quick utility endpoint" that computed Fibonacci numbers recursively. No malice. No load test. Just `GET /fib/40` and the entire server developed amnesia.

Every other request queued up behind a CPU-bound calculation running on Node's one and only main thread. Timeouts cascaded. Health checks failed. Kubernetes killed pods. New pods got the same request. It was a feedback loop of sadness.

The fix wasn't "add more servers." The fix was understanding what the event loop actually does—and what it absolutely refuses to do for you.

If you've ever wondered why `setTimeout(fn, 0)` doesn't run immediately, or why your async code runs in a different order than you wrote it, this is the explanation.

## What the Event Loop Actually Is

Node.js is single-threaded for JavaScript execution. One call stack. One thread running your code.

And yet it handles thousands of concurrent connections. The trick isn't threads—it's the event loop, a mechanism that lets Node delegate slow work (I/O, DNS, file system) to the system and continue processing other requests while waiting.

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

Your JavaScript runs on the call stack. When you call `fs.readFile`, Node hands the work to libuv's thread pool and registers a callback. When the file is read, the callback enters the event loop queue. When the loop reaches the right phase, your callback runs.

This model is brilliant for I/O-bound work. It's hostile to CPU-bound work. The Fibonacci endpoint wasn't slow because Node is bad—it was slow because we treated a single-threaded runtime like a compute cluster.

## The Six Phases (In Order, Every Tick)

Each event loop iteration—one "tick"—runs through these phases in order:

### 1. Timers

Callbacks scheduled by `setTimeout()` and `setInterval()`:

```javascript
setTimeout(() => {
    console.log('Timer 1');
}, 0);

setTimeout(() => {
    console.log('Timer 2');
}, 0);

// Both execute in Timers phase
```

`setTimeout(fn, 0)` means "run this in the Timers phase of the *next* tick," not "run this right now." The call stack must clear first.

### 2. Pending Callbacks

I/O callbacks deferred from the previous iteration—often TCP error handlers and similar:

```javascript
const fs = require('fs');

fs.readFile('file.txt', (err, data) => {
    // Executes in Pending Callbacks phase
    console.log('File read');
});
```

### 3. Idle, Prepare

Internal libuv housekeeping. You don't interact with this. libuv does.

### 4. Poll

The workhorse phase. Retrieves new I/O events and executes I/O callbacks:

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

If there are no callbacks ready, the poll phase waits for new events (with a timeout). This is where Node "blocks" efficiently—not blocking the thread, but waiting for something to happen.

### 5. Check

`setImmediate()` callbacks run here:

```javascript
setImmediate(() => {
    console.log('setImmediate 1');
});

setImmediate(() => {
    console.log('setImmediate 2');
});

// Both execute in Check phase
```

`setImmediate` runs after I/O callbacks in the poll phase. It's the "run this after the current batch of I/O" mechanism.

### 6. Close Callbacks

Cleanup callbacks—`socket.on('close')`, etc.:

```javascript
const server = require('http').createServer();

server.on('close', () => {
    // Executes in Close Callbacks phase
    console.log('Server closed');
});

server.close();
```

## The Execution Order Quiz Everyone Fails

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

If you got that wrong, you're in excellent company. Here's the cheat sheet:

1. **Synchronous code** runs first (1, 6)
2. **`process.nextTick`** runs before everything else async (4)
3. **Promises** run after nextTick, before the event loop phases (5)
4. **`setTimeout`** runs in the Timers phase (2)
5. **`setImmediate`** runs in the Check phase (3)

The relative order of `setTimeout(0)` vs `setImmediate` can actually flip depending on whether you're inside an I/O callback. That's a fun interview question and a real debugging footgun.

## Microtasks: The Queue That Cuts in Line

### process.nextTick()

Highest priority. Runs between every phase, before Promises, before timers:

```javascript
console.log('1');

process.nextTick(() => {
    console.log('2');
});

console.log('3');

// Output: 1, 3, 2
```

`nextTick` doesn't wait for the event loop to advance. It runs immediately after the current operation completes.

### Promise Queue

After `nextTick`, before timers:

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

Microtasks (nextTick + Promises) can starve the event loop if you recurse through them. More on that shortly.

## Blocking the Event Loop: How to DDOS Yourself

### CPU-Intensive Work

The Fibonacci incident, documented for posterity:

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

Node 10 introduced worker threads (experimental in 10, more stable by 2018). Before that, the options were `child_process`, breaking work into chunks with `setImmediate`, or not doing CPU-heavy work on your API server.

The rule: **if it doesn't yield, it blocks.** Regex on huge strings, JSON.parse on megabyte payloads, synchronous crypto, image processing—all event loop blockers.

### Synchronous File I/O

```javascript
// BAD: Blocks event loop
const data = fs.readFileSync('large-file.txt');

// GOOD: Non-blocking
fs.readFile('large-file.txt', (err, data) => {
    // Handled asynchronously
});
```

`readFileSync` is fine at startup for config files. It's not fine handling uploads in a request handler.

## Keeping the Loop Breathing

### Chunk Long Tasks

Can't use worker threads? Yield periodically:

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

Each `setImmediate` lets other callbacks run between chunks. Total processing time increases slightly; responsiveness improves dramatically.

### setImmediate vs process.nextTick for Deferring

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

Use `setImmediate` when you want to yield to the event loop. Use `nextTick` when you need something to run before any other async operation—but be careful with recursion.

### The nextTick Starvation Trap

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

Recursive `nextTick` prevents I/O callbacks, timers, and everything else from running. Your server becomes a very expensive no-op machine.

## Monitoring: Measure the Invisible

### Event Loop Lag

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

If your 1000ms interval fires at 1050ms, the event loop was blocked for ~50ms. Occasional small lag is normal. Sustained high lag means something is blocking.

### Long Operations

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

Instrument suspicious code paths. The Fibonacci endpoint would have shown up immediately as a 30-second "operation."

## Pitfalls We Keep Stepping In

### Unbounded Recursion

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

### Synchronous Loops Over Large Collections

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

### Memory Leaks in Closures

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

Closures that capture large objects live as long as the handler lives. In a long-running server, that's a slow memory leak.

## Performance Patterns That Actually Help

### Worker Threads for CPU Work

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

Workers have startup cost. Use them for work that takes hundreds of milliseconds, not microseconds.

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

Fewer context switches, better cache locality, happier event loop.

## The Bottom Line

The event loop isn't an implementation detail—it's the contract between your code and Node's concurrency model.

What matters in practice:

- Six phases per tick: timers → pending → idle → poll → check → close
- Microtasks (`nextTick`, Promises) run between phases and can starve I/O if you abuse them
- CPU-bound work blocks everything. Delegate to workers, chunk with `setImmediate`, or use a different service
- Monitor event loop lag. If you can't see blocking, you can't fix it
- `setTimeout(0)` is not "run now." `readFileSync` is not "fine because it's simple."

Master the event loop and you stop guessing why production slows down at 2 PM. You know. You measure. You fix the actual bottleneck.

Our Fibonacci endpoint? Deleted. Replaced with a precomputed lookup table for the values anyone actually needed. Sometimes the best performance optimization is asking product whether anyone truly needs `/fib/40`.

---

*Event loop deep dive from May 2017, covering Node.js 8.x behavior via libuv. Worker threads were experimental in Node 10 (released later in 2018). The phase model and microtask semantics remain accurate in modern Node.*

---
layout: post
title: "gRPC Streaming: Bidirectional Communication Patterns"
date: 2021-02-24
categories: [Architecture]
tags: [gRPC, Streaming, Microservices]
excerpt: "Unary RPC is REST with better serialization. Streaming is where gRPC earns its keep—server push, client uploads, and bidirectional pipes that make WebSockets jealous."
---

We migrated internal APIs from REST to gRPC for performance—binary protobuf, HTTP/2 multiplexing, generated type-safe clients. Latency dropped 40%. Everyone was happy.

Then someone tried to return 50,000 log entries in a single response. The client OOM'd. Another team streamed a 2GB file upload through a unary RPC with a 4MB message limit. It failed silently. A third team built a chat feature with polling because nobody knew gRPC could stream.

Unary RPC (one request, one response) is gRPC's default and gRPC's ceiling if you stop there. **Streaming** is where gRPC separates from REST in ways that matter: server push, client uploads, bidirectional pipes—all over one HTTP/2 connection with flow control built in.

## Four RPC Types

| Type | Request | Response | Use case |
|------|---------|----------|----------|
| Unary | 1 | 1 | Standard API calls |
| Server streaming | 1 | Many | Large datasets, live feeds |
| Client streaming | Many | 1 | Uploads, batch ingestion |
| Bidirectional | Many | Many | Chat, real-time collaboration |

Defined in your `.proto`:

```protobuf
service DataService {
    rpc GetUser(GetUserRequest) returns (User);                          // Unary
    rpc StreamLogs(StreamLogsRequest) returns (stream LogEntry);         // Server streaming
    rpc UploadMetrics(stream Metric) returns (UploadResponse);           // Client streaming
    rpc Chat(stream ChatMessage) returns (stream ChatMessage);           // Bidirectional
}
```

## Server-Side Streaming: Server Pushes Data

One request triggers a stream of responses. Client reads until the server closes.

```javascript
// Server
function streamUsers(call) {
    const users = getUsers();  // Could be millions
    
    users.forEach(user => {
        call.write(user);  // Stream one at a time — no memory bomb
    });
    
    call.end();
}

// Client
const stream = client.streamUsers({ department: 'engineering' });

stream.on('data', (user) => {
    console.log('Received:', user.name);
    processUser(user);  // Process incrementally
});

stream.on('end', () => {
    console.log('Stream complete');
});

stream.on('error', (err) => {
    console.error('Stream failed:', err);
});
```

**Use server streaming for:**
- Large query results (logs, metrics, database exports)
- Real-time feeds (stock prices, sensor data)
- File downloads (chunked transfer)
- Progress updates during long operations

**Why not paginate with unary?** Pagination works but adds round-trip latency per page. Streaming is one connection, continuous flow, backpressure-aware.

## Client-Side Streaming: Client Pushes Data

Client sends a stream of requests. Server responds once when the stream ends.

```javascript
// Server
function uploadMetrics(call, callback) {
    const metrics = [];
    let count = 0;
    
    call.on('data', (metric) => {
        metrics.push(metric);
        count++;
        
        // Optional: process incrementally instead of buffering
        if (count % 1000 === 0) {
            console.log(`Received ${count} metrics so far`);
        }
    });
    
    call.on('end', () => {
        saveMetrics(metrics)
            .then(() => callback(null, { received: count, status: 'ok' }))
            .catch(err => callback(err));
    });
    
    call.on('error', (err) => {
        callback(err);
    });
}

// Client
const stream = client.uploadMetrics((error, response) => {
    if (error) return console.error(error);
    console.log(`Uploaded ${response.received} metrics`);
});

for (const metric of generateMetrics()) {
    stream.write(metric);
}
stream.end();  // Signal done — triggers server response
```

**Use client streaming for:**
- Bulk data upload (metrics, logs, sensor batches)
- File uploads in chunks
- Batch operations where client has many items

## Bidirectional Streaming: Full Duplex

Both sides send streams independently. Neither waits for the other to finish.

```javascript
// Server
function chat(call) {
    call.on('data', (message) => {
        console.log(`From ${message.userId}: ${message.text}`);
        
        // Broadcast to room, echo, etc.
        call.write({
            id: generateId(),
            userId: 'server',
            text: `Echo: ${message.text}`,
            timestamp: Date.now()
        });
    });
    
    call.on('end', () => {
        call.end();
    });
}

// Client
const stream = client.chat();

stream.on('data', (message) => {
    displayMessage(message);
});

// Send messages anytime
sendButton.onclick = () => {
    stream.write({ userId: 'me', text: input.value });
};
```

**Use bidirectional streaming for:**
- Chat and messaging
- Collaborative editing (Google Docs-style)
- Gaming (player positions, actions)
- Real-time audio/video signaling

This is WebSocket territory—but with protobuf, HTTP/2 flow control, and generated types. Trade-off: less browser-native than WebSockets (need grpc-web proxy).

## Error Handling: Streams Fail Mid-Flight

Unary errors are simple (status code). Stream errors can happen after partial delivery:

```javascript
// Server
function streamLogs(call) {
    try {
        for (const log of getLogs()) {
            if (call.cancelled) return;  // Client disconnected
            call.write(log);
        }
        call.end();
    } catch (error) {
        call.destroy({
            code: grpc.status.INTERNAL,
            message: error.message
        });
    }
}

// Client
stream.on('error', (error) => {
    if (error.code === grpc.status.UNAVAILABLE) {
        // Retry with backoff
    }
    console.error(`Stream error: ${error.code} - ${error.message}`);
});
```

**Rules:**
- Handle client disconnect (`call.cancelled`)
- Use appropriate gRPC status codes
- Client should handle partial data + error (what you received is still valid)
- Implement retry for idempotent streams

## Flow Control and Backpressure

gRPC uses HTTP/2 flow control, but fast producers can still overwhelm slow consumers:

```javascript
const stream = client.streamLargeDataset({});

let pending = 0;
const MAX_PENDING = 10;

stream.on('data', async (chunk) => {
    pending++;
    
    if (pending >= MAX_PENDING) {
        stream.pause();  // Stop reading from server
    }
    
    await processChunk(chunk);
    pending--;
    
    if (pending < MAX_PENDING) {
        stream.resume();
    }
});
```

If your `processChunk` is async and slow, pause the stream. Otherwise you buffer unbounded data in memory and OOM.

## Choosing the Right Pattern

| Scenario | Pattern | Why |
|----------|---------|-----|
| Get user by ID | Unary | Simple request/response |
| Export 1M database rows | Server streaming | Memory-efficient, one connection |
| Upload batch of 10K events | Client streaming | Server processes on stream end |
| Chat room | Bidirectional | Both sides send anytime |
| File download | Server streaming | Chunked delivery |
| Health check | Unary | No streaming needed |

Default to unary. Add streaming when payload size, real-time requirements, or upload patterns demand it. Streaming adds complexity—client reconnection, partial failure handling, debugging difficulty.

## Production Best Practices

1. **Set message size limits** — default 4MB; increase consciously
2. **Set deadlines/timeouts** — `call.setDeadline(Date.now() + 30000)`
3. **Handle cancellation** — clients disconnect; clean up server resources
4. **Monitor stream duration and message count** — long streams need attention
5. **Use keepalive** — detect dead connections
6. **Test disconnect scenarios** — client crash mid-stream, network partition
7. **Document stream protocols** — message ordering expectations, idempotency

## Conclusion

gRPC streaming isn't a niche feature—it's the reason to choose gRPC over REST for data-intensive internal APIs. Unary RPC is fine REST with better serialization. Streaming is genuinely different: memory-efficient large data transfer, real-time bidirectional communication, and HTTP/2 flow control without building it yourself.

The OOM from 50,000 log entries? Server-side streaming, process incrementally. The 2GB upload failure? Client-side streaming with chunked messages. The chat feature with polling? Bidirectional streaming.

Pick the RPC type in your `.proto` based on data direction and volume. Handle errors mid-stream. Respect backpressure. Your gRPC services will do things REST can't without bolting on WebSockets, chunked encoding, and prayer.

---

*gRPC streaming patterns from February 2021, covering unary, server-side, client-side, and bidirectional streaming.*

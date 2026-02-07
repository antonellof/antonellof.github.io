---
layout: post
title: "gRPC Streaming: Bidirectional Communication Patterns"
date: 2021-02-15
categories: [Architecture]
tags: [gRPC, Streaming, Microservices]
excerpt: "Implement gRPC streaming patterns: unary, server-side, client-side, and bidirectional streaming. Learn when to use each pattern and production best practices."
---

gRPC streaming enables efficient data transfer. After implementing streaming in production, here's how to use each pattern effectively.

## Streaming Types

### Unary RPC

**Request-Response:**
- Single request
- Single response
- Simple pattern

```protobuf
rpc GetUser(GetUserRequest) returns (User);
```

### Server-Side Streaming

**Server streams data:**
- Single request
- Multiple responses
- Server pushes data

```protobuf
rpc StreamUsers(StreamUsersRequest) returns (stream User);
```

### Client-Side Streaming

**Client streams data:**
- Multiple requests
- Single response
- Client pushes data

```protobuf
rpc CreateUsers(stream CreateUserRequest) returns (CreateUsersResponse);
```

### Bidirectional Streaming

**Both stream:**
- Multiple requests
- Multiple responses
- Full-duplex

```protobuf
rpc Chat(stream ChatMessage) returns (stream ChatMessage);
```

## Server-Side Streaming

### Implementation

```javascript
// Server
function streamUsers(call) {
    const users = [
        { id: '1', name: 'John' },
        { id: '2', name: 'Jane' },
        { id: '3', name: 'Bob' }
    ];
    
    users.forEach(user => {
        call.write(user);
    });
    
    call.end();
}

// Client
const stream = client.streamUsers({});
stream.on('data', (user) => {
    console.log('User:', user);
});
stream.on('end', () => {
    console.log('Stream ended');
});
```

### Use Cases

- **Large datasets** - Stream results
- **Real-time updates** - Push notifications
- **File transfer** - Chunked data

## Client-Side Streaming

### Implementation

```javascript
// Server
function createUsers(call, callback) {
    const users = [];
    
    call.on('data', (request) => {
        users.push({
            id: generateId(),
            name: request.name,
            email: request.email
        });
    });
    
    call.on('end', () => {
        // Save all users
        saveUsers(users).then(() => {
            callback(null, {
                count: users.length,
                users: users
            });
        });
    });
}

// Client
const stream = client.createUsers((error, response) => {
    if (error) {
        console.error('Error:', error);
        return;
    }
    console.log('Created users:', response.count);
});

users.forEach(user => {
    stream.write({ name: user.name, email: user.email });
});

stream.end();
```

### Use Cases

- **Batch uploads** - Multiple items
- **Log aggregation** - Stream logs
- **Metrics collection** - Stream metrics

## Bidirectional Streaming

### Implementation

```javascript
// Server
function chat(call) {
    call.on('data', (message) => {
        console.log('Received:', message.text);
        
        // Echo back
        call.write({
            id: generateId(),
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
    console.log('Received:', message.text);
});

stream.write({ text: 'Hello' });
stream.write({ text: 'World' });
stream.end();
```

### Use Cases

- **Chat applications** - Real-time messaging
- **Game servers** - Player updates
- **Collaborative editing** - Document sync

## Error Handling

### Server Error

```javascript
// Server
function streamUsers(call) {
    try {
        const users = getUsers();
        users.forEach(user => {
            call.write(user);
        });
        call.end();
    } catch (error) {
        call.emit('error', {
            code: grpc.status.INTERNAL,
            message: error.message
        });
    }
}

// Client
stream.on('error', (error) => {
    console.error('Stream error:', error);
});
```

## Flow Control

### Backpressure

```javascript
// Client with backpressure
const stream = client.streamLargeData({});

let received = 0;
const maxPending = 10;
let pending = 0;

stream.on('data', (data) => {
    pending++;
    received++;
    
    processData(data).then(() => {
        pending--;
        
        // Resume if below threshold
        if (pending < maxPending) {
            stream.resume();
        }
    });
    
    // Pause if too many pending
    if (pending >= maxPending) {
        stream.pause();
    }
});
```

## Best Practices

1. **Handle errors** - Graceful error handling
2. **Flow control** - Manage backpressure
3. **Close streams** - Proper cleanup
4. **Timeout handling** - Prevent hanging
5. **Monitor streams** - Track performance
6. **Test thoroughly** - Edge cases
7. **Document patterns** - Clear usage
8. **Use appropriately** - Right pattern for use case

## Conclusion

gRPC streaming enables:
- Efficient data transfer
- Real-time communication
- Flexible patterns
- High performance

Choose the right streaming pattern for your use case. The patterns shown here handle production workloads.

---

*gRPC streaming patterns from February 2021, covering unary, server-side, client-side, and bidirectional streaming.*

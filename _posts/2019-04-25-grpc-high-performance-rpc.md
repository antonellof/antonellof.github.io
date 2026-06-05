---
layout: post
title: "gRPC: High-Performance RPC Framework"
date: 2019-04-25
categories: [How-To]
tags: [gRPC, RPC, Performance, Microservices]
excerpt: "REST was fine until our services started gossiping in JSON like it was a book club. gRPC gave us typed contracts, HTTP/2 multiplexing, and fewer 3am 'field name changed' incidents."
---

Our microservices were "communicating." What they were actually doing was sending JSON over HTTP/1.1, parsing strings into objects, hoping field names matched, and retrying when they didn't.

It worked—until we had fifty internal endpoints and versioning became a game of "who broke the contract this time?" REST is great for public APIs humans curl from documentation. For **service-to-service chatter at scale**, we wanted something faster, stricter, and less interpretive dance.

Enter gRPC: Google's RPC framework that uses Protocol Buffers for serialization and HTTP/2 for transport. Binary payloads. Strong contracts. Streaming when you need it. In 2019 it was already battle-tested inside Google; by the time we adopted it, the open-source ecosystem had caught up enough for mere mortals.

## What gRPC actually gives you

- **Language-agnostic** — generate clients and servers from the same `.proto` file
- **Protocol Buffers** — compact binary serialization (smaller and faster than JSON for most payloads)
- **HTTP/2** — multiplexed connections, header compression, one TCP connection for many RPCs
- **Streaming** — server, client, and bidirectional streams for real-time patterns
- **Type-safe contracts** — the schema is the API; drift shows up at compile time, not in production

If your services talk to each other more than they talk to browsers, gRPC deserves a serious look.

## Define the contract first (always)

Everything starts with a `.proto` file. This is your API constitution:

```protobuf
// user.proto
syntax = "proto3";

package user;

service UserService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc CreateUser(CreateUserRequest) returns (User);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
  rpc StreamUsers(StreamUsersRequest) returns (stream User);
}

message GetUserRequest {
  string user_id = 1;
}

message CreateUserRequest {
  string name = 1;
  string email = 2;
}

message ListUsersRequest {
  int32 page = 1;
  int32 page_size = 2;
}

message ListUsersResponse {
  repeated User users = 1;
  int32 total = 2;
}

message StreamUsersRequest {
  string filter = 1;
}

message User {
  string id = 1;
  string name = 2;
  string email = 3;
  int64 created_at = 4;
}
```

Field numbers are permanent. Renaming `user_id` to `id` is fine; reusing field number `1` for a different type is how you summon backward-compatibility demons. Treat `.proto` changes like database migrations—review carefully.

Generate code with `protoc` and language plugins. The generated stubs are boring; that's the point.

## Node.js server

```bash
npm install @grpc/grpc-js @grpc/proto-loader
npm install -D grpc-tools
```

```javascript
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDefinition = protoLoader.loadSync('user.proto', {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});

const userProto = grpc.loadPackageDefinition(packageDefinition).user;

const users = [
    { id: '1', name: 'John Doe', email: 'john@example.com', created_at: Date.now() },
    { id: '2', name: 'Jane Smith', email: 'jane@example.com', created_at: Date.now() }
];

function getUser(call, callback) {
    const user = users.find(u => u.id === call.request.user_id);
    if (!user) {
        return callback({
            code: grpc.status.NOT_FOUND,
            message: 'User not found'
        });
    }
    callback(null, user);
}

function createUser(call, callback) {
    const user = {
        id: String(users.length + 1),
        name: call.request.name,
        email: call.request.email,
        created_at: Date.now()
    };
    users.push(user);
    callback(null, user);
}

function listUsers(call, callback) {
    const page = call.request.page || 1;
    const pageSize = call.request.page_size || 10;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    
    callback(null, {
        users: users.slice(start, end),
        total: users.length
    });
}

function streamUsers(call) {
    users.forEach(user => {
        call.write(user);
    });
    call.end();
}

const server = new grpc.Server();

server.addService(userProto.UserService.service, {
    getUser,
    createUser,
    listUsers,
    streamUsers
});

server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
    server.start();
    console.log('gRPC server running on port 50051');
});
```

`createInsecure()` is fine for localhost. Production gets TLS. We'll come back to that.

## Node.js client

```javascript
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDefinition = protoLoader.loadSync('user.proto', {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});

const userProto = grpc.loadPackageDefinition(packageDefinition).user;

const client = new userProto.UserService(
    'localhost:50051',
    grpc.credentials.createInsecure()
);

// Unary call
client.getUser({ user_id: '1' }, (error, user) => {
    if (error) {
        console.error('Error:', error);
        return;
    }
    console.log('User:', user);
});

// Streaming call
const stream = client.streamUsers({ filter: '' });
stream.on('data', (user) => {
    console.log('User:', user);
});
stream.on('end', () => {
    console.log('Stream ended');
});
```

Reuse the client. HTTP/2 connection pooling is built in—creating a new client per request defeats half the performance win.

## Python server

```python
import grpc
import time
from concurrent import futures
import user_pb2
import user_pb2_grpc

class UserService(user_pb2_grpc.UserServiceServicer):
    def __init__(self):
        self.users = [
            user_pb2.User(
                id='1',
                name='John Doe',
                email='john@example.com',
                created_at=1234567890
            )
        ]
    
    def GetUser(self, request, context):
        user = next((u for u in self.users if u.id == request.user_id), None)
        if not user:
            context.set_code(grpc.StatusCode.NOT_FOUND)
            context.set_details('User not found')
            return user_pb2.User()
        return user
    
    def CreateUser(self, request, context):
        user = user_pb2.User(
            id=str(len(self.users) + 1),
            name=request.name,
            email=request.email,
            created_at=int(time.time())
        )
        self.users.append(user)
        return user
    
    def ListUsers(self, request, context):
        page = request.page or 1
        page_size = request.page_size or 10
        start = (page - 1) * page_size
        end = start + page_size
        
        return user_pb2.ListUsersResponse(
            users=self.users[start:end],
            total=len(self.users)
        )
    
    def StreamUsers(self, request, context):
        for user in self.users:
            yield user

def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    user_pb2_grpc.add_UserServiceServicer_to_server(UserService(), server)
    server.add_insecure_port('[::]:50051')
    server.start()
    print('gRPC server running on port 50051')
    server.wait_for_termination()

if __name__ == '__main__':
    serve()
```

Thread pool sizing matters. Too few workers and unary RPCs queue; too many and you context-switch into sadness.

## Streaming: when one request/response isn't enough

### Server-side streaming (server pushes many messages)

```protobuf
rpc StreamUsers(StreamUsersRequest) returns (stream User);
```

```javascript
function streamUsers(call) {
    const interval = setInterval(() => {
        const user = {
            id: String(Math.random()),
            name: 'User',
            email: 'user@example.com',
            created_at: Date.now()
        };
        call.write(user);
    }, 1000);
    
    call.on('cancelled', () => {
        clearInterval(interval);
    });
}
```

Great for feeds, live updates, large result sets you don't want to buffer in memory.

### Client-side streaming (client sends many, server responds once)

```protobuf
rpc CreateUsers(stream CreateUserRequest) returns (CreateUsersResponse);
```

```javascript
function createUsers(call, callback) {
    const users = [];
    
    call.on('data', (request) => {
        const user = {
            id: String(users.length + 1),
            name: request.name,
            email: request.email,
            created_at: Date.now()
        };
        users.push(user);
    });
    
    call.on('end', () => {
        callback(null, { users, count: users.length });
    });
}
```

Bulk uploads, log ingestion, "here's a thousand records, tell me when you're done."

### Bidirectional streaming (both sides talk)

```protobuf
rpc Chat(stream ChatMessage) returns (stream ChatMessage);
```

```javascript
function chat(call) {
    call.on('data', (message) => {
        // Echo message back
        call.write({
            id: message.id,
            text: `Echo: ${message.text}`,
            timestamp: Date.now()
        });
    });
    
    call.on('end', () => {
        call.end();
    });
}
```

Chat, collaborative editing, real-time gaming—anywhere both ends have something to say.

## Error handling (use status codes, not string vibes)

gRPC has a rich status model. Use it:

```javascript
function getUser(call, callback) {
    const user = users.find(u => u.id === call.request.user_id);
    
    if (!user) {
        return callback({
            code: grpc.status.NOT_FOUND,
            message: 'User not found',
            details: `User ID: ${call.request.user_id}`
        });
    }
    
    callback(null, user);
}

// Client-side error handling
client.getUser({ user_id: '999' }, (error, user) => {
    if (error) {
        if (error.code === grpc.status.NOT_FOUND) {
            console.log('User not found');
        } else {
            console.error('Error:', error.message);
        }
        return;
    }
    console.log('User:', user);
});
```

Map domain errors to `NOT_FOUND`, `INVALID_ARGUMENT`, `ALREADY_EXISTS`, etc. Your clients—and your observability—will thank you.

## Interceptors: middleware for RPC

Cross-cutting concerns belong in interceptors, not copy-pasted into every handler.

### Server interceptor

```javascript
const interceptor = (options, nextCall) => {
    return new grpc.InterceptingCall(nextCall(options), {
        start: function(metadata, listener, next) {
            // Add metadata
            metadata.add('request-id', generateRequestId());
            
            // Log request
            console.log('Request:', metadata.getMap());
            
            next(metadata, listener);
        },
        sendMessage: function(message, next) {
            console.log('Sending:', message);
            next(message);
        },
        recvMessage: function(message, next) {
            console.log('Receiving:', message);
            next(message);
        }
    });
};

const server = new grpc.Server();
server.use(interceptor);
```

### Client interceptor

```javascript
const interceptor = (options, nextCall) => {
    return new grpc.InterceptingCall(nextCall(options), {
        start: function(metadata, listener, next) {
            metadata.add('client-version', '1.0.0');
            next(metadata, listener);
        }
    });
};

const client = new userProto.UserService(
    'localhost:50051',
    grpc.credentials.createInsecure(),
    { interceptors: [interceptor] }
);
```

Auth tokens, request IDs, logging, retries with backoff—interceptors are where they live.

## Production lessons

**Protobuf efficiency is real** but not magic. Tiny payloads won't notice; large nested structures and high QPS will.

**Handle errors with gRPC status codes**, not ad-hoc error fields in every message. Consistency scales across services.

**Use streaming for large or live data** instead of paginating yourself into latency hell.

**Set deadlines/timeouts on every call.** A hung upstream shouldn't hang your entire fleet. Clients should pass context with timeout; servers should respect cancellation.

**Interceptors for auth and observability** keep handlers focused on business logic.

**Version services explicitly**—package names, service names, or separate endpoints. "We'll just add fields" works until it doesn't.

**Monitor RPC latency and error rates** per method. Prometheus gRPC middleware exists for most languages.

**Reuse connections.** One client instance per upstream service, not per request.

## When gRPC vs REST?

| Use gRPC | Stick with REST |
|----------|-----------------|
| Internal service mesh | Browser-facing public APIs |
| High-throughput RPC | Simple CRUD with wide tooling support |
| Strong contracts across teams | Third-party integrations expecting JSON |
| Streaming workloads | Webhooks and human-debuggable curl |

Many teams run both: gRPC inside the cluster, REST/GraphQL at the edge via a gateway (grpc-gateway, Envoy, etc.).

## The bottom line

gRPC won't fix a bad service boundary. It will make the boundary **explicit, fast, and harder to accidentally break**—which, after enough JSON schema surprises, feels like luxury.

Start with one internal service pair. Define the `.proto`, generate code, wire unary RPCs, add TLS before production, then explore streaming where it actually helps.

Your 3am pages will still happen. They'll just involve fewer "unexpected token" errors.

---

*Written April 2019, covering gRPC 1.20+ and @grpc/grpc-js. gRPC-Web, service mesh integration, and tooling have matured since; typed contracts and HTTP/2 transport remain the core value.*

---
layout: post
title: "gRPC: High-Performance RPC Framework"
date: 2019-04-25
categories: [How-To]
tags: [gRPC, RPC, Performance, Microservices]
excerpt: "Build high-performance microservices with gRPC. Learn protocol buffers, streaming, error handling, and production patterns for inter-service communication."
---

gRPC provides high-performance RPC for microservices. After building production gRPC services, here's how to use it effectively.

## What is gRPC?

gRPC is:
- **Language-agnostic** RPC framework
- Uses **Protocol Buffers** for serialization
- **HTTP/2** based
- **Streaming** support
- **Type-safe** contracts

## Protocol Buffers

### Define Service

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

## Node.js Server

### Installation

```bash
npm install @grpc/grpc-js @grpc/proto-loader
npm install -D grpc-tools
```

### Server Implementation

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

## Node.js Client

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

## Python Server

```python
import grpc
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

## Streaming

### Server-Side Streaming

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

### Client-Side Streaming

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

### Bidirectional Streaming

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

## Error Handling

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

## Interceptors

### Server Interceptor

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

### Client Interceptor

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

## Best Practices

1. **Use Protocol Buffers** - Efficient serialization
2. **Handle errors properly** - Use gRPC status codes
3. **Use streaming** - For large datasets
4. **Implement timeouts** - Prevent hanging calls
5. **Use interceptors** - For logging/auth
6. **Version services** - Support multiple versions
7. **Monitor performance** - Track latency/errors
8. **Use connection pooling** - Reuse connections

## Conclusion

gRPC provides:
- High performance
- Type safety
- Streaming support
- Language interoperability

Use gRPC for inter-service communication in microservices. The patterns shown here handle production workloads.

---

*gRPC high-performance RPC from April 2019, covering gRPC 1.20+ features.*

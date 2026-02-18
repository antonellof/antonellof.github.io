---
layout: post
title: "WebSocket Architecture for Real-Time Applications"
date: 2020-04-03
categories: [Architecture]
tags: [WebSocket, Real-Time, Architecture]
excerpt: "Design real-time applications with WebSockets. Learn connection management, scaling strategies, message patterns, and production architectures for chat, notifications, and live updates."
---

WebSockets enable real-time bidirectional communication. After building production WebSocket applications, here's how to architect them effectively.

## WebSocket Basics

### What are WebSockets?

WebSockets provide:
- **Full-duplex** communication
- **Persistent** connections
- **Low latency** - No HTTP overhead
- **Real-time** updates

### Connection Lifecycle

```
Client                    Server
  |                         |
  |--- HTTP Upgrade ------>|
  |<-- 101 Switching -----|
  |                         |
  |=== WebSocket ==========|
  |                         |
  |<-- Message ------------|
  |--- Message ----------->|
  |                         |
  |--- Close ------------->|
```

## Basic Implementation

### Node.js Server

```javascript
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws, req) => {
    console.log('Client connected');
    
    ws.on('message', (message) => {
        console.log('Received:', message);
        
        // Echo message back
        ws.send(`Echo: ${message}`);
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});
```

### Client

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
    console.log('Connected');
    ws.send('Hello Server!');
};

ws.onmessage = (event) => {
    console.log('Received:', event.data);
};

ws.onerror = (error) => {
    console.error('Error:', error);
};

ws.onclose = () => {
    console.log('Disconnected');
};
```

## Connection Management

### Connection Pool

```javascript
class ConnectionManager {
    constructor() {
        this.connections = new Map();
    }
    
    addConnection(userId, ws) {
        // Store connection
        this.connections.set(userId, ws);
        
        // Handle disconnect
        ws.on('close', () => {
            this.connections.delete(userId);
        });
    }
    
    sendToUser(userId, message) {
        const ws = this.connections.get(userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }
    
    broadcast(message) {
        this.connections.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        });
    }
    
    getConnectionCount() {
        return this.connections.size;
    }
}
```

## Authentication

### Token-Based Auth

```javascript
const jwt = require('jsonwebtoken');

const wss = new WebSocket.Server({
    port: 8080,
    verifyClient: (info) => {
        // Extract token from query string
        const token = new URL(info.req.url, 'http://localhost').searchParams.get('token');
        
        if (!token) {
            return false;
        }
        
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            info.req.user = decoded;
            return true;
        } catch (error) {
            return false;
        }
    }
});

wss.on('connection', (ws, req) => {
    const user = req.user;
    console.log(`User ${user.id} connected`);
    
    // Store user connection
    connectionManager.addConnection(user.id, ws);
});
```

## Message Patterns

### Request-Response

```javascript
// Server
wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        const message = JSON.parse(data);
        
        if (message.type === 'getUser') {
            const user = getUserById(message.userId);
            ws.send(JSON.stringify({
                id: message.id,
                type: 'getUserResponse',
                data: user
            }));
        }
    });
});

// Client
function getUser(userId) {
    return new Promise((resolve, reject) => {
        const messageId = generateId();
        
        ws.onmessage = (event) => {
            const response = JSON.parse(event.data);
            if (response.id === messageId) {
                resolve(response.data);
            }
        };
        
        ws.send(JSON.stringify({
            id: messageId,
            type: 'getUser',
            userId: userId
        }));
    });
}
```

### Pub/Sub Pattern

```javascript
const Redis = require('ioredis');
const redis = new Redis();

class PubSubManager {
    constructor() {
        this.subscriptions = new Map();
    }
    
    subscribe(ws, channel) {
        if (!this.subscriptions.has(channel)) {
            this.subscriptions.set(channel, new Set());
            
            // Subscribe to Redis
            redis.subscribe(channel);
        }
        
        this.subscriptions.get(channel).add(ws);
    }
    
    unsubscribe(ws, channel) {
        const subscribers = this.subscriptions.get(channel);
        if (subscribers) {
            subscribers.delete(ws);
            
            if (subscribers.size === 0) {
                redis.unsubscribe(channel);
                this.subscriptions.delete(channel);
            }
        }
    }
    
    publish(channel, message) {
        redis.publish(channel, JSON.stringify(message));
    }
}

// Handle Redis messages
redis.on('message', (channel, message) => {
    const subscribers = pubSubManager.subscriptions.get(channel);
    if (subscribers) {
        subscribers.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });
    }
});
```

## Scaling Strategies

### Horizontal Scaling

```javascript
// Use Redis for shared state
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

class DistributedConnectionManager {
    constructor(serverId) {
        this.serverId = serverId;
        this.connections = new Map();
        this.setupRedis();
    }
    
    setupRedis() {
        // Subscribe to messages from other servers
        redis.psubscribe(`server:*:message`);
        
        redis.on('pmessage', (pattern, channel, message) => {
            const data = JSON.parse(message);
            this.handleRemoteMessage(data);
        });
    }
    
    addConnection(userId, ws) {
        this.connections.set(userId, ws);
        
        // Store in Redis
        redis.set(`user:${userId}:server`, this.serverId);
        
        ws.on('close', () => {
            this.connections.delete(userId);
            redis.del(`user:${userId}:server`);
        });
    }
    
    sendToUser(userId, message) {
        // Check if user is on this server
        const ws = this.connections.get(userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        } else {
            // Publish to Redis for other servers
            redis.publish(`server:${this.serverId}:message`, JSON.stringify({
                userId,
                message
            }));
        }
    }
    
    handleRemoteMessage(data) {
        const ws = this.connections.get(data.userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data.message));
        }
    }
}
```

### Load Balancer Configuration

```nginx
# nginx.conf
upstream websocket {
    ip_hash;  # Sticky sessions
    server server1:8080;
    server server2:8080;
    server server3:8080;
}

server {
    listen 80;
    
    location / {
        proxy_pass http://websocket;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Error Handling

### Reconnection Logic

```javascript
class WebSocketClient {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
    }
    
    connect() {
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
            console.log('Connected');
            this.reconnectAttempts = 0;
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        this.ws.onclose = () => {
            console.log('Disconnected');
            this.reconnect();
        };
    }
    
    reconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
            
            console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
            
            setTimeout(() => {
                this.connect();
            }, delay);
        } else {
            console.error('Max reconnection attempts reached');
        }
    }
    
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        } else {
            console.error('WebSocket is not open');
        }
    }
}
```

## Heartbeat/Ping-Pong

```javascript
// Server
wss.on('connection', (ws) => {
    let isAlive = true;
    
    ws.on('pong', () => {
        isAlive = true;
    });
    
    const interval = setInterval(() => {
        if (!isAlive) {
            ws.terminate();
            clearInterval(interval);
            return;
        }
        
        isAlive = false;
        ws.ping();
    }, 30000); // 30 seconds
    
    ws.on('close', () => {
        clearInterval(interval);
    });
});

// Client
ws.on('pong', () => {
    console.log('Received pong');
});

// Send ping
setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
    }
}, 30000);
```

## Best Practices

1. **Handle reconnections** - Automatic reconnection
2. **Use heartbeat** - Detect dead connections
3. **Scale horizontally** - Use Redis/pub-sub
4. **Authenticate** - Secure connections
5. **Rate limit** - Prevent abuse
6. **Monitor connections** - Track metrics
7. **Handle errors** - Graceful degradation
8. **Use sticky sessions** - Load balancer config

## Conclusion

WebSocket architecture enables:
- Real-time communication
- Low latency
- Bidirectional data flow
- Scalable systems

Start with basic connections, then add scaling and error handling. The patterns shown here handle production workloads.

---

*WebSocket architecture from April 2020, covering real-time application patterns.*

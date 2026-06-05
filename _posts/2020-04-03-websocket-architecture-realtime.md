---
layout: post
title: "WebSocket Architecture for Real-Time Applications"
date: 2020-04-03
categories: [Architecture]
tags: [WebSocket, Real-Time, Architecture]
excerpt: "HTTP polling made our chat app feel like email. WebSockets fixed that—and introduced a whole new category of production problems. Connection management, scaling across nodes, and reconnection logic that doesn't DDOS your own server."
---

Our first "real-time" chat feature used HTTP long polling. Every two seconds, every connected client asked the server "anything new?" The database hated us. Users hated the lag. The AWS bill hated both of us.

WebSockets fixed the user experience immediately—persistent connections, instant message delivery, bidirectional communication without the HTTP overhead tax. Then we hit production scale and learned WebSockets create their own problems: connection state lives in memory, load balancers need sticky sessions, and mobile networks drop connections constantly.

This is the architecture guide I needed before our chat app melted a single Node.js process at 2,000 concurrent connections.

## Why WebSockets (And When Polling Is Fine)

WebSockets provide full-duplex communication over a single TCP connection. After an HTTP upgrade handshake, both client and server can push data anytime.

**Use WebSockets when:**
- Sub-second latency matters (chat, live dashboards, collaborative editing)
- Server needs to push data without client asking
- High message frequency makes polling wasteful

**Stick with HTTP/SSE when:**
- Updates are infrequent (every 30+ seconds)
- You need simple caching and CDN support
- Your infrastructure team fears persistent connections

Server-Sent Events (SSE) is the underrated middle ground—server push over HTTP, simpler than WebSockets, good enough for notifications and live feeds.

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

One TCP connection. No repeated handshakes. No polling overhead. Magic—until you have 50,000 connections and one server.

## Basic Implementation: Hello Real-Time

### Node.js Server

```javascript
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws, req) => {
    console.log('Client connected');
    
    ws.on('message', (message) => {
        console.log('Received:', message);
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

This works on localhost. Production needs authentication, connection management, error handling, and a plan for when you need more than one server.

## Connection Management: Who's Online?

Every connected client is a socket in memory. You need a registry:

```javascript
class ConnectionManager {
    constructor() {
        this.connections = new Map();
    }
    
    addConnection(userId, ws) {
        this.connections.set(userId, ws);
        
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

Always check `readyState === WebSocket.OPEN` before sending. Writing to a closing socket throws errors or silently drops messages.

**Memory math:** 50,000 connections × ~10KB per socket ≈ 500MB just for connection state. Plan your server sizing accordingly.

## Authentication: Don't Leave the Door Open

WebSockets don't support custom headers after the upgrade in browsers. Common pattern: pass JWT in query string during connection.

```javascript
const jwt = require('jsonwebtoken');

const wss = new WebSocket.Server({
    port: 8080,
    verifyClient: (info) => {
        const token = new URL(info.req.url, 'http://localhost')
            .searchParams.get('token');
        
        if (!token) return false;
        
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
    connectionManager.addConnection(user.id, ws);
});
```

Validate tokens at connection time. Re-validate periodically for long-lived connections. Short-lived tokens + refresh flow is more secure than year-long JWTs in URLs.

## Message Patterns: Structure Your Protocol

Raw strings don't scale. Define a message schema:

```javascript
// Request-response over WebSocket
wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        const message = JSON.parse(data);
        
        if (message.type === 'getUser') {
            const user = getUserById(message.userId);
            ws.send(JSON.stringify({
                id: message.id,           // Correlate response to request
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
        
        const handler = (event) => {
            const response = JSON.parse(event.data);
            if (response.id === messageId) {
                ws.removeEventListener('message', handler);
                resolve(response.data);
            }
        };
        
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({
            id: messageId,
            type: 'getUser',
            userId: userId
        }));
    });
}
```

Message IDs for request-response. Types for routing. Version your protocol (`v1`, `v2`) before you have clients in the wild you can't update.

## Pub/Sub: Scaling Beyond One Server

One server's `ConnectionManager` breaks the moment you add a second instance. User A connects to server 1. User B connects to server 2. How does A message B?

Redis pub/sub is the standard answer:

```javascript
const Redis = require('ioredis');
const redis = new Redis();
const subscriber = new Redis();  // Separate connection for subscribe

class PubSubManager {
    constructor() {
        this.subscriptions = new Map();
    }
    
    subscribe(ws, channel) {
        if (!this.subscriptions.has(channel)) {
            this.subscriptions.set(channel, new Set());
            subscriber.subscribe(channel);
        }
        this.subscriptions.get(channel).add(ws);
    }
    
    publish(channel, message) {
        redis.publish(channel, JSON.stringify(message));
    }
}

subscriber.on('message', (channel, message) => {
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

For user-to-user messaging across servers, publish to a channel keyed by `userId`. Each server subscribes and delivers to local connections.

## Horizontal Scaling: The Hard Part

```javascript
class DistributedConnectionManager {
    constructor(serverId) {
        this.serverId = serverId;
        this.connections = new Map();
        this.setupRedis();
    }
    
    setupRedis() {
        redis.psubscribe(`server:*:message`);
        redis.on('pmessage', (pattern, channel, message) => {
            const data = JSON.parse(message);
            this.handleRemoteMessage(data);
        });
    }
    
    addConnection(userId, ws) {
        this.connections.set(userId, ws);
        redis.set(`user:${userId}:server`, this.serverId);
        
        ws.on('close', () => {
            this.connections.delete(userId);
            redis.del(`user:${userId}:server`);
        });
    }
    
    sendToUser(userId, message) {
        const ws = this.connections.get(userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        } else {
            // User is on another server — publish to Redis
            redis.publish(`server:${this.serverId}:message`, JSON.stringify({
                userId,
                message
            }));
        }
    }
}
```

### Load Balancer: Sticky Sessions

```nginx
upstream websocket {
    ip_hash;  # Same client IP → same server
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
        proxy_read_timeout 86400;  # Don't kill long connections
    }
}
```

`ip_hash` isn't perfect (mobile users change IPs, corporate NAT shares IPs), but it reduces cross-server routing. For production at scale, consider dedicated WebSocket infrastructure like [Socket.IO with Redis adapter](https://socket.io/docs/v4/redis-adapter/) or managed services.

## Reconnection: Mobile Networks Are Hostile

Connections drop. Constantly. Your client must reconnect gracefully:

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
            this.reconnectAttempts = 0;
            this.onReconnect?.();  // Resubscribe, fetch missed messages
        };
        
        this.ws.onclose = () => {
            this.reconnect();
        };
    }
    
    reconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
            
            setTimeout(() => this.connect(), delay);
        }
    }
}
```

**Exponential backoff is non-negotiable.** Without it, a server restart causes every client to reconnect simultaneously—a thundering herd that kills the server you just restarted.

On reconnect, clients should resync state (missed messages, current room subscriptions). Don't assume the connection just works after a drop.

## Heartbeat: Detecting Dead Connections

TCP connections can appear open when they're actually dead (middleboxes, NAT timeouts). Ping/pong keeps things honest:

```javascript
// Server
wss.on('connection', (ws) => {
    let isAlive = true;
    
    ws.on('pong', () => { isAlive = true; });
    
    const interval = setInterval(() => {
        if (!isAlive) {
            ws.terminate();
            clearInterval(interval);
            return;
        }
        isAlive = false;
        ws.ping();
    }, 30000);
    
    ws.on('close', () => clearInterval(interval));
});
```

30-second intervals are typical. Tune based on your load balancer's idle timeout—your heartbeat must fire before the LB kills the connection.

## Production Checklist

1. **Authenticate at connection** — JWT, session cookie (with care), or ticket exchange
2. **Implement reconnection with backoff** — protect your server from yourself
3. **Use heartbeat/ping-pong** — detect zombie connections
4. **Plan for horizontal scale from day one** — Redis pub/sub or equivalent
5. **Rate limit messages** — one abusive client shouldn't melt your cluster
6. **Monitor connection count, message rate, error rate** — Grafana dashboards save weekends
7. **Handle graceful shutdown** — notify clients before deploy, drain connections
8. **Message persistence** — WebSockets deliver live; use a database for history

## Conclusion

WebSockets are the right tool when real-time actually means real-time—not "refresh every 5 seconds and call it live." They're also stateful, memory-hungry, and notoriously annoying to scale compared to stateless HTTP.

Start simple: one server, connection manager, authentication, structured messages. Add Redis pub/sub when you need a second instance. Add reconnection logic before mobile users find you. Add monitoring before production traffic finds you.

Our chat app went from "email with extra steps" to genuinely instant—and from one Node process to a horizontally scaled cluster with Redis coordinating message delivery. The architecture isn't magic. It's connection management, pub/sub, sticky sessions, and defensive client reconnection.

Get those right, and WebSockets are transformative. Skip them, and you'll be debugging "messages sometimes arrive" until someone suggests just using polling again. Don't go back. Fix the architecture instead.

---

*WebSocket architecture from April 2020, covering real-time application patterns.*

---
layout: post
title: "WebSocket vs SSE vs Long Polling: Choosing the Right Protocol"
date: 2025-10-15
categories: [Architecture]
tags: [WebSocket, SSE, Long Polling, Real-time]
excerpt: "Compare real-time protocols: WebSocket, Server-Sent Events, and Long Polling. Learn when to use each, trade-offs, and implementation patterns."
---

Real-time communication on the web comes in three flavors: [WebSocket](https://datatracker.ietf.org/doc/html/rfc6455), [Server-Sent Events (SSE)](https://html.spec.whatwg.org/multipage/server-sent-events.html), and Long Polling. Each has distinct trade-offs affecting latency, resource usage, and complexity.

I've built systems using all three. For a collaborative code editor, WebSocket was essential—bidirectional, low-latency updates. For a live dashboard showing server metrics, SSE was perfect—simple, unidirectional stream. For a notification system supporting old browsers, Long Polling grudgingly worked.

The right choice depends on your requirements: bidirectionality, browser support, firewall friendliness, and operational complexity.

## WebSocket: Full Duplex Communication

**How it works:** Upgrade HTTP connection to persistent TCP socket. After handshake, both client and server can send messages anytime.

```
Client                    Server
  |                         |
  |--- HTTP Upgrade ------->|
  |<-- 101 Switching ------- |
  |                         |
  |<-----> Binary/Text <--->|  (Bidirectional messaging)
  |                         |
```

### When to Use WebSocket

- **Real-time collaboration** - Google Docs, Figma, VS Code Live Share
- **Chat applications** - Slack, Discord, Telegram web
- **Multiplayer games** - Real-time position updates, game state
- **Live trading platforms** - Stock prices, order book updates
- **IoT dashboards** - Sensor data streaming

### Node.js WebSocket Server

```javascript
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws, req) => {
    console.log('Client connected from', req.socket.remoteAddress);
    clients.add(ws);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        timestamp: Date.now()
    }));
    
    // Handle messages
    ws.on('message', (message) => {
        console.log('Received:', message.toString());
        
        try {
            const data = JSON.parse(message);
            
            // Broadcast to all clients except sender
            clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'broadcast',
                        data: data,
                        timestamp: Date.now()
                    }));
                }
            });
        } catch (error) {
            console.error('Invalid message:', error);
        }
    });
    
    // Handle errors
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
    
    // Handle disconnect
    ws.on('close', (code, reason) => {
        console.log('Client disconnected:', code, reason.toString());
        clients.delete(ws);
    });
    
    // Heartbeat to detect dead connections
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
});

// Ping clients every 30 seconds
const interval = setInterval(() => {
    clients.forEach(ws => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

console.log('WebSocket server running on ws://localhost:8080');
```

### Browser Client

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
    console.log('Connected');
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'updates' }));
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('Received:', data);
    
    if (data.type === 'welcome') {
        console.log('Welcome message received');
    }
};

ws.onerror = (error) => {
    console.error('WebSocket error:', error);
};

ws.onclose = (event) => {
    console.log('Disconnected:', event.code, event.reason);
    
    // Reconnect logic
    setTimeout(() => {
        console.log('Reconnecting...');
        // Recreate WebSocket connection
    }, 3000);
};
```

### Production Considerations

**Load Balancing:** Use sticky sessions or shared pub/sub:

```javascript
// Shared pub/sub with Redis
const Redis = require('ioredis');
const pub = new Redis();
const sub = new Redis();

sub.subscribe('messages');
sub.on('message', (channel, message) => {
    // Broadcast to local WebSocket clients
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
});

// When receiving from WebSocket client
ws.on('message', (message) => {
    // Publish to Redis (reaches all servers)
    pub.publish('messages', message);
});
```

**Monitoring:**
```javascript
const metrics = {
    connections: 0,
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0
};

wss.on('connection', (ws) => {
    metrics.connections++;
    
    ws.on('message', () => metrics.messagesReceived++);
    ws.on('error', () => metrics.errors++);
    ws.on('close', () => metrics.connections--);
});

// Expose metrics endpoint
app.get('/metrics', (req, res) => {
    res.json(metrics);
});
```

Read [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) for protocol details.

## Server-Sent Events: Unidirectional Streaming

**How it works:** HTTP connection kept open, server sends events as `text/event-stream`.

### When to Use SSE

- **Live feeds** - News, sports scores, social media updates
- **Monitoring dashboards** - Metrics, logs, alerts
- **Notifications** - Push notifications, status updates
- **Progress tracking** - File upload progress, job status
- **Stock tickers** - Price updates (when client doesn't need to send)

### Express SSE Server

```javascript
const express = require('express');
const app = express();

// SSE endpoint
app.get('/events', (req, res) => {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Set reconnection time
    res.write('retry: 10000\n\n');
    
    // Send initial message
    res.write(`data: ${JSON.stringify({ type: 'connected', time: Date.now() })}\n\n`);
    
    // Send updates every second
    const interval = setInterval(() => {
        const data = {
            type: 'update',
            value: Math.random() * 100,
            timestamp: Date.now()
        };
        
        // SSE format: "data: <json>\n\n"
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }, 1000);
    
    // Clean up on disconnect
    req.on('close', () => {
        clearInterval(interval);
        console.log('Client disconnected');
    });
});

app.listen(3000, () => {
    console.log('SSE server running on http://localhost:3000');
});
```

### Browser Client

```javascript
const eventSource = new EventSource('http://localhost:3000/events');

eventSource.onopen = () => {
    console.log('SSE connection opened');
};

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('Received:', data);
    
    // Update UI
    document.getElementById('value').textContent = data.value.toFixed(2);
};

eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    
    if (eventSource.readyState === EventSource.CLOSED) {
        console.log('SSE connection closed');
    }
};

// Named events
eventSource.addEventListener('custom-event', (event) => {
    console.log('Custom event:', event.data);
});
```

### Named Events

```javascript
// Server: Send named events
res.write('event: alert\n');
res.write(`data: ${JSON.stringify({ message: 'System alert!' })}\n\n`);

// Client: Listen for specific events
eventSource.addEventListener('alert', (event) => {
    const alert = JSON.parse(event.data);
    showAlert(alert.message);
});
```

Read [Server-Sent Events spec](https://html.spec.whatwg.org/multipage/server-sent-events.html) for details.

## Long Polling: Request-Response Loop

**How it works:** Client makes request, server holds it open until data available or timeout, client immediately reconnects.

```
Client                    Server
  |                         |
  |--- HTTP Request ------->|
  |                         | (Wait for data or timeout)
  |<-- Response with data --|
  |                         |
  |--- HTTP Request ------->| (Immediately reconnect)
  |                         |
```

### When to Use Long Polling

- **Legacy browser support** - IE9, old mobile browsers
- **Firewall restrictions** - Corporate networks blocking WebSocket
- **Simple notifications** - Infrequent updates
- **Fallback mechanism** - When WebSocket unavailable

### Express Long Polling Server

```javascript
const express = require('express');
const app = express();

// In-memory queue of pending messages
const messageQueues = new Map();

app.get('/poll', (req, res) => {
    const userId = req.query.userId;
    
    if (!messageQueues.has(userId)) {
        messageQueues.set(userId, []);
    }
    
    const queue = messageQueues.get(userId);
    
    // If messages available, send immediately
    if (queue.length > 0) {
        res.json({ messages: queue.splice(0, queue.length) });
        return;
    }
    
    // Otherwise, wait for new message or timeout
    const timeout = setTimeout(() => {
        res.json({ messages: [] });
    }, 30000);  // 30 second timeout
    
    // Store request to send message when available
    const checkInterval = setInterval(() => {
        if (queue.length > 0) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            res.json({ messages: queue.splice(0, queue.length) });
        }
    }, 100);
    
    // Clean up on disconnect
    req.on('close', () => {
        clearTimeout(timeout);
        clearInterval(checkInterval);
    });
});

// Endpoint to send message to user
app.post('/send', express.json(), (req, res) => {
    const { userId, message } = req.body;
    
    if (!messageQueues.has(userId)) {
        messageQueues.set(userId, []);
    }
    
    messageQueues.get(userId).push({
        message,
        timestamp: Date.now()
    });
    
    res.json({ success: true });
});

app.listen(3000);
```

### Browser Client

```javascript
let polling = true;

async function poll() {
    while (polling) {
        try {
            const response = await fetch(`/poll?userId=${userId}`);
            const data = await response.json();
            
            if (data.messages.length > 0) {
                data.messages.forEach(handleMessage);
            }
            
        } catch (error) {
            console.error('Polling error:', error);
            await sleep(5000);  // Back off on error
        }
    }
}

function handleMessage(message) {
    console.log('Received:', message);
}

// Start polling
poll();

// Stop polling
function stopPolling() {
    polling = false;
}
```

## Comparison Table

| Feature | WebSocket | SSE | Long Polling |
|---------|-----------|-----|--------------|
| **Direction** | Bidirectional | Server → Client | Bidirectional (via requests) |
| **Protocol** | Custom (WS) | HTTP | HTTP |
| **Latency** | <10ms | <50ms | 100-500ms |
| **Overhead** | Low | Low | High (HTTP headers each poll) |
| **Browser Support** | IE10+ | IE/Edge (polyfill), others native | Universal |
| **Firewall Friendly** | Sometimes blocked | Yes (HTTP) | Yes (HTTP) |
| **Reconnection** | Manual | Automatic | Manual |
| **Binary Data** | Native | Base64 encoding | Base64 encoding |
| **Complexity** | High | Low | Medium |
| **Max Connections** | 65k per server | 65k per server | Limited by request rate |

## Scaling Patterns

### Pub/Sub for WebSocket/SSE

```javascript
// Using NATS for pub/sub
const NATS = require('nats');
const nc = await NATS.connect({ servers: 'nats://localhost:4222' });

// Subscribe to messages
const sub = nc.subscribe('messages');
for await (const msg of sub) {
    const data = JSON.parse(msg.data);
    
    // Broadcast to WebSocket clients
    broadcastToClients(data);
}

// Publish message
nc.publish('messages', JSON.stringify({ type: 'update', data: {...} }));
```

### Graceful Shutdown

```javascript
let shuttingDown = false;

process.on('SIGTERM', async () => {
    shuttingDown = true;
    console.log('Shutting down gracefully...');
    
    // Stop accepting new connections
    wss.close(() => {
        console.log('No longer accepting connections');
    });
    
    // Wait for existing connections to finish
    const timeout = setTimeout(() => {
        console.log('Forcing shutdown');
        process.exit(0);
    }, 30000);
    
    // Close all connections gracefully
    for (const client of clients) {
        client.close(1001, 'Server shutting down');
    }
    
    clearTimeout(timeout);
    process.exit(0);
});
```

## Conclusion

**Choose WebSocket** for interactive, bidirectional communication (chat, games, collaboration).

**Choose SSE** for server-to-client streams (dashboards, feeds, notifications). It's simpler than WebSocket and works over HTTP.

**Choose Long Polling** only as a fallback for old browsers or restrictive networks. The overhead is significant.

In practice, implement WebSocket with SSE as fallback. Long Polling is rarely worth the complexity in 2025.

**Further Resources:**
- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) - Protocol specification
- [Server-Sent Events Spec](https://html.spec.whatwg.org/multipage/server-sent-events.html) - HTML standard
- [Socket.IO](https://socket.io/) - WebSocket library with fallbacks
- [ws npm package](https://github.com/websockets/ws) - Fast WebSocket implementation
- [SSE npm package](https://www.npmjs.com/package/sse) - SSE server utilities
- [WebSocket Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers) - MDN guide

---

*WebSocket vs SSE vs Long Polling from October 2025, updated with production patterns.*

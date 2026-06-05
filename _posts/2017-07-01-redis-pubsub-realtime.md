---
layout: post
title: "Redis Pub/Sub for Real-Time Applications"
date: 2017-07-01
categories: [How-To]
tags: [Redis, Pub/Sub, Real-Time, WebSockets]
excerpt: "How Redis Pub/Sub became the glue between our WebSocket servers — and the gotchas nobody warns you about until 2 a.m."
---

I once watched a user send a chat message and wait four seconds for it to appear on their own screen. Same browser tab. Same server. The message had traveled through our database, back out through a polling loop, and finally rendered like it had taken a scenic route through rural dial-up.

That was the day I stopped pretending HTTP polling was "good enough" for real-time features.

Redis Pub/Sub won't solve every distributed systems problem — it's not a message queue with delivery guarantees, and it will happily forget your message if nobody was listening — but for pushing live updates to connected users, it's absurdly simple and scales beautifully. After wiring it into chat, notifications, and collaborative editing, here's the architecture that actually survived production traffic.

## The Mental Model (It's a Megaphone, Not a Mailbox)

Pub/Sub is fire-and-forget broadcasting:

```
Publisher → Channel → Subscribers
```

A publisher shouts into a named channel. Every subscriber currently listening hears it. Nobody listening? Message gone. No hard feelings.

That's the tradeoff. You're buying simplicity and speed, not durability.

### Hello World in Python

```python
import redis

# Publisher
r = redis.Redis(host='localhost', port=6379)
r.publish('notifications', 'User logged in')

# Subscriber
pubsub = r.pubsub()
pubsub.subscribe('notifications')

for message in pubsub.listen():
    if message['type'] == 'message':
        print(f"Received: {message['data']}")
```

The `listen()` loop blocks forever. In production you'll run this on a dedicated connection — which brings us to the most important Redis Pub/Sub rule you'll learn the hard way.

## Node.js: Publisher and Subscriber as Separate Citizens

Redis connections in subscribe mode can't do normal Redis things. Ask a subscribed connection to `GET` a key and Redis gets offended. The fix: duplicate your client.

### Publisher

```javascript
const redis = require('redis');
const client = redis.createClient();

class MessagePublisher {
    constructor() {
        this.client = redis.createClient();
    }
    
    publish(channel, message) {
        this.client.publish(channel, JSON.stringify(message));
    }
    
    publishToUser(userId, message) {
        this.publish(`user:${userId}`, message);
    }
    
    publishToRoom(roomId, message) {
        this.publish(`room:${roomId}`, message);
    }
}

// Usage
const publisher = new MessagePublisher();
publisher.publishToUser('123', {
    type: 'notification',
    message: 'You have a new message'
});
```

Channel naming is where you earn your architecture salary. We settled on `user:{id}` for personal notifications and `room:{id}` for shared spaces. Predictable names make pattern subscriptions possible later — and make debugging at 2 a.m. slightly less soul-crushing.

### Subscriber with Handler Registry

```javascript
const redis = require('redis');

class MessageSubscriber {
    constructor() {
        this.client = redis.createClient();
        this.pubsub = this.client.duplicate();
        this.handlers = new Map();
    }
    
    subscribe(channel, handler) {
        this.pubsub.subscribe(channel);
        
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, []);
        }
        this.handlers.get(channel).push(handler);
    }
    
    start() {
        this.pubsub.on('message', (channel, message) => {
            const handlers = this.handlers.get(channel) || [];
            const data = JSON.parse(message);
            
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error('Handler error:', error);
                }
            });
        });
    }
}

// Usage
const subscriber = new MessageSubscriber();

subscriber.subscribe('notifications', (data) => {
    console.log('Notification:', data);
});

subscriber.subscribe('user:123', (data) => {
    console.log('User message:', data);
});

subscriber.start();
```

Wrap handlers in try/catch. One buggy handler shouldn't crater your entire real-time pipeline because someone typo'd a property name.

## The Missing Piece: WebSockets Don't Scale Horizontally by Themselves

Here's the problem that sends most teams to Pub/Sub: Socket.io keeps connections in server memory. User A connects to Server 1. User B connects to Server 2. User A sends a message. Server 1 has no idea User B exists.

Redis becomes the town square. Any server can publish; every server hears and forwards to its local connections.

### Express + Socket.io + Redis

```javascript
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const redis = require('redis');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Redis clients
const publisher = redis.createClient();
const subscriber = redis.createClient();

// Subscribe to Redis channels
subscriber.subscribe('notifications');
subscriber.subscribe('chat:messages');

// Forward Redis messages to Socket.io
subscriber.on('message', (channel, message) => {
    const data = JSON.parse(message);
    
    if (channel === 'notifications') {
        // Broadcast to specific user
        io.to(`user:${data.userId}`).emit('notification', data);
    } else if (channel.startsWith('chat:')) {
        // Broadcast to room
        const roomId = channel.split(':')[1];
        io.to(`room:${roomId}`).emit('message', data);
    }
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Join user room
    socket.on('join:user', (userId) => {
        socket.join(`user:${userId}`);
    });
    
    // Join chat room
    socket.on('join:room', (roomId) => {
        socket.join(`room:${roomId}`);
    });
    
    // Handle chat message
    socket.on('chat:message', (data) => {
        // Publish to Redis
        publisher.publish(
            `chat:${data.roomId}`,
            JSON.stringify({
                userId: data.userId,
                message: data.message,
                timestamp: new Date()
            })
        );
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

server.listen(3000);
```

The flow: client emits → server publishes to Redis → all servers receive → each server emits to its local Socket.io rooms. User B gets the message regardless of which server they're on. Magic, with extra steps.

## Building Chat: Persist First, Broadcast Second

A rookie mistake: publish to Redis and skip the database. User refreshes the page, chat history is gone, and they file a bug titled "your app deleted my messages."

Write to durable storage first. Redis is the delivery mechanism, not the source of truth.

### Message Publishing

```javascript
class ChatService {
    constructor(publisher) {
        this.publisher = publisher;
    }
    
    async sendMessage(roomId, userId, message) {
        const messageData = {
            id: generateId(),
            roomId,
            userId,
            message,
            timestamp: new Date(),
            type: 'message'
        };
        
        // Save to database
        await this.saveMessage(messageData);
        
        // Publish to Redis
        this.publisher.publish(
            `chat:${roomId}`,
            JSON.stringify(messageData)
        );
        
        return messageData;
    }
    
    async sendTypingIndicator(roomId, userId) {
        this.publisher.publish(
            `chat:${roomId}`,
            JSON.stringify({
                type: 'typing',
                userId,
                roomId
            })
        );
    }
}
```

Typing indicators are the perfect Pub/Sub use case: ephemeral, loss-tolerant, and nobody cares if one gets dropped. Actual messages? Those earn a database write.

### Subscribing with Pattern Matching

Subscribing to every chat room individually doesn't scale. Pattern subscriptions (`psubscribe`) let one listener handle `chat:*`:

```javascript
class ChatSubscriber {
    constructor(io) {
        this.io = io;
        this.setupRedis();
    }
    
    setupRedis() {
        const subscriber = redis.createClient();
        
        // Subscribe to all chat rooms
        subscriber.psubscribe('chat:*');
        
        subscriber.on('pmessage', (pattern, channel, message) => {
            const data = JSON.parse(message);
            const roomId = channel.split(':')[1];
            
            // Emit to Socket.io room
            this.io.to(`room:${roomId}`).emit('chat:message', data);
        });
    }
}
```

Pattern subscriptions cost more CPU than exact channel matches. For hundreds of channels it's fine. For millions, reconsider your channel strategy.

## Real-Time Notifications: Personal Channels

Notifications want user-scoped delivery — exactly one person should see "Your invoice is overdue," not everyone in the `#general` channel.

### Notification Service

```javascript
class NotificationService {
    constructor(publisher) {
        this.publisher = publisher;
    }
    
    async notifyUser(userId, notification) {
        const notificationData = {
            id: generateId(),
            userId,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            timestamp: new Date(),
            read: false
        };
        
        // Save to database
        await this.saveNotification(notificationData);
        
        // Publish to Redis
        this.publisher.publish(
            `user:${userId}`,
            JSON.stringify({
                type: 'notification',
                data: notificationData
            })
        );
        
        return notificationData;
    }
    
    async notifyMultipleUsers(userIds, notification) {
        const promises = userIds.map(userId =>
            this.notifyUser(userId, notification)
        );
        
        return Promise.all(promises);
    }
}
```

### Notification Subscriber

```javascript
class NotificationSubscriber {
    constructor(io) {
        this.io = io;
        this.setupRedis();
    }
    
    setupRedis() {
        const subscriber = redis.createClient();
        
        // Subscribe to user notification channels
        subscriber.psubscribe('user:*');
        
        subscriber.on('pmessage', (pattern, channel, message) => {
            const data = JSON.parse(message);
            const userId = channel.split(':')[1];
            
            // Send to user's Socket.io room
            this.io.to(`user:${userId}`).emit('notification', data);
        });
    }
}
```

Same pattern as chat, different channel prefix. Consistency in naming pays off when you're grep-ing production logs at midnight.

## Collaborative Editing: Low-Latency Fan-Out

Google Docs envy is real. For cursor positions and live edits, Pub/Sub gives you the broadcast layer; your conflict resolution strategy is a separate (much harder) problem.

```javascript
class DocumentService {
    constructor(publisher) {
        this.publisher = publisher;
    }
    
    async applyEdit(documentId, userId, edit) {
        // Apply edit to document
        const document = await this.getDocument(documentId);
        const updatedDocument = this.applyEditToDocument(document, edit);
        await this.saveDocument(updatedDocument);
        
        // Publish edit to Redis
        this.publisher.publish(
            `document:${documentId}`,
            JSON.stringify({
                type: 'edit',
                userId,
                edit,
                timestamp: new Date()
            })
        );
        
        return updatedDocument;
    }
    
    async broadcastCursor(documentId, userId, position) {
        this.publisher.publish(
            `document:${documentId}`,
            JSON.stringify({
                type: 'cursor',
                userId,
                position,
                timestamp: new Date()
            })
        );
    }
}
```

Cursor updates are high-frequency and loss-tolerant — exactly what Pub/Sub handles well. Document edits need persistence; cursors can fly.

## Pattern Matching in Python

```python
import redis

r = redis.Redis()
pubsub = r.pubsub()

# Subscribe to pattern
pubsub.psubscribe('user:*')

# Listen for messages
for message in pubsub.listen():
    if message['type'] == 'pmessage':
        channel = message['channel'].decode()
        data = message['data'].decode()
        
        # Extract user ID from channel
        userId = channel.split(':')[1]
        print(f"Message for user {userId}: {data}")
```

## Scaling Across Servers

The beautiful part: add a third app server, and it just works. No config changes. No service discovery drama.

```javascript
// Server 1
const publisher1 = redis.createClient();
publisher1.publish('notifications', 'Message from server 1');

// Server 2
const subscriber2 = redis.createClient();
subscriber2.subscribe('notifications');
subscriber2.on('message', (channel, message) => {
    // Receives message from server 1
    io.to('room').emit('notification', message);
});
```

All servers subscribe to the same Redis channels. Redis doesn't care how many listeners you have. Your bill might care, but the architecture doesn't.

## When Things Go Wrong (They Will)

Redis connections drop. Networks hiccup. Docker containers restart because someone deployed on a Friday. Plan for it.

```javascript
class RobustSubscriber {
    constructor() {
        this.client = redis.createClient({
            retry_strategy: (options) => {
                if (options.error && options.error.code === 'ECONNREFUSED') {
                    return new Error('Redis server refused connection');
                }
                if (options.total_retry_time > 1000 * 60 * 60) {
                    return new Error('Retry time exhausted');
                }
                if (options.attempt > 10) {
                    return undefined;
                }
                return Math.min(options.attempt * 100, 3000);
            }
        });
        
        this.client.on('error', (err) => {
            console.error('Redis error:', err);
            this.reconnect();
        });
    }
    
    reconnect() {
        setTimeout(() => {
            this.client.connect();
        }, 5000);
    }
}
```

Exponential backoff on reconnect. Log errors with context. Alert when reconnect attempts exceed a threshold. Your on-call engineer will send you coffee.

## Performance: Connections Add Up

Each subscriber holds an open connection. Ten app servers with three subscriber types each? That's thirty persistent connections to Redis — before counting publishers and cache clients.

```javascript
const redis = require('redis');
const { createPool } = require('generic-pool');

const pool = createPool({
    create: () => redis.createClient(),
    destroy: (client) => client.quit()
}, {
    max: 10,
    min: 2
});

async function publish(channel, message) {
    const client = await pool.acquire();
    try {
        await client.publish(channel, message);
    } finally {
        pool.release(client);
    }
}
```

For publishers doing bursty work, pooling helps. Subscribers are inherently long-lived — one per process is normal.

## Lessons From Production

Separate your Pub/Sub Redis from your cache Redis. Mixing them seems efficient until a cache flush starves your real-time pipeline, or a Pub/Sub spike evicts hot keys. Two instances, two problems, zero shared failure modes.

Validate every message before forwarding to clients. Redis doesn't validate JSON for you, and neither should you trust whatever arrives on the wire.

Monitor message rates per channel. A sudden spike on `chat:room-42` might be a bot loop, not organic growth. Unsubscribe handlers when connections close — orphaned subscriptions leak memory quietly.

Use pattern subscriptions sparingly. They're convenient and slightly more expensive. For a few hundred channels, don't overthink it.

## The Bottom Line

Redis Pub/Sub is the duct tape that makes horizontal WebSocket scaling possible. It's not durable, not transactional, and not a replacement for RabbitMQ or Kafka when you need guaranteed delivery.

But for "tell everyone in this room right now"? It's hard to beat.

Start with a single server and direct Socket.io emits. Add Redis when you need a second server — you'll know when you get there, because messages will mysteriously stop reaching half your users. Persist important data before broadcasting. Handle reconnects. Name your channels consistently.

The patterns here handled millions of real-time messages in production. Not because Pub/Sub is magic, but because we respected what it's good at and didn't ask it to be a database.

---

*Written July 2017. Examples use `node-redis` v2.x and Redis 3.x/4.x patterns common at the time. Modern setups may prefer Redis Streams for durable messaging, but Pub/Sub remains the go-to for live fan-out.*

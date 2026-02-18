---
layout: post
title: "Redis Pub/Sub for Real-Time Applications"
date: 2017-07-01
categories: [How-To]
tags: [Redis, Pub/Sub, Real-Time, WebSockets]
excerpt: "Building real-time features using Redis Pub/Sub, including chat applications, live notifications, and collaborative features with WebSocket integration."
---

Real-time features are becoming essential for modern applications. Redis Pub/Sub provides a simple, scalable way to build real-time features. After implementing chat, notifications, and collaborative editing with Redis Pub/Sub, here's what works in production.

## Redis Pub/Sub Basics

Pub/Sub allows messages to be sent to multiple subscribers:

```
Publisher → Channel → Subscribers
```

### Basic Usage

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

## Node.js Implementation

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

### Subscriber

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

## WebSocket Integration

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

## Chat Application

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

### Message Subscribing

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

## Real-Time Notifications

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

## Collaborative Features

### Real-Time Document Editing

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

## Pattern Matching

Use pattern subscriptions for multiple channels:

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

### Multi-Server Setup

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

All servers subscribe to the same Redis channels, enabling horizontal scaling.

## Error Handling

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

## Performance Considerations

### Connection Pooling

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

## Best Practices

1. **Use separate Redis instances** - Don't mix pub/sub with caching
2. **Handle reconnections** - Redis connections can drop
3. **Validate messages** - Always validate incoming messages
4. **Monitor channels** - Track message rates
5. **Use patterns wisely** - Pattern subscriptions are less efficient
6. **Clean up subscriptions** - Unsubscribe when done

## Conclusion

Redis Pub/Sub enables:
- Real-time communication
- Scalable architecture
- Simple implementation
- Cross-server messaging

Start with simple pub/sub, add WebSocket integration, then scale horizontally. The patterns shown here handle millions of real-time messages in production.

---

*Redis Pub/Sub patterns from July 2017, covering real-time application architectures.*

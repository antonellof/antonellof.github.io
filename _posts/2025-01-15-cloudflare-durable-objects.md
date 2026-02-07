---
layout: post
permalink: /2025/01-cloudflare-durable-objects
title: "Cloudflare Durable Objects: Stateful Edge Computing"
date: 2025-01-28
categories: [Architecture]
tags: [Cloudflare, Durable Objects, Edge, State Management]
excerpt: "Explore Cloudflare Durable Objects, a revolutionary approach to stateful computing at the edge. Learn how to build real-time collaborative applications with globally distributed state."
---

# Cloudflare Durable Objects: Stateful Edge Computing

## Introduction

Edge computing traditionally meant pushing read-heavy workloads closer to users—CDNs caching static assets, serverless functions handling API requests. But what about state? [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) change the game: **strongly consistent, stateful computing at the edge**.

Building Underscore.is, our AI coding agent platform, required real-time WebSocket communication with state persistence across edge locations. Traditional approaches—Redis clusters, sticky sessions, centralized databases—all added complexity and latency. Durable Objects solved this: each user workspace became an independent object with its own state, automatically migrated to the nearest edge location.

The key insight: instead of distributing state across a database, make the compute follow the state. One Durable Object instance has authority over its data, guaranteed. No distributed consensus for every write, no eventual consistency surprises.

Read the [Durable Objects announcement](https://blog.cloudflare.com/introducing-workers-durable-objects/) for Cloudflare's vision.

## What Are Durable Objects?

Durable Objects are a serverless primitive that provides:

- **Single-threaded consistency** - Each object has one authoritative instance
- **Global distribution** - Automatically migrates closer to users
- **WebSocket support** - Maintain persistent connections
- **Transactional storage** - Integrated key-value storage with ACID guarantees
- **Automatic hibernation** - Scales to zero when idle

Think of each Durable Object as a tiny, persistent actor that can:
- Maintain in-memory state
- Handle WebSocket connections
- Coordinate complex workflows
- Store data transactionally

## Architecture Overview

```
User (Browser) → WebSocket → Cloudflare Worker → Durable Object
                                                       ↓
                                                  Transactional
                                                    Storage
```

Key insight: **One Durable Object instance per logical entity** (e.g., one per chat room, one per document, one per user session).

## Your First Durable Object

Let's build a real-time counter that multiple users can increment:

```typescript
// counter.ts - Durable Object class
export class Counter {
  state: DurableObjectState;
  value: number = 0;

  constructor(state: DurableObjectState) {
    this.state = state;
    
    // Load persisted value on initialization
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<number>('value');
      this.value = stored || 0;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case '/increment':
        this.value++;
        await this.state.storage.put('value', this.value);
        return new Response(JSON.stringify({ value: this.value }));
        
      case '/get':
        return new Response(JSON.stringify({ value: this.value }));
        
      case '/websocket':
        return this.handleWebSocket(request);
        
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept WebSocket connection
    this.state.acceptWebSocket(server);

    // Send current value immediately
    server.send(JSON.stringify({ type: 'current', value: this.value }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    const data = JSON.parse(message);
    
    if (data.type === 'increment') {
      this.value++;
      await this.state.storage.put('value', this.value);
      
      // Broadcast to all connected clients
      this.state.getWebSockets().forEach(socket => {
        socket.send(JSON.stringify({ 
          type: 'update', 
          value: this.value 
        }));
      });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
```

### Worker Entry Point

```typescript
// index.ts - Worker that routes to Durable Objects
export interface Env {
  COUNTER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Extract counter ID from URL (e.g., /counter/room-123)
    const counterId = url.pathname.split('/')[2];
    
    if (!counterId) {
      return new Response('Counter ID required', { status: 400 });
    }

    // Get Durable Object stub
    const id = env.COUNTER.idFromName(counterId);
    const stub = env.COUNTER.get(id);

    // Forward request to Durable Object
    return stub.fetch(request);
  }
};

// Export Durable Object class
export { Counter };
```

### Wrangler Configuration

```toml
# wrangler.toml
name = "durable-counter"
main = "src/index.ts"
compatibility_date = "2025-01-28"

[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[migrations]]
tag = "v1"
new_classes = ["Counter"]
```

## Real-World Pattern: Chat Room

Let's build a production-ready chat room with Durable Objects:

```typescript
interface Message {
  id: string;
  userId: string;
  username: string;
  content: string;
  timestamp: number;
}

interface User {
  id: string;
  username: string;
  connection: WebSocket;
  joinedAt: number;
}

export class ChatRoom {
  state: DurableObjectState;
  users: Map<string, User> = new Map();
  messages: Message[] = [];
  
  constructor(state: DurableObjectState) {
    this.state = state;
    
    // Load message history from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Message[]>('messages');
      this.messages = stored || [];
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/websocket') {
      return this.handleWebSocket(request);
    }
    
    if (url.pathname === '/messages') {
      return new Response(JSON.stringify({ 
        messages: this.messages.slice(-100) // Last 100 messages
      }));
    }

    return new Response('Not found', { status: 404 });
  }

  async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const username = url.searchParams.get('username');

    if (!userId || !username) {
      return new Response('Missing userId or username', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Store user info
    this.users.set(userId, {
      id: userId,
      username,
      connection: server,
      joinedAt: Date.now()
    });

    // Accept WebSocket
    this.state.acceptWebSocket(server);

    // Send message history
    server.send(JSON.stringify({
      type: 'history',
      messages: this.messages.slice(-50) // Last 50 messages
    }));

    // Broadcast user joined
    this.broadcast({
      type: 'user_joined',
      userId,
      username,
      userCount: this.users.size
    }, userId);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    const data = JSON.parse(message);
    
    // Find user by WebSocket
    const user = Array.from(this.users.values())
      .find(u => u.connection === ws);
    
    if (!user) return;

    if (data.type === 'message') {
      const msg: Message = {
        id: crypto.randomUUID(),
        userId: user.id,
        username: user.username,
        content: data.content,
        timestamp: Date.now()
      };

      // Store message
      this.messages.push(msg);
      
      // Keep only last 1000 messages in memory
      if (this.messages.length > 1000) {
        this.messages = this.messages.slice(-1000);
      }

      // Persist to storage (async, don't block)
      this.state.storage.put('messages', this.messages);

      // Broadcast to all users
      this.broadcast({
        type: 'message',
        message: msg
      });
    }

    if (data.type === 'typing') {
      // Broadcast typing indicator (don't persist)
      this.broadcast({
        type: 'typing',
        userId: user.id,
        username: user.username
      }, user.id);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Find and remove user
    for (const [userId, user] of this.users.entries()) {
      if (user.connection === ws) {
        this.users.delete(userId);
        
        // Broadcast user left
        this.broadcast({
          type: 'user_left',
          userId,
          username: user.username,
          userCount: this.users.size
        });
        
        break;
      }
    }

    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
  }

  // Helper: Broadcast to all or all except one
  private broadcast(data: any, excludeUserId?: string): void {
    const message = JSON.stringify(data);
    
    for (const [userId, user] of this.users.entries()) {
      if (excludeUserId && userId === excludeUserId) continue;
      
      try {
        user.connection.send(message);
      } catch (error) {
        console.error(`Failed to send to user ${userId}:`, error);
      }
    }
  }
}
```

## Advanced Patterns

### 1. Automatic Hibernation

Durable Objects automatically hibernate when idle, saving costs:

```typescript
export class HibernatingObject {
  state: DurableObjectState;
  lastActivity: number = Date.now();

  constructor(state: DurableObjectState) {
    this.state = state;
    
    // Set alarm to clean up after inactivity
    this.state.blockConcurrencyWhile(async () => {
      const alarm = await this.state.storage.getAlarm();
      if (!alarm) {
        // Set alarm for 1 hour from now
        await this.state.storage.setAlarm(Date.now() + 3600000);
      }
    });
  }

  async alarm(): Promise<void> {
    const inactiveTime = Date.now() - this.lastActivity;
    
    if (inactiveTime > 3600000) { // 1 hour
      // Clean up resources, close connections, etc.
      console.log('Object hibernating due to inactivity');
      
      // Don't set another alarm - let object hibernate
    } else {
      // Still active, set another alarm
      await this.state.storage.setAlarm(Date.now() + 3600000);
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.lastActivity = Date.now();
    // Handle request...
    return new Response('OK');
  }
}
```

### 2. Transactional Workflows

Use transactions for atomic operations:

```typescript
export class BankAccount {
  state: DurableObjectState;

  async transfer(fromAccount: string, toAccount: string, amount: number): Promise<void> {
    // Use transaction to ensure atomicity
    await this.state.storage.transaction(async (txn) => {
      const fromBalance = await txn.get<number>(`balance:${fromAccount}`) || 0;
      const toBalance = await txn.get<number>(`balance:${toAccount}`) || 0;

      if (fromBalance < amount) {
        throw new Error('Insufficient funds');
      }

      // Both operations succeed or both fail
      await txn.put(`balance:${fromAccount}`, fromBalance - amount);
      await txn.put(`balance:${toAccount}`, toBalance + amount);
      
      // Log transaction
      await txn.put(`transaction:${Date.now()}`, {
        from: fromAccount,
        to: toAccount,
        amount,
        timestamp: Date.now()
      });
    });
  }
}
```

### 3. Coordination Across Multiple Objects

Sometimes you need coordination across Durable Objects:

```typescript
// Coordinator pattern
export class GameRoom {
  state: DurableObjectState;
  players: string[] = [];
  
  async addPlayer(playerId: string, playerObjectNamespace: DurableObjectNamespace): Promise<void> {
    this.players.push(playerId);
    
    // Notify player's Durable Object
    const playerStub = playerObjectNamespace.get(
      playerObjectNamespace.idFromName(playerId)
    );
    
    await playerStub.fetch('http://internal/joined-game', {
      method: 'POST',
      body: JSON.stringify({ gameId: 'current-game' })
    });
  }
}
```

## Production Lessons from Underscore.is

Building a real-time AI coding platform taught us valuable lessons:

### 1. Design for Single-Tenancy

Each Durable Object should represent **one logical entity**:

```typescript
// Good: One workspace per Durable Object
const workspaceId = env.WORKSPACE.idFromName(`workspace:${userId}:${projectId}`);

// Bad: Trying to handle multiple workspaces in one object
const globalWorkspace = env.WORKSPACE.idFromName('all-workspaces'); // ❌
```

### 2. Use Alarms for Background Tasks

```typescript
export class AIAgentSession {
  async alarm(): Promise<void> {
    // Check if agent task is still running
    const task = await this.state.storage.get('current_task');
    
    if (task && Date.now() - task.startTime > 300000) { // 5 minutes
      // Task timeout - clean up and notify
      await this.cancelTask(task.id);
      this.broadcast({ type: 'task_timeout', taskId: task.id });
    }
    
    // Set next alarm
    await this.state.storage.setAlarm(Date.now() + 60000); // Check every minute
  }
}
```

### 3. Handle WebSocket Lifecycle Properly

```typescript
async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
  // Always clean up state
  const session = this.sessions.get(ws);
  if (session) {
    await this.cleanupSession(session.id);
    this.sessions.delete(ws);
  }
  
  // Close gracefully
  ws.close(code, reason);
  
  // If no more connections, persist state and prepare for hibernation
  if (this.state.getWebSockets().length === 0) {
    await this.persistState();
  }
}
```

### 4. Leverage R2 for Large Data

Don't store large files in Durable Object storage—use R2:

```typescript
async saveWorkspaceFile(filename: string, content: ArrayBuffer): Promise<void> {
  const workspaceId = 'workspace-123';
  
  // Store large file in R2
  await this.env.R2_BUCKET.put(
    `workspaces/${workspaceId}/${filename}`,
    content
  );
  
  // Store metadata in Durable Object
  await this.state.storage.put(`file:${filename}`, {
    path: filename,
    size: content.byteLength,
    uploadedAt: Date.now()
  });
}
```

## Performance Considerations

### Cold Starts

Durable Objects have minimal cold start overhead:
- **First request**: ~50-200ms (load from disk)
- **Subsequent requests**: <1ms (in-memory)

Optimize initialization:

```typescript
constructor(state: DurableObjectState) {
  this.state = state;
  
  // Only block if absolutely necessary
  this.state.blockConcurrencyWhile(async () => {
    // Load critical data only
    this.userId = await this.state.storage.get('userId');
  });
  
  // Load less critical data asynchronously
  this.loadHistoryAsync();
}

private async loadHistoryAsync(): Promise<void> {
  this.messageHistory = await this.state.storage.get('messages') || [];
}
```

### Memory Limits

Each Durable Object has a 128 MB memory limit. Design accordingly:

```typescript
// Good: Keep limited history in memory
if (this.messages.length > 1000) {
  this.messages = this.messages.slice(-1000);
}

// Bad: Unbounded growth
this.allMessagesEver.push(msg); // ❌ Will eventually OOM
```

## Cost Model

Durable Objects pricing (2025):

- **Requests**: $0.15 per million requests
- **Duration**: $12.50 per million GB-seconds
- **Storage**: $0.20 per GB-month

For a chat room with 100 active users, 10 messages/min:
- ~43,000 requests/month → $0.006
- ~2 GB-seconds → $0.025
- ~10 MB storage → $0.002
**Total: ~$0.033/month per room**

Compare to running a dedicated WebSocket server!

## Conclusion

Durable Objects represent a fundamental shift: from stateless edge computing to stateful systems with strong consistency. By making each object the single source of truth for its data and automatically migrating it closer to users, Cloudflare eliminates the complexity of distributed state management.

The programming model feels like writing a class that runs on a single server—no locks, no distributed transactions, no eventual consistency headaches. But under the hood, Cloudflare handles global distribution, automatic failover, and transparent migration.

**Key principles:**
- **Design single-tenant** - One object per logical entity (user, room, session)
- **Embrace WebSockets** - Build real-time features naturally without external pub/sub
- **Use transactions** - Leverage built-in ACID guarantees for complex state changes
- **Combine with R2/KV** - Offload large/cold data, keep hot state in Durable Objects
- **Monitor memory** - Keep state bounded (128MB limit per object)

At Underscore.is, Durable Objects enabled us to build a truly global, real-time coding platform without managing infrastructure. Each user workspace is a Durable Object that persists state, coordinates AI agents, and handles WebSocket connections—all automatically distributed to the nearest edge location. The operational simplicity is remarkable.

The future of edge computing is stateful, and Durable Objects show how to do it right.

**Further Resources:**
- [Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/) - Comprehensive guides
- [Durable Objects Announcement](https://blog.cloudflare.com/introducing-workers-durable-objects/) - Original vision
- [Durable Objects Examples](https://developers.cloudflare.com/durable-objects/examples/) - Code samples
- [Storage API Reference](https://developers.cloudflare.com/durable-objects/api/transactional-storage-api/) - Transactional storage
- [WebSocket API](https://developers.cloudflare.com/durable-objects/api/websockets/) - WebSocket support
- [Hibernatable WebSockets](https://blog.cloudflare.com/hibernatable-websockets-on-workers/) - Cost optimization
- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) - Cost model

---

*Posted on January 28, 2025 | Tags: Cloudflare, Durable Objects, Edge, State Management | Category: Architecture*

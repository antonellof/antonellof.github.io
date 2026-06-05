---
layout: post
title: "Implementing GraphQL Subscriptions for Real-Time Updates"
date: 2018-06-23
categories: [How-To]
tags: [GraphQL, WebSocket, Real-Time]
excerpt: "Polling every five seconds is just asking your server 'are we there yet?' until it files a restraining order. GraphQL subscriptions are the grown-up alternative."
---

Our notification system polled every five seconds.

It worked, in the same way that refreshing your email by hitting F5 every few seconds "works." The server handled it fine at low traffic. Then we grew, and the polling load became a constant background hum—thousands of requests per minute, all returning "nothing new" except the occasional notification buried in the noise.

We needed push, not pull. WebSockets were the obvious answer, but we had just migrated to GraphQL and didn't want a parallel real-time API with its own auth, its own types, and its own special sadness.

GraphQL subscriptions give you real-time updates over WebSockets using the same schema, the same types, and the same auth context as your queries and mutations. One API surface, three operation types. That's the pitch. Here's how we made it work in production—and what broke along the way.

## What Subscriptions Actually Are

Subscriptions are GraphQL's third operation type:

- **Query**: read data (HTTP request/response)
- **Mutation**: change data (HTTP request/response)
- **Subscription**: watch for changes (WebSocket, persistent connection)

A client subscribes to an event. The server pushes updates when that event occurs. The client receives typed, structured data—same shape as a query response—without polling.

The transport is WebSocket (via `subscriptions-transport-ws` in the Apollo ecosystem circa 2018). HTTP is request-response; WebSocket is persistent bidirectional. Subscriptions need the persistent channel.

## Server Setup: Apollo Server with Subscriptions

The core pattern: a PubSub engine publishes events from mutations (or external sources), and subscription resolvers listen for those events.

```javascript
const { ApolloServer, gql, PubSub } = require('apollo-server');
const { createServer } = require('http');
const { execute, subscribe } = require('graphql');
const { SubscriptionServer } = require('subscriptions-transport-ws');

const pubsub = new PubSub();

const typeDefs = gql`
    type Query {
        posts: [Post!]!
    }
    
    type Mutation {
        createPost(title: String!, content: String!): Post!
    }
    
    type Subscription {
        postCreated: Post!
        postUpdated(postId: ID!): Post!
    }
    
    type Post {
        id: ID!
        title: String!
        content: String!
        author: User!
        createdAt: String!
    }
    
    type User {
        id: ID!
        name: String!
    }
`;

const resolvers = {
    Query: {
        posts: () => db.getPosts()
    },
    Mutation: {
        createPost: async (parent, args, context) => {
            const post = await db.createPost({
                ...args,
                authorId: context.userId
            });
            
            // Publish event to subscribers
            pubsub.publish('POST_CREATED', {
                postCreated: post
            });
            
            return post;
        }
    },
    Subscription: {
        postCreated: {
            subscribe: () => pubsub.asyncIterator(['POST_CREATED'])
        },
        postUpdated: {
            subscribe: (parent, args) => {
                return pubsub.asyncIterator([`POST_UPDATED_${args.postId}`])
            }
        }
    }
};

const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: ({ req }) => {
        const token = req.headers.authorization;
        return { userId: getUserIdFromToken(token) };
    }
});

const httpServer = createServer(server);

server.installSubscriptionHandlers(httpServer);

httpServer.listen(4000, () => {
    console.log(`Server ready at http://localhost:4000`);
    console.log(`Subscriptions ready at ws://localhost:4000/graphql`);
});
```

The flow: mutation creates a post → `pubsub.publish` fires → subscription resolver's `asyncIterator` delivers the event → connected clients receive the new post. The mutation doesn't know who's listening. The subscribers don't know who published. Clean separation.

`postUpdated` uses a parameterized channel (`POST_UPDATED_${postId}`) so clients only receive updates for the post they're watching—not every post in the system.

## Client Setup: Splitting HTTP and WebSocket

Apollo Client needs two links: HTTP for queries and mutations, WebSocket for subscriptions.

```javascript
import { ApolloClient, InMemoryCache, split, HttpLink } from '@apollo/client';
import { getMainDefinition } from '@apollo/client/utilities';
import { WebSocketLink } from '@apollo/client/link/ws';

const httpLink = new HttpLink({
    uri: 'http://localhost:4000/graphql'
});

const wsLink = new WebSocketLink({
    uri: 'ws://localhost:4000/graphql',
    options: {
        reconnect: true,
        connectionParams: {
            authToken: localStorage.getItem('authToken')
        }
    }
});

// Route subscriptions to WebSocket, everything else to HTTP
const splitLink = split(
    ({ query }) => {
        const definition = getMainDefinition(query);
        return (
            definition.kind === 'OperationDefinition' &&
            definition.operation === 'subscription'
        );
    },
    wsLink,
    httpLink
);

const client = new ApolloClient({
    link: splitLink,
    cache: new InMemoryCache()
});
```

The `split` function inspects each operation and routes it to the right transport. Queries and mutations go over HTTP (cacheable, stateless, well-understood). Subscriptions go over WebSocket (persistent, bidirectional). One client, two transports, transparent to your components.

## Real-World Patterns

### Chat: Room-Scoped Events

```graphql
subscription {
    messageAdded(roomId: "123") {
        id
        text
        author {
            name
            avatar
        }
        createdAt
    }
}
```

```javascript
// Server resolver
Subscription: {
    messageAdded: {
        subscribe: (parent, args) => {
            return pubsub.asyncIterator([`MESSAGE_ADDED_${args.roomId}`]);
        }
    }
}

// Mutation publishes to the room channel
Mutation: {
    sendMessage: async (parent, args, context) => {
        const message = await db.createMessage({
            ...args,
            authorId: context.userId
        });
        
        pubsub.publish(`MESSAGE_ADDED_${args.roomId}`, {
            messageAdded: message
        });
        
        return message;
    }
}
```

Each chat room has its own channel. Clients subscribe only to rooms they're in. Without room-scoped channels, every connected client receives every message in the system. That's fine for five users. It's catastrophic for five thousand.

### Notifications: User-Scoped with Auth

```graphql
subscription {
    notificationReceived(userId: "123") {
        id
        type
        message
        read
        createdAt
    }
}
```

```javascript
// Server
Subscription: {
    notificationReceived: {
        subscribe: (parent, args, context) => {
            // Only subscribe to your own notifications
            if (args.userId !== context.userId) {
                throw new Error('Unauthorized');
            }
            
            return pubsub.asyncIterator([`NOTIFICATION_${args.userId}`]);
        }
    }
}

// Publish notification
function sendNotification(userId, notification) {
    pubsub.publish(`NOTIFICATION_${userId}`, {
        notificationReceived: notification
    });
}
```

Always validate that the subscriber is authorized to receive the events they're subscribing to. A subscription is a long-lived connection—if you skip auth here, you're leaving a window open.

### Live Data: External Sources

```graphql
subscription {
    stockPriceUpdated(symbol: "AAPL") {
        symbol
        price
        change
        timestamp
    }
}
```

```javascript
// Server
Subscription: {
    stockPriceUpdated: {
        subscribe: (parent, args) => {
            return pubsub.asyncIterator([`STOCK_${args.symbol}`]);
        }
    }
}

// External data source feeds the pub/sub layer
setInterval(() => {
    const price = getStockPrice('AAPL');
    pubsub.publish(`STOCK_AAPL`, {
        stockPriceUpdated: price
    });
}, 1000);
```

Subscriptions aren't only for database mutations. Any event source—market data feeds, IoT sensors, server-sent events from third parties—can publish into the same PubSub infrastructure.

## React Integration

```javascript
import { useSubscription } from '@apollo/client';

const POST_SUBSCRIPTION = gql`
    subscription PostCreated {
        postCreated {
            id
            title
            content
            author {
                name
            }
        }
    }
`;

function PostList() {
    const { data, loading, error } = useSubscription(POST_SUBSCRIPTION);
    
    if (loading) return <div>Loading...</div>;
    if (error) return <div>Error: {error.message}</div>;
    
    return (
        <div>
            <h2>New Post:</h2>
            <PostItem post={data.postCreated} />
        </div>
    );
}
```

`useSubscription` is a hook that manages the WebSocket lifecycle. It connects when the component mounts, disconnects when it unmounts, and re-renders on new data. For a feed that accumulates events, merge incoming data into your local state or cache rather than replacing on each event.

## Authentication: The Part You Can't Skip

HTTP requests carry auth headers naturally. WebSocket connections don't—they need auth passed at connection time.

### Server-Side

```javascript
const { SubscriptionServer } = require('subscriptions-transport-ws');

const subscriptionServer = SubscriptionServer.create(
    {
        schema,
        execute,
        subscribe,
        onConnect: (connectionParams, webSocket) => {
            const token = connectionParams.authToken;
            const user = verifyToken(token);
            
            if (!user) {
                throw new Error('Unauthorized');
            }
            
            return { user };
        },
        onDisconnect: (webSocket, context) => {
            console.log('Client disconnected');
        }
    },
    {
        server: httpServer,
        path: '/graphql'
    }
);
```

`onConnect` runs when a client opens a WebSocket. Verify the token, return a context object, and that context is available in subscription resolvers. Reject invalid tokens before the subscription starts—not after.

### Client-Side

```javascript
const wsLink = new WebSocketLink({
    uri: 'ws://localhost:4000/graphql',
    options: {
        reconnect: true,
        connectionParams: () => {
            return {
                authToken: localStorage.getItem('authToken')
            };
        },
        reconnectionAttempts: 5,
        timeout: 10000
    }
});
```

Use a function for `connectionParams` so the token is fresh on each reconnection. A stale token on reconnect is a common bug—user's session refreshed over HTTP, but the WebSocket is still using the old token.

## Error Handling and Reconnection

WebSocket connections drop. Networks change. Laptops sleep. Your subscription layer needs to handle disconnection gracefully.

```javascript
const wsLink = new WebSocketLink({
    uri: 'ws://localhost:4000/graphql',
    options: {
        reconnect: true,
        connectionCallback: (error) => {
            if (error) {
                console.error('WebSocket connection error:', error);
            } else {
                console.log('WebSocket connected');
            }
        }
    }
});

// Handle subscription errors in components
const { data, error } = useSubscription(SUBSCRIPTION);

useEffect(() => {
    if (error) {
        if (error.message === 'Unauthorized') {
            // Redirect to login
        } else {
            // Show error notification
        }
    }
}, [error]);
```

`reconnect: true` handles the happy path—connection drops, client reconnects automatically. But reconnection replays subscriptions, and if the server state changed while disconnected, clients may have missed events. For critical data, consider a "sync on reconnect" query that fetches state since the last known timestamp.

## Performance: Don't Broadcast Everything

### Filter at the Channel Level

```graphql
subscription {
    postUpdated(postId: "123") {
        id
        title
    }
}
```

```javascript
Subscription: {
    postUpdated: {
        subscribe: (parent, args) => {
            return pubsub.asyncIterator([`POST_UPDATED_${args.postId}`]);
        }
    }
}
```

The more specific your channels, the less wasted bandwidth. `POST_UPDATED_123` delivers to clients watching post 123. A global `POST_UPDATED` channel delivers to everyone, most of whom don't care.

### Batch High-Frequency Updates

For data that changes many times per second (stock prices, game state), batching prevents overwhelming clients:

```javascript
const updates = [];

setInterval(() => {
    if (updates.length > 0) {
        pubsub.publish('BATCH_UPDATES', {
            batchUpdates: updates
        });
        updates = [];
    }
}, 1000);
```

Collect updates over a window, publish once. Clients receive a batch instead of a firehose. Tune the interval to your use case—1 second for stock prices, 100ms for a collaborative editor.

## Production: Where It Gets Real

### Scaling Beyond One Server

The in-memory `PubSub` works for development and single-server deployments. In production with multiple server instances, you need a distributed pub/sub layer:

```javascript
// Redis for distributed pub/sub
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

class RedisPubSub {
    constructor() {
        this.publisher = new Redis(process.env.REDIS_URL);
        this.subscriber = new Redis(process.env.REDIS_URL);
    }
    
    publish(channel, payload) {
        this.publisher.publish(channel, JSON.stringify(payload));
    }
    
    subscribe(channel, callback) {
        this.subscriber.subscribe(channel);
        this.subscriber.on('message', (ch, message) => {
            if (ch === channel) {
                callback(JSON.parse(message));
            }
        });
    }
}
```

When a mutation on Server A publishes an event, Redis propagates it to Server B and Server C, where their subscribers are connected. Without this, subscriptions only work if the client happens to be connected to the same server that handled the mutation.

### Connection Limits

```javascript
let connectionCount = 0;
const MAX_CONNECTIONS = 1000;

onConnect: (connectionParams, webSocket) => {
    if (connectionCount >= MAX_CONNECTIONS) {
        throw new Error('Too many connections');
    }
    connectionCount++;
    return {};
},
onDisconnect: () => {
    connectionCount--;
}
```

Every WebSocket is an open connection consuming memory and file descriptors. Set limits. Monitor connection count. Scale horizontally when you approach capacity.

## What We Learned

**Don't make everything real-time.** Subscriptions are expensive—persistent connections, server-side state, reconnection logic. Use them for data that genuinely benefits from instant delivery: chat, notifications, live dashboards. Your user profile does not need a subscription.

**Filter aggressively.** Room-scoped, user-scoped, entity-scoped channels. The default should be "only people who care receive this event," not "broadcast and let clients filter."

**Handle reconnection explicitly.** Automatic reconnect is necessary but not sufficient. Missed events during disconnection need a recovery strategy.

**Monitor connections.** Track active WebSocket count, connection duration, reconnection frequency. A spike in reconnections means network issues or server instability.

**Use Redis (or equivalent) in production.** In-memory PubSub is a development tool. Multi-server deployments need distributed pub/sub from day one.

**Rate limit subscriptions.** A malicious client can open thousands of WebSocket connections or subscribe to expensive channels. Apply the same abuse prevention you'd apply to HTTP endpoints.

**Clean up on unmount.** `useSubscription` handles this, but if you're managing WebSocket connections manually, unsubscribe when the component leaves the screen. Orphaned subscriptions leak server resources.

**Test the disconnect scenario.** Connect, receive events, kill the network, restore the network, verify recovery. This is the flow that breaks in production and passes in development.

## When Subscriptions Are Worth It

GraphQL subscriptions aren't free complexity. You're operating a stateful layer on top of your stateless API. You're managing WebSocket connections, distributed pub/sub, reconnection, and missed-event recovery.

But when you need real-time—and you actually need it, not just "it would be nice"—subscriptions give you a typed, schema-driven push mechanism that fits naturally into your existing GraphQL stack.

We replaced our polling notification system with subscriptions and cut server load from the constant polling hum to near-zero baseline. Chat worked. Live dashboards worked. The collaborative editing feature that justified the migration in the first place worked.

Use subscriptions for chat, notifications, and live data. Start with in-memory PubSub in development. Move to Redis before you deploy multi-instance. Filter channels aggressively. Handle reconnection with a recovery strategy.

The patterns here carried our real-time features through production traffic. They'll age as the ecosystem moves toward GraphQL over WebSocket standardized transports, but the architecture—publish events, subscribe to channels, scale with Redis—endures.

---

*Written in June 2018, covering Apollo Server 2.0+ with subscriptions-transport-ws. The GraphQL over WebSocket protocol (graphql-ws) would later emerge as the successor to subscriptions-transport-ws; the pub/sub patterns remain the same.*

---
layout: post
title: "Implementing GraphQL Subscriptions for Real-Time Updates"
date: 2018-06-23
categories: [How-To]
tags: [GraphQL, WebSocket, Real-Time]
excerpt: "Build real-time features with GraphQL subscriptions using WebSockets, covering Apollo Server subscriptions, client setup, and production patterns for chat, notifications, and live data."
---

GraphQL subscriptions enable real-time updates over WebSockets. After implementing real-time features in production, here's how to set up GraphQL subscriptions effectively.

## What are GraphQL Subscriptions?

Subscriptions allow clients to:
- Subscribe to data changes
- Receive real-time updates
- Use WebSocket connections
- Maintain GraphQL query syntax

## Server Setup

### Apollo Server with Subscriptions

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
            
            // Publish subscription event
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
                return pubsub.asyncIterator([`POST_UPDATED_${args.postId}`]);
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

## Client Setup

### Apollo Client with Subscriptions

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

## Subscription Examples

### Chat Application

```graphql
# Subscription
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

// Mutation publishes event
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

### Live Notifications

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
            // Only subscribe to own notifications
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

### Live Data Updates

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

// External data source
setInterval(() => {
    const price = getStockPrice('AAPL');
    pubsub.publish(`STOCK_AAPL`, {
        stockPriceUpdated: price
    });
}, 1000);
```

## React Hook Usage

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

## Authentication

### Server-Side Auth

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

### Client-Side Auth

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

## Error Handling

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

// Handle subscription errors
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

## Performance Optimization

### Filtering Subscriptions

```graphql
subscription {
    postUpdated(postId: "123") {
        id
        title
    }
}
```

```javascript
// Only subscribe to specific post updates
Subscription: {
    postUpdated: {
        subscribe: (parent, args) => {
            return pubsub.asyncIterator([`POST_UPDATED_${args.postId}`]);
        }
    }
}
```

### Batching Updates

```javascript
// Batch multiple updates
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

## Production Considerations

### Scaling

```javascript
// Use Redis for distributed pub/sub
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

### Connection Limits

```javascript
// Limit concurrent connections
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

## Best Practices

1. **Use subscriptions sparingly** - Not all data needs real-time
2. **Filter subscriptions** - Subscribe to specific data
3. **Handle reconnection** - Automatic reconnection logic
4. **Monitor connections** - Track WebSocket connections
5. **Use Redis** - For distributed pub/sub
6. **Rate limit** - Prevent abuse
7. **Error handling** - Graceful error recovery
8. **Cleanup** - Unsubscribe when component unmounts

## Conclusion

GraphQL subscriptions enable:
- Real-time updates
- WebSocket connections
- GraphQL query syntax
- Type-safe subscriptions

Use subscriptions for chat, notifications, and live data. The patterns shown here handle production workloads.

---

*GraphQL subscriptions from June 2018, covering Apollo Server 2.0+ features.*

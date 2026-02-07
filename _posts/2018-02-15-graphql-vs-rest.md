---
layout: post
title: "GraphQL vs REST: A Comprehensive Comparison"
date: 2018-02-15
categories: [Deep Dive]
tags: [GraphQL, REST, API Design, Comparison]
excerpt: "Comparing GraphQL and REST APIs: when to use each, performance implications, developer experience, and real-world tradeoffs from building both in production."
---

GraphQL emerged as an alternative to REST, promising better developer experience and more efficient data fetching. After building both REST and GraphQL APIs in production, here's an honest comparison.

## REST Overview

REST (Representational State Transfer) uses:
- HTTP methods (GET, POST, PUT, DELETE)
- Resource-based URLs
- Stateless requests
- Standard status codes

```javascript
// REST API
GET    /api/users          // List users
GET    /api/users/123      // Get user
POST   /api/users          // Create user
PUT    /api/users/123      // Update user
DELETE /api/users/123      // Delete user

// Response
{
  "id": 123,
  "name": "John Doe",
  "email": "john@example.com"
}
```

## GraphQL Overview

GraphQL uses:
- Single endpoint
- Query language
- Type system
- Client-specified fields

```graphql
# GraphQL Query
query {
  user(id: 123) {
    name
    email
    posts {
      title
      content
    }
  }
}

# Response
{
  "data": {
    "user": {
      "name": "John Doe",
      "email": "john@example.com",
      "posts": [
        { "title": "Post 1", "content": "..." }
      ]
    }
  }
}
```

## Key Differences

### Data Fetching

**REST:**
```javascript
// Multiple requests for related data
const user = await fetch('/api/users/123');
const posts = await fetch('/api/users/123/posts');
const comments = await fetch('/api/users/123/comments');

// Or over-fetching
const user = await fetch('/api/users/123?include=posts,comments');
// Returns everything, even if not needed
```

**GraphQL:**
```graphql
# Single request, exact fields needed
query {
  user(id: 123) {
    name
    email
    posts {
      title
    }
  }
}
```

### Versioning

**REST:**
```javascript
// Version in URL
/api/v1/users
/api/v2/users

// Or headers
GET /api/users
Accept: application/vnd.api+json;version=2
```

**GraphQL:**
```graphql
# Add new fields without breaking
type User {
  id: ID!
  name: String!
  email: String!
  phone: String  # New field, optional
}

# Deprecate old fields
type User {
  fullName: String @deprecated(reason: "Use name instead")
  name: String!
}
```

### Error Handling

**REST:**
```javascript
// HTTP status codes
200 OK
201 Created
400 Bad Request
404 Not Found
500 Internal Server Error

// Response
{
  "error": "User not found",
  "code": "USER_NOT_FOUND"
}
```

**GraphQL:**
```json
{
  "data": {
    "user": null
  },
  "errors": [
    {
      "message": "User not found",
      "path": ["user"],
      "extensions": {
        "code": "USER_NOT_FOUND"
      }
    }
  ]
}
```

## Performance Comparison

### Over-fetching

**REST Problem:**
```javascript
// Client needs only name and email
GET /api/users/123
// Returns: id, name, email, bio, avatar, settings, preferences...
// Wasted bandwidth
```

**GraphQL Solution:**
```graphql
query {
  user(id: 123) {
    name
    email
  }
}
# Returns only requested fields
```

### Under-fetching

**REST Problem:**
```javascript
// Need user with posts and comments
const user = await fetch('/api/users/123');
const posts = await fetch('/api/users/123/posts');
// For each post:
const comments = await fetch('/api/posts/1/comments');
// N+1 query problem
```

**GraphQL Solution:**
```graphql
query {
  user(id: 123) {
    name
    posts {
      title
      comments {
        text
      }
    }
  }
}
# Single request
```

### Caching

**REST:**
```javascript
// HTTP caching works well
GET /api/users/123
Cache-Control: public, max-age=3600

// Browser/CDN caches automatically
```

**GraphQL:**
```javascript
// Caching is more complex
// Need to implement custom caching
// Or use Apollo Client with normalized cache
```

## When to Use REST

**Good for:**
- Simple CRUD operations
- Caching is important
- File uploads/downloads
- Well-defined resources
- Team familiar with REST

**Example:**
```javascript
// File upload
POST /api/files
Content-Type: multipart/form-data

// File download
GET /api/files/123/download
```

## When to Use GraphQL

**Good for:**
- Complex data relationships
- Mobile apps (reduce bandwidth)
- Rapidly changing frontend needs
- Multiple clients with different needs
- Real-time subscriptions

**Example:**
```graphql
# Mobile app - minimal data
query {
  user(id: 123) {
    name
    avatar
  }
}

# Web app - full data
query {
  user(id: 123) {
    name
    email
    bio
    posts {
      title
      content
      comments {
        text
        author {
          name
        }
      }
    }
  }
}
```

## Implementation Examples

### REST API (Express.js)

```javascript
const express = require('express');
const app = express();

app.get('/api/users/:id', async (req, res) => {
    const user = await db.getUser(req.params.id);
    res.json(user);
});

app.get('/api/users/:id/posts', async (req, res) => {
    const posts = await db.getUserPosts(req.params.id);
    res.json(posts);
});
```

### GraphQL API (Apollo Server)

```javascript
const { ApolloServer, gql } = require('apollo-server');

const typeDefs = gql`
    type User {
        id: ID!
        name: String!
        email: String!
        posts: [Post!]!
    }
    
    type Post {
        id: ID!
        title: String!
        content: String!
        author: User!
    }
    
    type Query {
        user(id: ID!): User
    }
`;

const resolvers = {
    Query: {
        user: async (parent, args) => {
            return await db.getUser(args.id);
        }
    },
    User: {
        posts: async (parent) => {
            return await db.getUserPosts(parent.id);
        }
    }
};

const server = new ApolloServer({ typeDefs, resolvers });
server.listen().then(({ url }) => {
    console.log(`Server ready at ${url}`);
});
```

## Real-World Comparison

### Mobile App API Calls

**REST:**
```
Home screen: 5 API calls
User profile: 3 API calls
Post detail: 4 API calls
Total: 12 requests, ~500KB data
```

**GraphQL:**
```
Home screen: 1 query
User profile: 1 query
Post detail: 1 query
Total: 3 requests, ~150KB data
```

### Development Experience

**REST:**
- Simple to understand
- Good tooling (Postman, curl)
- Easy to debug
- Standard patterns

**GraphQL:**
- Steeper learning curve
- Better tooling (GraphiQL, Apollo DevTools)
- Type safety with schema
- More flexible

## Hybrid Approach

Use both:

```javascript
// REST for simple operations
POST /api/users          // Create user
GET  /api/users/:id       // Get user

// GraphQL for complex queries
POST /graphql
{
  "query": "query { user(id: 123) { ... } }"
}

// REST for file operations
POST /api/files/upload
GET  /api/files/:id/download
```

## Migration Strategy

### Gradual Migration

```javascript
// Phase 1: Add GraphQL alongside REST
// Keep REST endpoints, add GraphQL schema

// Phase 2: Migrate complex queries to GraphQL
// Keep simple CRUD in REST

// Phase 3: Full GraphQL (optional)
// Or keep hybrid approach
```

## Best Practices

### REST:
1. Use proper HTTP methods
2. Return appropriate status codes
3. Implement pagination
4. Use HATEOAS for discoverability
5. Version your API

### GraphQL:
1. Design schema carefully
2. Implement query depth limiting
3. Use DataLoader for N+1 problems
4. Implement rate limiting
5. Use subscriptions for real-time

## Conclusion

**Choose REST when:**
- Simple CRUD operations
- Caching is critical
- Team familiar with REST
- File operations

**Choose GraphQL when:**
- Complex data relationships
- Mobile apps (bandwidth matters)
- Rapid frontend iteration
- Multiple clients with different needs

Both have their place. REST is simpler and more established. GraphQL is more flexible and efficient for complex queries. Choose based on your specific needs.

---

*GraphQL vs REST comparison from February 2018, reflecting the state of both technologies.*

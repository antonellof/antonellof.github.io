---
layout: post
title: "GraphQL vs REST: A Comprehensive Comparison"
date: 2018-02-18
categories: [Deep Dive]
tags: [GraphQL, REST, API Design, Comparison]
excerpt: "REST is a comfortable old hoodie. GraphQL is the tailored jacket that fits perfectly but takes three fittings. Here's when each one actually earns its keep."
---

I built a REST API that worked beautifully for our web app. Then we shipped a mobile client, and suddenly every screen needed a bespoke combination of endpoints—or one bloated endpoint that returned half the database. The mobile team started a Slack channel called `#api-requests` that was basically a ticketing system for new REST routes.

Then we tried GraphQL on a greenfield project. The mobile team loved it. The backend team spent two weeks arguing about schema design. Both experiences were correct.

REST and GraphQL aren't enemies. They're different answers to the same question: *how should clients get data from servers?* The answer depends on who's asking, how often the questions change, and whether you care more about caching or flexibility.

This is the honest comparison I wanted before we committed to either approach.

## REST: Resources, Verbs, and Twenty Years of Convention

REST (Representational State Transfer) organizes your API around resources. Each URL represents a thing; HTTP methods represent what you want to do to that thing.

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

REST's superpower is simplicity. Every developer who's touched a web API understands GET and POST. HTTP status codes tell you what happened. Browsers, CDNs, and proxies know how to cache GET requests. The tooling ecosystem is enormous because REST has been the default for decades.

REST's weakness shows up when clients need *shapes* of data that don't map cleanly to your resource boundaries.

## GraphQL: One Endpoint, Many Questions

GraphQL flips the model. Instead of many endpoints returning fixed shapes, you have one endpoint and a query language that lets clients specify exactly what they need.

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

The client asks for `name`, `email`, and `posts.title`—and gets exactly that. No more, no less. When your mobile app only needs an avatar and display name, it doesn't download the user's entire profile, settings, and notification preferences because the REST endpoint wasn't designed for that screen.

## The Fetching Problem: Where Most Debates Actually Live

### Over-Fetching: Paying for Data You Don't Use

**REST:**
```javascript
// Client needs only name and email
GET /api/users/123
// Returns: id, name, email, bio, avatar, settings, preferences...
// Wasted bandwidth on every request
```

This is the "combo meal" problem. You wanted a burger; you got the burger, fries, drink, and a toy you'll throw away. On a fast desktop connection, nobody cares. On a mobile client with spotty LTE, it adds up fast.

**GraphQL:**
```graphql
query {
  user(id: 123) {
    name
    email
  }
}
# Returns only requested fields
```

### Under-Fetching: The Round-Trip Parade

**REST:**
```javascript
// Need user with posts and comments
const user = await fetch('/api/users/123');
const posts = await fetch('/api/users/123/posts');
// For each post:
const comments = await fetch('/api/posts/1/comments');
// N+1 query problem on the client AND the server
```

Three screens, twelve API calls, and a loading spinner that becomes part of your brand identity. You can fix this with `?include=posts,comments` query params, but then you're designing a custom query language anyway—except it's undocumented, inconsistent across endpoints, and different for every resource.

**GraphQL:**
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
# Single request, tree-shaped response
```

One round trip. The tradeoff: your server now has to resolve a tree of fields efficiently, or you've just moved the N+1 problem from the client to the database.

### Caching: REST's Quiet Advantage

**REST:**
```javascript
// HTTP caching works out of the box
GET /api/users/123
Cache-Control: public, max-age=3600

// Browser/CDN caches automatically. This is not a small thing.
```

HTTP caching is one of the most battle-tested performance optimizations in computing. CDNs understand it. Browsers understand it. Your API gateway probably understands it.

**GraphQL:**
```javascript
// Caching is more complex
// POST to /graphql with different query bodies
// Need normalized caches (Apollo Client) or custom CDN rules
```

Every GraphQL request is typically a POST with a different body. Standard HTTP caching doesn't apply. Apollo Client's normalized cache is excellent, but it's client-side infrastructure you have to build and maintain. Server-side caching for GraphQL is solvable—persisted queries, APQ, CDN configurations—but it's work REST gets for free.

If your API is read-heavy and cacheable, REST has a genuine performance edge. Don't let anyone tell you otherwise.

## Versioning: Evolution vs. Revolution

**REST:**
```javascript
// Version in URL
/api/v1/users
/api/v2/users

// Or headers
GET /api/users
Accept: application/vnd.api+json;version=2
```

REST versioning is well-understood and blunt. `/v1/` and `/v2/` coexist. Clients migrate on their schedule. The downside: you maintain two (or more) API surfaces until every client migrates. "Temporary" v1 endpoints have a way of becoming permanent.

**GraphQL:**
```graphql
# Add new fields without breaking existing clients
type User {
  id: ID!
  name: String!
  email: String!
  phone: String  # New field, optional—old clients ignore it
}

# Deprecate old fields gracefully
type User {
  fullName: String @deprecated(reason: "Use name instead")
  name: String!
}
```

GraphQL's type system makes additive changes safe. New optional fields don't break old queries. Deprecated fields can linger with warnings. This is genuinely elegant for APIs that evolve frequently.

The catch: removing fields is still a breaking change. GraphQL doesn't eliminate versioning—it makes the happy path (adding things) smoother.

## Error Handling: Status Codes vs. Error Arrays

**REST:**
```javascript
// HTTP status codes tell the story
200 OK
201 Created
400 Bad Request
404 Not Found
500 Internal Server Error

// Response body adds detail
{
  "error": "User not found",
  "code": "USER_NOT_FOUND"
}
```

Your load balancer knows 500 means retry (maybe). Your client knows 404 means don't retry. The semantics are in the protocol layer.

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

GraphQL typically returns HTTP 200 even when things fail. Errors live in the response body. Partial success is possible—you might get the user's name but an error resolving their posts. This is powerful for complex UIs but confusing for infrastructure that expects HTTP status codes to mean things.

## When REST Is the Right Call

REST shines when your API maps cleanly to resources, your clients have similar data needs, and caching matters.

File uploads and downloads are the classic example—multipart form data and binary streams don't fit GraphQL's query model naturally:

```javascript
// File upload
POST /api/files
Content-Type: multipart/form-data

// File download
GET /api/files/123/download
```

REST is also the better default when your team is small, your data model is stable, and your clients are mostly one web application. The simplicity tax of GraphQL—schema design, resolver architecture, query complexity limits, N+1 prevention—doesn't pay for itself if you're serving a single frontend that needs predictable shapes.

If your API is essentially CRUD on well-defined entities and you can paginate consistently, REST will be faster to build and easier to operate.

## When GraphQL Earns Its Complexity

GraphQL pays off when multiple clients need different views of the same data, relationships are deep, and the frontend team moves faster than the backend team can ship new endpoints.

```graphql
# Mobile app - minimal data for a list view
query {
  user(id: 123) {
    name
    avatar
  }
}

# Web app - full data for a profile page
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

Same schema, different queries, no backend changes. The mobile team stops filing tickets. The web team stops waiting.

GraphQL also makes sense when you need real-time subscriptions (more on that in a later post), when your domain is graph-shaped rather than resource-shaped, and when you want a typed contract between frontend and backend that both sides can validate against.

## Implementation: Same Data, Different Front Door

### REST with Express

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

Two endpoints, two handlers, two database calls if the client needs both. Simple, explicit, easy to reason about.

### GraphQL with Apollo Server

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

One endpoint, but look at the `User.posts` resolver—that's an N+1 trap waiting to happen. Without DataLoader or a JOIN at the root resolver, fetching a user with 50 posts means 51 database queries. GraphQL doesn't solve N+1; it relocates it.

## Real Numbers from a Real Project

We tracked API usage when we ran both approaches in parallel:

**REST (mobile app):**
```
Home screen: 5 API calls
User profile: 3 API calls
Post detail: 4 API calls
Total per session: 12 requests, ~500KB data
```

**GraphQL (same screens):**
```
Home screen: 1 query
User profile: 1 query
Post detail: 1 query
Total per session: 3 requests, ~150KB data
```

The bandwidth savings were real. The server-side complexity was also real—we added DataLoader, query depth limiting, and complexity scoring before we felt comfortable in production.

## The Hybrid Approach (What We Actually Ended Up With)

You don't have to pick a religion. Many production systems use both:

```javascript
// REST for simple operations and file handling
POST /api/users          // Create user
GET  /api/users/:id       // Get user
POST /api/files/upload
GET  /api/files/:id/download

// GraphQL for complex, client-specific queries
POST /graphql
{
  "query": "query { user(id: 123) { name posts { title comments { text } } } }"
}
```

REST handles the straightforward stuff—auth, file uploads, webhooks, anything that maps to a single resource action. GraphQL handles the read-heavy, relationship-heavy queries where client flexibility matters.

This isn't indecision. It's using each tool where it's strongest.

## Migration Without the Big Bang

If you're sitting on a REST API and eyeing GraphQL, you don't need a rewrite:

```javascript
// Phase 1: Add GraphQL alongside REST
// Keep REST endpoints, add GraphQL schema that wraps the same data layer

// Phase 2: Migrate complex queries to GraphQL
// Mobile and web clients adopt GraphQL for read-heavy screens
// Keep REST for writes, files, and simple CRUD

// Phase 3: Evaluate
// Some teams go full GraphQL. Many keep the hybrid forever.
```

The data layer stays the same. You're adding a new interface, not rebuilding the engine. Start with the screens that hurt most—usually mobile list views and dashboards with aggregated data.

## What Actually Matters in Production

For REST, the fundamentals haven't changed: use the right HTTP method, return the right status code, paginate consistently, and version before you need to. HATEOAS is nice in theory; consistent pagination and error formats matter more in practice.

For GraphQL, schema design is architecture. Get it wrong and every client suffers. Implement query depth limiting before someone recursively queries `user { friends { friends { friends { ... } } } } }`. Use DataLoader from day one—retrofitting N+1 fixes is miserable. Rate limit your GraphQL endpoint; a single query can trigger hundreds of database calls. Reserve subscriptions for data that genuinely needs to be real-time.

## The Decision Framework

**Choose REST when:**
- Your API is mostly CRUD on well-defined resources
- HTTP caching is a significant performance lever
- You have one primary client with stable data needs
- File uploads/downloads are core functionality
- Your team needs to ship fast without schema design debates

**Choose GraphQL when:**
- Multiple clients need different shapes of the same data
- Mobile bandwidth is a real constraint
- Your frontend iterates faster than your API can add endpoints
- Relationships are deep and clients need flexible querying
- Real-time subscriptions are part of the product

**Choose both when:**
- You have a mature REST API and specific screens that hurt
- File operations and simple writes stay on REST
- Complex reads move to GraphQL incrementally

Neither REST nor GraphQL is "better." REST is simpler, more cacheable, and universally understood. GraphQL is more flexible, more efficient for complex client needs, and more expensive to operate well.

The worst choice is picking one because of a conference talk. The best choice is matching the tool to your actual access patterns, team skills, and client diversity.

We kept REST for our admin API and file service. We moved client-facing reads to GraphQL. Both teams stopped complaining. That's the real win.

---

*Written in February 2018, reflecting the state of REST and GraphQL at the time. The tradeoffs are the same; the tooling on both sides has matured considerably.*

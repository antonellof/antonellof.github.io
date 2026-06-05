---
layout: post
title: "API Design: From REST to GraphQL to gRPC"
date: 2023-09-27
categories: [Architecture]
tags: [API Design, REST, GraphQL, gRPC]
excerpt: "We shipped GraphQL because the frontend team asked for it. Six months later we had N+1 queries, a schema nobody owned, and a BFF that was harder to maintain than the REST API it replaced."
---

The frontend team wanted GraphQL. They had a slide deck with three bullet points: "no over-fetching," "single endpoint," "type safety." The backend team had a slide deck with one bullet point: "we already have REST and it works." Leadership said "try GraphQL for the new mobile app."

Six months later, the mobile app shipped. So did a GraphQL gateway with 47 resolvers, N+1 query problems we solved with DataLoader patches, a schema that three teams modified without coordination, and a BFF layer that was harder to maintain than the REST API it replaced. The mobile app used 12 of the 200 available fields. No over-fetching problem had ever existed for mobile — the payloads were small.

Meanwhile, our internal service-to-service communication ran on REST over HTTP/JSON, and every performance-sensitive path had a TODO comment saying "migrate to gRPC eventually." Eventually never came because nobody wanted to maintain `.proto` files.

I've now built production APIs with REST, GraphQL, and gRPC. Each one was the right choice somewhere and the wrong choice somewhere else. This post is the decision framework I wish we'd had before the GraphQL migration meeting.

## REST: The Boring Default (And That's Good)

REST maps resources to URLs and uses HTTP methods for operations:

```javascript
GET    /api/users          // List users
GET    /api/users/123      // Get user
POST   /api/users          // Create user
PUT    /api/users/123      // Update user
DELETE /api/users/123      // Delete user
```

**Why REST wins by default:**

- Every developer understands it. Every HTTP client supports it. Every cache (CDN, browser, reverse proxy) understands GET semantics.
- HTTP status codes communicate errors without custom error formats
- Tooling is mature: OpenAPI/Swagger for documentation, Postman for testing, curl for debugging at 2am
- Versioning is solved (URL path, header, query param — pick one, document it)

**Where REST struggles:**

- Clients that need data from multiple resources make multiple round-trips
- Over-fetching: `GET /api/users/123` returns 40 fields, client needs 3
- Under-fetching: client needs user + posts + comments, makes 3 requests
- Real-time updates require polling or bolting on WebSockets separately

I still default to REST for public APIs, CRUD services, and anything where "boring and well-understood" is a feature. Our customer-facing API is REST with OpenAPI documentation. It handles 50,000 requests/minute. Nobody has complained about the architecture — they complain about rate limits, which is a business problem, not an API style problem.

See [Roy Fielding's REST dissertation](https://www.ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm) for the original principles, and [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) for modern API documentation.

## GraphQL: Flexibility With a Maintenance Bill

GraphQL gives clients a single endpoint and a query language to request exactly the data they need:

```graphql
query {
  user(id: "123") {
    name
    email
    posts {
      title
      comments {
        body
        author { name }
      }
    }
  }
}
```

One request. Nested data. Client controls the shape. Sounds perfect.

**Where GraphQL genuinely helps:**

- Multiple client types (web, mobile, TV app) needing different data shapes from the same backend
- Rapidly evolving frontends where API changes are expensive to coordinate
- Complex data graphs where REST would require many round-trips
- Developer experience for frontend teams — introspection, typed clients, GraphQL Playground

**Where GraphQL genuinely hurts:**

- **N+1 queries** — the resolver pattern invites database query explosions. Every `posts { comments { author } }` can become hundreds of SQL queries without careful DataLoader batching
- **Schema ownership** — who owns the schema when three teams add resolvers? We didn't answer this and got a schema that grew like unchecked ivy
- **Caching** — HTTP caching doesn't work with POST-based queries. You need application-level caching or a CDN that understands GraphQL
- **Complexity budget** — GraphQL gateway + resolvers + DataLoaders + schema stitching is more infrastructure than a REST controller
- **Security** — query depth limiting, complexity analysis, and rate limiting are harder than REST endpoint throttling

**The project that soured me:** A dashboard that needed user name, avatar, and last login. In REST: one endpoint, three fields. In GraphQL: one query, three fields — but also a resolver layer, a schema definition, a DataLoader for the avatar URL signing, and a gateway deployment. Same result, 4x the infrastructure.

### When I'd Choose GraphQL Again

- A frontend team that owns the GraphQL layer end-to-end (BFF pattern)
- Genuinely complex data requirements where REST means 10+ round-trips per page
- Multiple client platforms with significantly different data needs
- Strong schema governance from day one (code review on schema changes, deprecation policies)

I'd pair it with [Apollo Server](https://www.apollographql.com/docs/apollo-server/) or similar and invest in DataLoader from the first resolver, not after the first production incident.

## gRPC: Performance for Service-to-Service

gRPC uses Protocol Buffers for serialization and HTTP/2 for transport:

```protobuf
service UserService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc ListUsers(ListUsersRequest) returns (stream User);
  rpc UpdateUser(UpdateUserRequest) returns (User);
}

message User {
  int64 id = 1;
  string name = 2;
  string email = 3;
}
```

Binary serialization. Strong typing. Bidirectional streaming. Not human-readable. Not browser-friendly. Not for your public API.

**Where gRPC shines:**

- **Service-to-service communication** — microservices talking to each other internally
- **Low latency requirements** — binary protobuf is 3-10x smaller and faster to serialize than JSON
- **Streaming** — real-time data feeds, log streaming, chat backends
- **Contract-first development** — `.proto` files define the contract; code generation ensures both sides match
- **Polyglot environments** — gRPC generates clients in Go, Python, Java, Node.js, etc. from the same proto

**Where gRPC struggles:**

- **Browser support** — needs gRPC-Web proxy (Envoy, etc.) for browser clients
- **Debugging** — can't `curl` a protobuf endpoint. Need `grpcurl` or generated clients
- **Learning curve** — protobuf syntax, code generation, HTTP/2 infrastructure
- **Human-facing APIs** — your customers' mobile apps shouldn't speak gRPC

We migrated internal service communication from REST to gRPC for our payment processing pipeline. Latency dropped from 45ms to 8ms per inter-service call. At 5,000 transactions/minute, that mattered. The `.proto` files became the contract both teams referenced. Breaking changes were caught at compile time, not in production.

See the [gRPC documentation](https://grpc.io/docs/) and [Protocol Buffers guide](https://protobuf.dev/programming-guides/proto3/) for getting started.

## The Decision Framework

Stop choosing API style based on what's trending. Use this:

| Factor | REST | GraphQL | gRPC |
|--------|------|---------|------|
| **Audience** | External clients, public APIs | Frontend apps, multiple clients | Internal services |
| **Data pattern** | CRUD, simple queries | Complex graphs, varied client needs | High-throughput RPC, streaming |
| **Team expertise** | Any developer | Frontend-heavy teams | Backend/systems teams |
| **Caching needs** | HTTP caching (CDN, browser) | Application-level caching | Usually none needed |
| **Performance priority** | Moderate | Moderate | Critical |
| **Contract enforcement** | OpenAPI/Swagger | GraphQL schema | Protobuf (compile-time) |
| **Debugging** | curl, browser, Postman | GraphQL Playground | grpcurl, generated clients |

### The Questions I Ask Now

1. **Who consumes this API?** External customers → REST. Frontend apps → maybe GraphQL. Internal services → maybe gRPC.
2. **How many round-trips does the client need?** One or two → REST is fine. Ten → consider GraphQL.
3. **How latency-sensitive is this path?** Sub-10ms internal calls → gRPC. 100ms is fine → REST.
4. **Who maintains the API layer?** Same team as consumers → GraphQL BFF works. Separate teams → REST with clear contracts.
5. **Do we need streaming?** Real-time feeds → gRPC streaming. Polling is fine → REST.

## The Hybrid Approach (What Actually Works)

Most mature systems I see use all three:

```
Mobile App  ──→  GraphQL BFF  ──→  gRPC ──→  User Service
Web App     ──→  REST API     ──→  gRPC ──→  Order Service
Admin Panel ──→  REST API     ──→  gRPC ──→  Payment Service
Partner API ──→  REST (public) ──→  gRPC ──→  Internal Services
```

- **Public/partner APIs:** REST with OpenAPI docs, versioning, rate limiting
- **Frontend BFF:** GraphQL (if justified) that aggregates gRPC backend calls
- **Service-to-service:** gRPC with protobuf contracts
- **Webhooks/events:** REST callbacks or message queues, not gRPC

This isn't complexity for its own sake — each layer solves a different problem. The GraphQL BFF translates flexible frontend queries into efficient gRPC backend calls. The public REST API provides stable, cacheable, documented endpoints for partners.

## API Design Principles (Regardless of Style)

The protocol matters less than the design discipline:

**Version your APIs.** `/api/v1/users` or `Accept-Version: 2023-09-27` — pick a strategy, never break existing clients silently.

**Design errors consistently:**
```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "User with ID 123 does not exist",
    "details": {}
  }
}
```

**Paginate everything that returns lists.** Cursor-based for real-time data, offset-based for admin interfaces.

**Rate limit from day one.** Per-client, per-endpoint, with clear `Retry-After` headers.

**Document before you build.** OpenAPI spec for REST, GraphQL schema with descriptions, protobuf with comments. The spec is the contract.

**Monitor everything.** Latency percentiles, error rates, payload sizes. The API style that looks elegant in development reveals its costs in production metrics.

## Practical Takeaways

There's no "best" API style. REST is the reliable default. GraphQL solves real problems for frontend-heavy teams with complex data needs — but brings real complexity. gRPC is the right tool for internal service communication where performance and type safety matter.

Our GraphQL migration wasn't a failure — the mobile app shipped and works. But it was an over-engineered solution to a problem we didn't have. A well-designed REST endpoint with field selection (`?fields=name,email`) would have served the same need with a fraction of the infrastructure.

**My current defaults:**

- **New public API?** REST with OpenAPI.
- **New internal service?** gRPC if performance matters, REST if team velocity matters more.
- **New frontend with complex data needs?** GraphQL BFF — but only with schema governance and DataLoader from day one.
- **Existing REST API that works?** Don't migrate it because a blog post said GraphQL is better.

The best API design decision is the one your team can build, operate, and debug at 2am on a Saturday. For most teams, most of the time, that's REST. And that's fine.

---

*API design comparison — September 2023. Protocol choices should follow your team's constraints, not industry trends.*

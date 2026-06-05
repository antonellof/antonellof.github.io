---
layout: post
title: "Monolith-First Strategy: When It Makes Sense"
date: 2023-10-12
categories: [Architecture]
tags: [Monolith, Architecture, Strategy]
excerpt: "We split into microservices at 8 engineers because a conference talk said to. Eighteen months later we merged three services back together. The monolith wasn't the problem — premature distribution was."
---

The conference talk had a compelling slide: "Monolith → Death Star." A single tangled ball of code transforming into elegant, independent services orbiting a tidy API gateway. The audience applauded. I was in the audience. Eight months later, I was on a team of eight engineers running fourteen microservices, three Kubernetes clusters, and a weekly "which service owns this bug?" ritual that consumed more time than feature development.

Three of those services got merged back into the monolith within the following year. Not because microservices are bad — because we'd distributed before we understood our domain, before we had the team to operate distributed systems, and before the monolith actually had problems that distribution would solve.

I've since built both monoliths and microservice architectures that worked. The difference wasn't the pattern — it was the timing. This post is about when to start with a monolith, how to keep it healthy, and how to know when splitting is actually justified.

## Why "Monolith" Became a Dirty Word

Microservices promised:

- Independent deployment (ship the payment service without touching user service)
- Independent scaling (scale the search service to 50 instances, keep billing at 2)
- Team autonomy (each team owns a service end-to-end)
- Technology diversity (Python for ML, Go for APIs, Node for real-time)

All real benefits. All irrelevant on day one of a startup with eight engineers and zero customers.

What microservices actually delivered for us in the first year:

- **Distributed debugging** — a user-facing bug required checking five services' logs
- **Deployment coordination** — schema changes needed synchronized deploys across services anyway
- **Network latency** — service-to-service calls added 15-30ms per hop
- **Operational overhead** — three K8s clusters, service mesh, distributed tracing, three on-call rotations
- **Data consistency** — sagas and eventual consistency for operations that were a single database transaction in the monolith

The monolith wasn't slow. It wasn't unscalable. It wasn't hard to deploy. We split it because we thought we were supposed to.

Martin Fowler's [Monolith First](https://martinfowler.com/bliki/MonolithFirst.html) essay says it directly: "almost all the successful microservice stories I've heard started with a monolith that got too big and was broken up." Almost none started with microservices from scratch.

## When Monolith-First Is the Right Call

### You Have a Small Team

If you can't assign at least one dedicated engineer per service for maintenance, you don't have enough people for microservices. Eight engineers across fourteen services means each service gets 0.57 engineers of attention. That's not ownership — that's neglect with extra network hops.

**My rule:** don't split until you have at least two teams (6+ engineers each) that need to deploy independently.

### Your Domain Isn't Understood Yet

Early-stage products change direction. Features pivot. Customer segments shift. A monolith absorbs this churn gracefully — rename a module, move a package, refactor a boundary. Microservices crystallize boundaries prematurely. Changing a service boundary means API versioning, data migration, and coordinated deploys.

The project that taught me this: we extracted a "Notification Service" in month three. By month nine, notifications were tightly coupled to billing, user preferences, and marketing campaigns. The "independent" service needed synchronized deploys with three other services for every feature. We merged it back.

### Speed Matters More Than Scale

A monolith deploys in one pipeline. One database migration. One health check. One rollback. For a team optimizing for product-market fit, this velocity advantage is enormous.

Our monolith-era deploy frequency: 12 times per day.
Our microservices-era deploy frequency (before merging back): 3 times per day, with "deployment days" requiring coordination across teams.

### Your Scale Doesn't Require Distribution

A well-architected monolith on modern hardware handles impressive load. Shopify's monolith (Ruby on Rails) processes billions in GMV. GitHub's monolith (Ruby on Rails) serves millions of developers. Stack Overflow runs on a handful of servers.

If your traffic fits on one or two application servers, distribution solves a problem you don't have while creating problems you do.

## The Modular Monolith: Best of Both Worlds

"Monolith" doesn't mean "big ball of mud." A modular monolith has clear internal boundaries that *could* become service boundaries later:

```javascript
// Organize by domain, not by technical layer
src/
├── users/
│   ├── domain/          // entities, business rules
│   ├── application/     // use cases, service layer
│   └── infrastructure/  // database, external APIs
├── orders/
│   ├── domain/
│   ├── application/
│   └── infrastructure/
├── payments/
│   ├── domain/
│   ├── application/
│   └── infrastructure/
└── shared/
    ├── events/          // domain event bus
    └── database/        // connection, migrations
```

**Key principles:**

- **Domain modules don't import from each other's internals** — `orders` uses `users.application.getUser()`, not `users.infrastructure.db.query()`
- **Communication through interfaces** — if you later extract `payments` into a service, the interface becomes an API call with minimal code changes
- **Shared database, clear table ownership** — `users` module owns the `users` table. `orders` references `user_id` but doesn't write to `users` table directly
- **Domain events for cross-module communication** — `UserCreated` event instead of direct function calls between modules

This is the monolith I build now. It deploys as one unit but has seams where you can split later.

## Keeping the Monolith Healthy

Monoliths fail when they become unmaintainable. That's not inevitable — it's a discipline problem.

**Enforce module boundaries.** We used ESLint `import/no-restricted-paths` to prevent cross-module internal imports:

```javascript
// .eslintrc.js
'import/no-restricted-paths': ['error', {
    zones: [
        { target: './src/orders', from: './src/users/infrastructure' },
        { target: './src/orders', from: './src/payments/infrastructure' },
        // Each module can only import from other modules' application layer
    ]
}]
```

**Separate database schemas by domain.** Even in one database, use PostgreSQL schemas or table prefixes to clarify ownership:

```sql
CREATE SCHEMA users;
CREATE SCHEMA orders;
CREATE TABLE users.accounts (...);
CREATE TABLE orders.purchases (...);
```

**Deploy frequently.** A monolith that deploys once a month accumulates risk. A monolith that deploys twelve times a day stays healthy because changes are small and reversible.

**Measure module coupling.** Before splitting, know which modules are actually coupled:

```bash
# Visualize import dependencies
npx madge --image dependency-graph.svg src/
```

If `orders` and `payments` have bidirectional imports, splitting them into services won't help — you'll just have distributed bidirectional coupling instead of local bidirectional coupling.

## When to Split (The Actual Triggers)

After running both monoliths and microservices, these are the legitimate reasons to extract a service:

### Independent Scaling

One module needs 20x the compute of everything else. Our search indexing process consumed 80% of CPU while the rest of the app was idle. Extracting search into its own service let us scale it independently. This was a real, measured problem — not a predicted one.

### Independent Deployment Cadence

Two teams constantly block each other on deploys. Team A ships user features daily. Team B ships payment compliance changes monthly with a two-week QA cycle. Merging these in one deploy pipeline creates friction. Splitting payments into its own service with its own pipeline solved a real coordination problem.

### Technology Mismatch

One module needs fundamentally different runtime characteristics. ML inference needs GPU instances. Real-time chat needs WebSocket connections with sticky sessions. Batch processing needs cron and high memory. Forcing these into one deployable unit creates awkward compromises.

### Team Boundaries

Conway's Law is real — your architecture mirrors your org chart. When you have two teams with clear domain ownership and minimal overlap, service boundaries aligned with team boundaries reduce coordination overhead.

### Failure Isolation

A bug in the email notification module shouldn't crash the payment processing module. In a monolith, an unhandled exception in one module can take down the entire application. If a non-critical module has stability issues, isolation has value.

**What is NOT a valid reason:**

- "Microservices are best practice" (it's an architectural style, not a maturity level)
- "We might need to scale someday" (YAGNI)
- "The codebase feels big" (200K lines in a monolith is fine with good module boundaries)
- "A conference speaker said to" (they're selling books)

## The Strangler Fig Pattern: How to Split Without Drama

When you do split, don't rewrite. Strangle the monolith incrementally:

```
Phase 1: Monolith handles everything
    [========== Monolith ==========]

Phase 2: Extract one module, route traffic
    [==== Monolith ====] → [Search Service]
         ↑ proxy routes search requests

Phase 3: Migrate data, deprecate monolith code
    [== Monolith ==] → [Search Service]
                      (owns search data now)

Phase 4: Repeat for next module
    [Monolith] → [Search] [Payments] [Notifications]
```

**Practical steps:**

1. **Identify the module** with the strongest boundary (least coupling to other modules)
2. **Create an API interface** in the monolith that the module already uses internally
3. **Build the service** behind the same interface
4. **Route traffic** through a proxy — monolith calls service instead of local module
5. **Migrate data** — move the module's tables to the service's database
6. **Delete the monolith code** — remove the extracted module
7. **Repeat** — one module at a time, months apart

We extracted search this way over three months. Zero downtime. Zero big-bang migration. The monolith got smaller and the service got battle-tested incrementally.

## What Our Architecture Looks Like Now

After the merge-back and re-extraction cycle, we have what I'd call a "selectively distributed" architecture:

- **Core monolith** — users, orders, billing, admin (one deploy, one database, modular internal structure)
- **Search service** — Elasticsearch indexing, independent scaling, own deployment
- **Notification worker** — async email/push processing, own queue, own scaling
- **ML inference service** — Python, GPU instances, completely different runtime

Three extracted services, not fourteen. Each extraction justified by a measured problem. The monolith handles 85% of traffic and 90% of feature development.

## Practical Takeaways

Start with a monolith. Not because microservices are bad — because you don't yet know where the boundaries should be. A modular monolith gives you fast development today and clean extraction points tomorrow.

**Do this:**

- Organize code by domain module, not technical layer
- Enforce module boundaries with linting and code review
- Deploy frequently (small changes, easy rollbacks)
- Measure coupling before considering splits
- Split one module at a time using the strangler fig pattern

**Don't do this:**

- Distribute because of architecture anxiety or conference FOMO
- Split before you understand your domain
- Create microservices without dedicated ownership per service
- Rewrite everything instead of strangling incrementally

The Death Star diagram assumed you already had a fully operational monolith and knew exactly where the seams were. We skipped that chapter. Don't make the same mistake — build the monolith, learn the domain, then split what actually needs splitting.

Eight engineers, fourteen services, three merged back. The math wasn't mathing. Two teams, one modular monolith, three extracted services with clear justification. The math mathers.

---

*Monolith-first strategy — October 2023. See Martin Fowler's [Monolith First](https://martinfowler.com/bliki/MonolithFirst.html) for the original argument.*

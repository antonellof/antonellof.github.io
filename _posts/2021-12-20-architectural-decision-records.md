---
layout: post
title: "Architectural Decision Records: Documenting Key Decisions"
date: 2021-12-20
categories: [Architecture]
tags: [ADR, Documentation, Architecture]
excerpt: "Six months later, nobody remembered why we chose PostgreSQL over DynamoDB. ADRs capture the context, the trade-offs, and the 'we considered X but rejected it because' that wiki pages never preserve."
---

"Why did we use PostgreSQL instead of DynamoDB?"

Silence in the meeting. Someone said "I think Dave decided that." Dave left the company four months ago. The wiki page titled "Database Decision" was empty—someone created it, nobody wrote anything. We were debating migrating to DynamoDB based on a cost spreadsheet, without knowing what constraints led to the original choice.

This happens constantly. Teams make reasonable decisions with good context, then the context evaporates. People leave. Memories fade. New engineers question decisions without understanding the trade-offs that shaped them. Re-litigating settled questions wastes weeks.

Architectural Decision Records (ADRs) fix this. Short documents capturing **why** a decision was made, not just what was decided. I learned about them through [Michael Nygard's template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) and they've become non-negotiable on every team I lead.

## What an ADR Is

An ADR is a markdown file that records a significant architectural decision:

- **Context** — what situation forced a decision
- **Decision** — what we chose
- **Consequences** — what we gain and what we sacrifice
- **Alternatives** — what else we considered and why we rejected it

ADRs are immutable once accepted. If a decision changes, write a new ADR that supersedes the old one. The history remains—you can trace how thinking evolved.

They're not design docs (too detailed), not meeting notes (too unstructured), not wiki pages (too often empty). One decision per ADR. Two pages max. Five minutes to read.

## The Template

```markdown
# ADR-001: Use PostgreSQL as Primary Database

## Status
Accepted

## Date
2021-03-15

## Context
We're building an e-commerce platform that needs:
- ACID transactions for orders and payments
- Complex queries (reporting, search, joins across entities)
- Strong consistency for inventory management
- Team has deep PostgreSQL experience

We're expecting ~10K orders/day initially, scaling to 100K/day within 2 years.

## Decision
We will use PostgreSQL (AWS RDS) as our primary transactional database.

## Consequences

### Positive
- ACID transactions for order processing
- Rich query capabilities for reporting and analytics
- Team productivity — no learning curve
- Mature ecosystem (extensions, tooling, hosting)
- Point-in-time recovery and automated backups via RDS

### Negative
- Vertical scaling limits — will need read replicas and connection pooling
- Operational overhead compared to managed NoSQL
- Schema migrations require planning and tooling
- Not ideal for high-write, simple-key workloads (we'll use Redis for sessions)

## Alternatives Considered

### DynamoDB
- **Pros:** Serverless scaling, pay-per-use, AWS-native
- **Rejected because:** Complex queries require GSIs that are hard to predict upfront.
  Reporting needs ad-hoc joins. Team lacks DynamoDB data modeling experience.
  Transaction support was limited at decision time.

### MongoDB
- **Pros:** Flexible schema, horizontal scaling, document model
- **Rejected because:** Multi-document ACID was new and unproven for our use case.
  Team more experienced with relational models. Join-heavy reporting queries
  would require application-level denormalization.

### MySQL
- **Pros:** Similar to PostgreSQL, wide hosting support
- **Rejected because:** PostgreSQL has better JSON support, richer extensions
  (PostGIS, full-text search), and partial indexes we anticipate needing.
```

That's a complete ADR. Future engineers reading this understand the constraints, the trade-offs, and why DynamoDB wasn't chosen—even if DynamoDB has improved since.

## When to Write an ADR

### Write ADRs for:

- **Technology choices** — database, message queue, cloud provider, framework
- **Architecture patterns** — microservices vs monolith, event sourcing, CQRS
- **API design** — REST vs GraphQL, versioning strategy, authentication approach
- **Infrastructure** — Kubernetes vs serverless, multi-region strategy
- **Process decisions** — branching strategy, deployment approach, testing philosophy

### Skip ADRs for:

- **Implementation details** — which sorting algorithm, variable naming
- **Temporary workarounds** — use a ticket, not an ADR
- **Obvious choices** — "we'll use Git for version control"
- **Reversible decisions** — if you can change it in an afternoon without blast radius

**The test:** will someone in 12 months ask "why did we do it this way?" If yes, write an ADR.

## ADR Lifecycle

### Status Values

| Status | Meaning |
|--------|---------|
| **Proposed** | Under discussion, not yet decided |
| **Accepted** | Decision made, implementing |
| **Deprecated** | No longer relevant, but not replaced |
| **Superseded** | Replaced by a newer ADR (link to it) |

```markdown
# ADR-003: Migrate from REST to GraphQL for Public API

## Status
Supersedes [ADR-002: Use REST for Public API](./0002-use-rest-for-public-api)

## Context
Since ADR-002, our mobile clients have grown to 3 apps with different data
needs. Over-fetching and multiple round-trips are causing performance issues...
```

The superseded ADR stays in the repo with updated status. History is preserved.

## File Organization

```
docs/
  adr/
    0001-use-postgresql.md
    0002-use-rest-for-public-api.md
    0003-migrate-to-graphql.md
    README.md          # Index of all ADRs with status
```

```markdown
# ADR Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| 001 | Use PostgreSQL | Accepted | 2021-03-15 |
| 002 | Use REST for Public API | Superseded by 003 | 2021-05-20 |
| 003 | Migrate to GraphQL | Accepted | 2021-11-10 |
```

Number sequentially. Never renumber (references break). Store in git alongside code—ADRs are versioned with the project.

## Real Examples

### Framework Choice

```markdown
# ADR-004: Use React with TypeScript for Frontend

## Status
Accepted

## Context
Building a complex dashboard with real-time updates, 20+ screens,
and a team of 4 frontend developers.

## Decision
React 18 with TypeScript, Vite for bundling, TanStack Query for server state.

## Consequences
- Positive: Large ecosystem, team experience, TypeScript catches bugs early
- Negative: Bundle size, need discipline to avoid prop drilling (use context/stores)

## Alternatives Considered
- Vue 3: Less team experience, smaller enterprise ecosystem
- Angular: Heavier framework, steeper learning curve for team
- Svelte: Smaller ecosystem, fewer enterprise-ready component libraries
```

### Process Decision

```markdown
# ADR-005: Trunk-Based Development with Feature Flags

## Status
Accepted

## Context
GitFlow is causing merge conflicts and long-lived branches. Releases take
2 weeks. We deploy to production multiple times daily.

## Decision
Trunk-based development: all work on main, feature flags for incomplete features.

## Consequences
- Positive: Smaller PRs, faster integration, continuous deployment
- Negative: Feature flag overhead, need flag management tooling (LaunchDarkly)
```

## Making ADRs Stick

**What worked:**
- ADRs required in PRs for architectural changes (CI check or review convention)
- Template in repo (`docs/adr/template.md`) — copy, fill in, PR
- Review ADRs in architecture meetings (15 min, not 60)
- Link ADRs from relevant code (`// See ADR-001 for database choice`)

**What didn't work:**
- Mandating ADRs for everything (fatigue)
- Long, detailed ADRs (nobody reads 10-page documents)
- ADRs in Confluence (separate from code, not versioned, gets stale)
- Writing ADRs after the fact months later (context is gone)

**Sweet spot:** 2-5 ADRs per quarter. Significant decisions only. Written at decision time, not retrospectively.

## Tools

- **[adr-tools](https://github.com/npryce/adr-tools)** — CLI for creating ADRs from template
- **[log4brains](https://github.com/thomastrauner/log4brains)** — ADR knowledge base with web UI
- **Git** — the versioning system; ADRs live in the repo

```bash
# adr-tools
adr new "Use PostgreSQL as Primary Database"
adr generate toc > docs/adr/README.md
```

## Conclusion

The PostgreSQL vs DynamoDB question that stumped the meeting? An ADR would have answered it in two minutes. Context, constraints, alternatives, trade-offs—all preserved from the day we decided.

ADRs aren't bureaucracy. They're empathy for your future teammates—the ones who weren't in the room, who join next year, who inherit your decisions and deserve to understand them.

Write the context. Document the alternatives you rejected. Be honest about negative consequences. Store it in git. Link it when the question comes up again.

Six months from now, you'll ask "why did we do it this way?" With ADRs, you'll have an answer. Without them, you'll have a debate that wastes a week re-litigating a decision someone already made correctly—the first time, with context nobody wrote down.

Start with one ADR for your next significant decision. See if it saves a meeting in six months.

---

*Architectural Decision Records from December 2021, covering ADR format and best practices.*

---
layout: post
title: "Exit Strategy: Technical Lessons from Scaling a SaaS to Exit"
date: 2019-12-07
categories: [Case Study]
tags: [SaaS, Exit, Lessons Learned]
excerpt: "Four years, 2 million users, one acquisition. The technical decisions that made due diligence boring — and the ones that almost didn't."
---

Due diligence is where your technical debt goes to get a price tag.

When acquirers evaluate a SaaS company, they're not admiring your microservice architecture diagrams. They're asking: can this system survive 10x growth? Will it stay up? Can a new team maintain it without summoning the original engineers from retirement? Is there a security incident waiting to happen in that Rails monolith you keep calling "temporarily permanent"?

We scaled a SaaS platform from MVP to acquisition over four years — 1,000 users to over 2 million. The acquisition closed because the business worked. But the due diligence was boring, and boring is the goal. Boring means no red flags, no "we need to rebuild this before we can integrate it," no acquirer engineer opening the codebase and quietly updating their resume.

Here's what actually mattered technically — and what we'd do differently if we started today.

## The Timeline (Compressed)

- **Year 1:** MVP launch, ~1,000 users, one Rails monolith, one PostgreSQL database
- **Year 2:** Product-market fit, ~50,000 users, first service extractions
- **Year 3:** Scaling pain, ~500,000 users, sharding, caching, microservices
- **Year 4:** Acquisition, 2M+ users, architecture that survived scrutiny

Each phase had a defining technical crisis. Year 1 was "ship fast." Year 2 was "why is deploy taking 30 minutes." Year 3 was "why is the database on fire." Year 4 was "please don't find anything scary in our infrastructure."

## Architecture Evolution: Three Acts

### Act 1: The Monolith (Year 1)

```
┌─────────────┐
│  Monolith   │
│  (Rails)    │
└──────┬──────┘
       │
┌──────▼──────┐
│ PostgreSQL  │
└─────────────┘
```

One codebase. One database. One deploy. Maximum velocity, minimum operational complexity.

**What worked:** We shipped features weekly. Debugging meant reading one stack trace. Onboarding a new engineer took days, not months. For 1,000 users, this was the correct architecture — not a shortcut, the correct one.

**What didn't:** We knew the ceiling was coming. Deploy times crept up as the test suite grew. The database became the implicit bottleneck for every feature. And "just restart the server" was our incident response plan, which works until it doesn't.

The monolith wasn't a mistake. Staying in it too long would have been.

### Act 2: Service Extraction (Year 2)

```
┌─────────────┐
│ API Gateway │
└──────┬──────┘
       │
   ┌───┴───┬────────┬────────┐
   │       │        │        │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌───▼──┐
│User │ │Order│ │Pay  │ │Email │
│Svc  │ │Svc  │ │Svc  │ │Svc   │
└──┬──┘ └──┬──┘ └──┬──┘ └──┬───┘
   │       │       │       │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌──▼──┐
│User │ │Order│ │Pay  │ │Queue│
│DB   │ │DB   │ │DB   │ │     │
└─────┘ └─────┘ └─────┘ └─────┘
```

We extracted services at natural boundaries — payments (PCI isolation), email (async, different scaling profile), orders (core business logic). Not microservices cosplay. Deliberate seams.

**What worked:** Independent deploys dropped from 30 minutes to 5. Payment service scaled separately from the read-heavy user service. Teams owned services, not layers.

**What didn't:** Distributed debugging arrived like an unwanted houseguest. A user report of "checkout failed" now meant checking four services, three databases, and a message queue. We needed observability before we needed more services — and we learned that in the expensive way.

### Act 3: Microservices at Scale (Years 3–4)

```
                    ┌─────────────┐
                    │   CDN       │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ API Gateway │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼────┐        ┌────▼────┐       ┌────▼────┐
   │  User  │        │  Order  │       │  Pay    │
   │ Service│        │ Service │       │ Service │
   └────┬────┘        └────┬────┘       └────┬────┘
        │                  │                  │
   ┌────▼────┐        ┌────▼────┐       ┌────▼────┐
   │Postgres │        │DynamoDB │       │ Stripe  │
   │(Sharded)│        │         │       │         │
   └─────────┘        └─────────┘       └─────────┘
```

Horizontal scaling, polyglot persistence, CDN for static assets, API gateway for routing and rate limiting. The architecture that acquirers looked at and said "this can scale."

**What worked:** Fault isolation. A bug in the email service didn't take down checkout. Team autonomy — the payments team shipped without coordinating with the user team. Horizontal scaling actually worked once we stopped fighting the database.

## The Decisions That Mattered

### Database Sharding (The One We Delayed Too Long)

We sharded PostgreSQL by `user_id` when write throughput started hitting ceiling on our largest RDS instance.

**Impact:** ~10x write capacity. Query latency dropped because each shard held less data. Connection contention eased.

**The lesson:** Shard before you need to, but not before you have a shard key. We waited until emergency-level pain, which meant sharding under pressure — the worst time to make data architecture decisions. If your user_id (or tenant_id) is your natural partition key, design for sharding at 100K users even if you don't implement it until 500K.

### Multi-Layer Caching (The Best ROI Decision)

Redis for hot data (user sessions, frequently accessed records). CDN for static assets and cacheable API responses. Application-level caching for expensive computations.

**Impact:** ~80% cache hit rate on reads. Database query volume dropped 10x. P95 response time went from 800ms to under 50ms for cached paths.

**The lesson:** Cache aggressively, but invest equally in cache invalidation strategy. Our first caching layer was fast and wrong — stale data caused more user-facing bugs than slow queries ever did. Cache invalidation is hard. Budget time for it.

### Message Queues for Everything Async (SQS)

Order confirmations, email sends, analytics events, search index updates — anything that didn't need to happen before the API response returned went through SQS.

**Impact:** API response times dropped because we stopped doing heavy work synchronously. Services decoupled cleanly. Traffic spikes got absorbed by queue depth instead of crashing consumers.

**The lesson:** If it can be async, make it async. The only work in your request path should be what the user is waiting for. Everything else is a message.

### Observability Before It Was Cool (Prometheus + Grafana + Datadog)

Metrics, dashboards, and alerting from early Year 2 — not because we were virtuous, but because distributed debugging without data is guessing.

**Impact:** Mean time to detection dropped from hours to minutes. Post-mortems had actual data instead of theories. During due diligence, we could show 99.99% uptime with graphs to prove it.

**The lesson:** Observability is not a scaling concern — it's a survival concern. The moment you have more than one service, you need distributed tracing and centralized metrics. We added it at two services and wished we'd added it at one.

### Feature Flags (Deploy Without Praying)

We adopted LaunchDarkly-style feature flags in Year 2 and they paid for themselves within a month. The pattern was simple: deploy code with features disabled, enable for internal users, then 5% of production traffic, then everyone.

**Impact:** Deploys decoupled from releases. A broken feature could be toggled off in seconds without a rollback deploy. A/B tests became a configuration change, not a code branch that lived for six months.

**The lesson:** Feature flags aren't just for experiments. They're an incident response tool. The payment flow that broke at 2 AM was disabled in 30 seconds while we fixed the root cause. Without flags, we'd have been rolling back a deploy that also contained three unrelated fixes.

### Security and Compliance (The Unsexy Deal-Killer)

Nobody tweets about SOC 2 compliance. Acquirers absolutely ask about it.

We invested in PCI DSS compliance for the payment service early — isolating card data, tokenizing via Stripe, keeping our infrastructure out of scope. GDPR readiness meant data export endpoints, deletion workflows, and audit logs for data access. Dependency scanning ran in CI. Secrets lived in AWS Secrets Manager, not environment variables in docker-compose files from 2016.

**Impact:** Security due diligence took two weeks instead of two months. No "we need to remediate before close" clauses. No valuation haircut from a pentest finding that said "your API keys are in your git history."

**The lesson:** Security isn't a feature you add before acquisition. It's a property of how you build from day one. Retroactive compliance is three times more expensive and acquirers can smell it.

### Polyglot Persistence (Using the Right Database Per Job)

We didn't pick one database and force everything into it. PostgreSQL handled relational core data — users, orders, billing records. DynamoDB handled high-throughput session storage and event streams. Redis handled hot caching. S3 handled file uploads and exports.

**Impact:** Each datastore operated within its comfort zone. Session reads at 50K/second didn't touch PostgreSQL. Complex revenue reports didn't require DynamoDB workarounds.

**The lesson:** "We use PostgreSQL for everything" is a fine Year 1 statement and a Year 3 liability. Adding a second datastore is operationally expensive, but forcing the wrong access pattern onto your primary database is more expensive.

## The Crises That Taught Us

### Database Bottleneck (Year 2–3)

**The problem:** Single PostgreSQL instance at 95% CPU. Queries that took 10ms took 2 seconds. Connection pool exhausted during traffic spikes.

**The progression:** Read replicas (helped reads, not writes) → connection pooling via PgBouncer (helped connections, not query volume) → query optimization (helped specific queries, not overall load) → sharding (actually solved it).

**The lesson:** The database is almost always the first bottleneck. Plan for it explicitly. Don't wait for 95% CPU to start thinking about scaling — at 60% CPU with accelerating growth, start the conversation.

### Deployment Complexity (Year 2)

**The problem:** Monolith deploy took 30+ minutes. Full test suite, asset compilation, database migrations, rolling restart. We shipped twice a week because deploys were scary.

**The solution:** Service extraction (smaller deploy units), blue-green deployments (instant rollback), feature flags (deploy without releasing), canary releases (test on 5% of traffic before full rollout).

**The lesson:** Deployment infrastructure is a feature. Every hour saved on deploys is an hour spent on product. Invest in CI/CD early — not when deploys are already painful, but when they're still fine. It's cheaper to build good habits than break bad ones.

### Team Scaling (Year 3)

**The problem:** Four engineers who knew the entire system became twelve engineers who each knew a corner. Knowledge silos formed. Onboarding took weeks. Architecture decisions happened in isolation.

**The solution:** Architecture decision records (ADRs), mandatory code reviews, weekly architecture review meetings, and documentation that was treated as a deliverable, not a afterthought.

**The lesson:** Your team's ability to understand the system is a scaling bottleneck equal to any technical one. Documentation and processes are infrastructure. They don't show up in architecture diagrams, but acquirers notice when they're missing.

### The Incident That Almost Cost Us (Year 3, Black Friday)

Black Friday traffic was 4x our previous peak. We thought we were ready. We had load-tested to 2x. Math is not our strong suit.

At 9 AM, database connections maxed out. At 9:15, the API gateway started returning 503s. At 9:30, our CEO was on a Zoom call with our biggest enterprise customer explaining why their dashboard was a loading spinner.

**What saved us:** Redis cache absorbed enough read traffic to stabilize within 45 minutes. SQS queue depth grew but consumers kept processing — async work didn't die. Feature flags let us disable a non-critical analytics pipeline that was hammering the database. Auto-scaling added API gateway instances within minutes.

**What hurt us:** No pre-warmed cache for the traffic pattern we should have predicted. Connection pool limits set for normal traffic, not peak. A runbook that said "scale up the database" but didn't document *how* under pressure.

**The lesson:** Load test to your expected peak plus margin, not your current traffic. Write runbooks during calm weeks, not during incidents. And tell your CEO before Black Friday that "4x load test" means "we tested 4x last month's traffic," not "we tested 4x Black Friday."

### Cost Optimization (Because AWS Bills Don't Scale to Exit)

At 500K users, our AWS bill was uncomfortable. At 2M users without optimization, it would have been a due diligence red flag — acquirers model ongoing infrastructure costs.

We right-sized RDS instances (smaller than we feared after caching worked), moved static assets to CloudFront, reserved instances for predictable baseline load, and switched bursty DynamoDB tables to on-demand pricing. The engineering time investment was about two weeks. The annual savings were enough to fund another engineer.

**The lesson:** Cost optimization isn't premature at 50K users. It's how you demonstrate operational maturity. An acquirer seeing a well-optimized infrastructure bill thinks "this team knows how to run production." A bill that scales linearly with users makes them do math you don't want them doing.

## What We'd Do Differently

### Start with Clear Service Boundaries (Not Necessarily Microservices)

We'd define bounded contexts early — user management, billing, notifications — even within the monolith. Extract services at those boundaries when scaling demands it, not before and not after the pain becomes emergency-level.

Microservices from day one? No. Clear module boundaries from day one? Absolutely. The migration cost from "well-bounded monolith" to "services" is dramatically lower than from "ball of mud" to "services."

### Testing from Day One (Not Year 2)

We added comprehensive tests as we scaled, which meant our early code — the core business logic — had the weakest coverage. Refactoring the order processing flow at 500K users with 40% test coverage is terrifying.

Test-driven development felt slow at 1,000 users. It felt essential at 500,000. The interest on skipped tests compounds just like financial debt.

### Monitoring from the First Deploy

We added monitoring when things broke. Classic mistake. The incidents we couldn't debug — because we had no metrics from before the failure — were the most expensive ones.

Comprehensive monitoring from the start means you have baselines. You know what "normal" looks like. Without baselines, you're detecting anomalies by gut feel.

### Document as You Build

We documented retroactively, which meant the docs were either wrong or missing for anything built in Year 1. During due diligence, acquirers asked about design decisions from 2016 and we had to reconstruct the reasoning from git blame and memory.

Write the ADR when you make the decision, not six months later when you've forgotten why.

### CI/CD as a First-Class Product (Not an Afterthought)

Our CI/CD pipeline in Year 1 was "push to master and pray." By Year 3, every service had automated tests, linting, security scanning, and deployment to staging on every pull request. Production deploys required a merge to `main` and a button click — not SSH into a server and run a script named `deploy_final_v2.sh`.

GitHub Actions orchestrated the pipeline. Docker images built on every commit. Database migrations ran as a separate, monitored step — never silently inside a deploy script. Rollback meant deploying the previous image tag, not reverting a git commit and hoping.

**Impact:** Deploy frequency went from twice a week to multiple times a day. Failed deploys were caught in staging, not production. New engineers shipped code on day three, not week three.

**The lesson:** CI/CD maturity is one of the first things acquirer engineers evaluate. They've seen too many companies where "deploy" means one person with SSH access and tribal knowledge. Automate it early, when deploys are still painless to automate.

## The Numbers

| Metric | Before Optimization | After Optimization |
|--------|-------------------|-------------------|
| Average response time | 2.5s | 150ms |
| Database CPU | 95% | 30% |
| Deploy time | 30 minutes | 5 minutes |
| Uptime | 99.5% | 99.99% |

These numbers mattered enormously during due diligence. Acquirers don't just ask "does it work today?" — they model what happens at 5x and 10x current scale. Showing that you'd already optimized from 2.5s to 150ms demonstrated capacity for further growth.

The uptime jump from 99.5% to 99.99% sounds incremental until you do the math: 99.5% is 3.6 hours of downtime per month. 99.99% is 4.3 minutes. Enterprise customers notice the difference. Acquirers modeling SLA liabilities notice it even more.

Deploy time going from 30 minutes to 5 minutes wasn't just a developer happiness metric — it meant we could ship fixes during an incident without the deploy itself becoming part of the problem. When your mean time to recovery includes a 30-minute deploy, you're not recovering — you're waiting.

Track these metrics from the beginning, even when the numbers are embarrassingly bad. You can't demonstrate improvement without a baseline, and acquirers trust teams who can show a trajectory more than teams who can show a snapshot.

## What Acquirers Actually Looked At

Technical due diligence wasn't a code style review. It was a risk assessment:

**Scalability:** Can this handle 10x users without a rewrite? Our sharded PostgreSQL + DynamoDB for sessions + CDN + queue-based async processing told a credible scaling story.

**Reliability:** Uptime records, incident history, post-mortem culture. 99.99% uptime with documented incidents and remediation was better than 99.99% with no incident records (which looks like you're not measuring).

**Maintainability:** Code quality, test coverage, documentation, CI/CD maturity. Could their team maintain this, or would they need to hire us forever?

**Security:** Authentication, encryption, PCI compliance for payments, dependency scanning, access controls. One security red flag can kill a deal or slash the valuation.

**Team and process:** Engineering culture, onboarding docs, code review practices, deployment processes. They were buying the team's capability as much as the code.

What helped most: clean architecture they could understand in a week, documentation that answered their questions without scheduling meetings, monitoring dashboards that proved reliability claims, automated tests they could run and trust, and processes that showed the system wouldn't collapse when we left.

### The Questions They Actually Asked

These aren't hypothetical. These are the questions that came up in technical diligence sessions:

- "Walk us through what happens when a user checks out." (They wanted a request trace, not an architecture diagram.)
- "What's your disaster recovery plan? RPO and RTO?" (We had runbooks. Many startups don't.)
- "Show us your last three incidents and what you changed." (Post-mortem culture was a positive signal.)
- "How do you handle database migrations without downtime?" (Blue-green deploys + backward-compatible migrations.)
- "What's your test coverage on the payment flow?" (Specific, not aggregate.)
- "Who has production access and how is it audited?" (Least-privilege IAM, not shared root passwords.)
- "What happens if Stripe goes down?" (Graceful degradation, not cascading failure.)

The teams that breeze through diligence aren't the ones with the fanciest architecture. They're the ones who can answer these questions with evidence, not confidence.

### What Would Have Raised Red Flags

We avoided these, but we saw them kill deals for other companies in our network:

- Hardcoded credentials in source code (git history never forgets)
- No automated backups with tested restore procedures
- Single points of failure with no failover plan
- "Our CTO is the only person who understands the deployment process"
- No monitoring — "we know it's working because customers aren't complaining"
- Licensing issues in dependencies (GPL contamination in a proprietary SaaS)
- Customer data stored without encryption at rest

Any one of these can pause a deal for weeks. Two or more can kill it.

## Lessons That Survived the Exit

**Start simple, scale when evidence demands it.** The monolith was right for Year 1. Microservices were right for Year 3. The mistake is picking Year 3 architecture for Year 1 problems.

**The database is the bottleneck until proven otherwise.** Every scaling conversation starts with the database. Plan for it.

**Cache aggressively, invalidate carefully.** Performance gains from caching are enormous. Bugs from stale cache are subtle and user-facing.

**Make it async by default.** Synchronous request paths should be minimal. Everything else is a queue message.

**Observability is infrastructure, not a feature.** Metrics, tracing, and alerting from the start. Not when things break — before things break.

**Deploys should be boring.** If shipping code is scary, you ship less often, and each deploy carries more risk. Small, frequent, automated deploys win.

**Document decisions, not just code.** ADRs, runbooks, architecture diagrams. Due diligence reads your docs. Future you reads your docs. Both will thank present you.

**Processes scale teams; code doesn't scale teams.** Code reviews, architecture reviews, post-mortems, onboarding programs — these are how you go from 4 engineers to 12 without chaos.

**Hire for judgment, teach skills.** Skills can be learned. The ability to make good architectural decisions under uncertainty cannot be taught in onboarding.

**Celebrate operational wins, not just feature launches.** Nobody throws a party for "we reduced P95 latency by 40%." But operational excellence is what makes features survivable at scale. Recognize the work that keeps the lights on.

**Run fire drills before the fire.** We started quarterly game days in Year 3 — kill a database replica, simulate an AZ failure, practice the incident response runbook. The first real incident after a game day, the team moved faster because they'd practiced under controlled chaos.

## The Real Conclusion

Scaling to exit wasn't about having the most sophisticated architecture. It was about having an architecture that matched each growth stage, making deliberate decisions (and documenting why), building observability and deployment infrastructure before they were emergencies, and keeping the system understandable enough that someone new could operate it.

The acquisition closed. The due diligence was boring. The architecture wasn't perfect — no architecture is. But it was defensible, scalable, and maintainable. In the context of an exit, that's the technical bar.

If you're building toward an exit (or just building toward not collapsing at 2x traffic), the question isn't "should we use microservices?" It's "will our current architecture survive the next order of magnitude, and do we have the data to know?"

The founders who survive diligence aren't the ones who made perfect decisions. They're the ones who made *defensible* decisions, documented the reasoning, built the observability to prove the system works, and created processes that don't depend on any single engineer's memory.

Start with a monolith. Extract services at real seams. Cache before you shard. Queue everything async. Observe before you scale. Document before you forget. Automate deploys before they become scary. And when Black Friday comes, make sure you load-tested to the traffic you'll actually get — not the traffic you hope for.

Get the data. Make the decisions. Write them down. Ship boring reliability. Boring due diligence is the best due diligence.

---

*Written December 2019, reflecting on four years of scaling a SaaS platform to acquisition. The specific technologies have evolved, but the patterns — start simple, scale on evidence, cache and queue aggressively, observe everything, document decisions — remain the foundation of acquirable engineering.*

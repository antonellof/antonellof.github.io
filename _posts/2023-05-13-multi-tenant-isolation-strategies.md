---
layout: post
title: "Multi-Tenant Architecture: Isolation Strategies"
date: 2023-05-13
categories: [Architecture]
tags: [Multi-Tenant, Architecture, Isolation]
excerpt: "Tenant A's invoice showed Tenant B's revenue. One missing WHERE clause. Here's how we rebuilt isolation after learning the hard way that 'shared database' doesn't mean 'shared data.'"
---

The support ticket was labeled "billing discrepancy." Finance had exported a revenue report for Acme Corp and found $47,000 in transactions that weren't theirs. I pulled the query logs and felt my stomach drop. The report endpoint filtered by date range but not by `tenant_id`. Acme Corp had seen another customer's data for three weeks before anyone noticed.

Nobody got fired — it was a missing `WHERE` clause, not malice. But the postmortem was brutal. We'd chosen "shared database, shared schema" because it was cheapest and fastest to ship. We added `tenant_id` columns everywhere and trusted application code to filter. One developer, one rushed PR, one absent code review, and our isolation model was fiction.

That incident reshaped how I think about multi-tenant architecture. Isolation isn't a column you add — it's a property you prove. This post covers the three main strategies, when each makes sense, and how to not learn this lesson the expensive way.

## The Three Isolation Models

Every multi-tenant SaaS picks a point on the spectrum between "one database for everyone" and "one database per customer." There are three common stops:

### Shared Database, Shared Schema

Everyone's data lives in the same tables, distinguished by a `tenant_id` column:

```sql
-- All tenants in same table
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    total DECIMAL
);

-- Always filter by tenant_id
SELECT * FROM orders WHERE tenant_id = 123;
```

**Why teams choose this:** One schema to migrate. One connection pool. One backup strategy. Lowest operational cost. Fastest time to market.

**Why it keeps me up at night:** Isolation is enforced by application code, not the database. Every query must include `tenant_id`. Every join must propagate it. Every new engineer must know the rule. One omission — like our billing report — and tenants see each other's data.

**When it works:**

- Early-stage SaaS with < 100 tenants
- Teams with strong code review culture and automated enforcement
- Data sensitivity is moderate (not healthcare, not finance with strict audit requirements)
- You invest in guardrails (see below)

**When it fails:**

- Compliance requirements demand provable isolation (SOC 2 Type II auditors will ask)
- Tenant count grows and noisy-neighbor performance becomes real
- Enterprise customers demand dedicated infrastructure in their contract

### Shared Database, Separate Schema

Each tenant gets their own PostgreSQL schema within a shared database:

```sql
-- Each tenant has own schema
CREATE SCHEMA tenant_123;
CREATE TABLE tenant_123.orders (...);

-- Switch schema per request
SET search_path TO tenant_123;
```

**Why teams choose this:** Stronger logical isolation than shared tables. Schema-per-tenant feels like separate databases without the connection overhead. Migrations can be applied per-tenant (useful for gradual rollouts).

**The tradeoffs:** Schema management gets complicated at scale. A thousand tenants means a thousand schemas. Migration scripts must run against each one. Connection pooling needs to set `search_path` per request. Some ORMs fight you on this.

I used this model for a B2B platform with ~200 mid-market customers. It worked well until we hit 400 schemas and migration times became a deployment bottleneck. We eventually migrated the largest tenants to dedicated databases and kept small tenants on shared schemas.

**When it works:**

- 50–500 tenants with similar data volumes
- Need stronger isolation than `tenant_id` filtering without full database separation
- Compliance requirements that accept logical separation within a shared instance

### Separate Database (or Shard)

Each tenant (or group of tenants) gets a dedicated database instance:

```javascript
// Route to tenant-specific database
function getDatabase(tenantId) {
    const shard = getShard(tenantId);
    return databases[shard];
}
```

**Why teams choose this:** Maximum isolation. Performance isolation — one tenant's heavy query doesn't slow others. Data residency — EU tenants on EU databases. Enterprise sales teams love "dedicated infrastructure" in contracts.

**The tradeoffs:** Operational complexity scales with tenant count. Schema migrations across 500 databases. Connection management nightmares. Cost — even small tenants get a database overhead.

I built this for an enterprise SaaS where contracts literally required dedicated databases for Fortune 500 clients. The architecture worked, but our DevOps team grew faster than our engineering team. That's the hidden cost.

**When it works:**

- Enterprise customers paying enough to justify dedicated infrastructure
- Strict regulatory requirements (HIPAA, data residency laws)
- Performance isolation is a product requirement, not a nice-to-have
- Tenant count is manageable (< 100 dedicated instances) or you have strong automation

## The Guardrails That Actually Prevent Leaks

After our billing incident, we implemented defense in depth. No single layer is sufficient; together they make leaks very hard:

### 1. Row-Level Security (PostgreSQL)

```sql
-- Enable RLS on every tenant-scoped table
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON orders
    USING (tenant_id = current_setting('app.current_tenant')::integer);

-- Set tenant context at connection start
SET app.current_tenant = '123';
```

RLS means even if application code forgets the `WHERE` clause, the database refuses to return other tenants' rows. This is the single most impactful change we made. The billing report bug would have returned empty results instead of another tenant's data.

Read the [PostgreSQL RLS documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — it's more powerful than most teams realize.

### 2. Tenant Context Middleware

```javascript
// Set tenant context once per request, early in the pipeline
async function tenantMiddleware(req, res, next) {
    const tenantId = extractTenantFromJWT(req);
    if (!tenantId) return res.status(401).json({ error: 'No tenant context' });

    req.tenantId = tenantId;

    // Set DB session variable for RLS
    await db.query(`SET app.current_tenant = $1`, [tenantId]);

    next();
}
```

Every request gets tenant context before touching any business logic. No function should accept `tenantId` as a parameter that callers can get wrong — it comes from the authenticated session.

### 3. Automated Query Auditing

We added a CI check that parsed SQL in our ORM layer and flagged queries against tenant-scoped tables that didn't reference `tenant_id` or weren't covered by RLS. Heavy-handed? Yes. Caught three bugs in the first month.

### 4. Integration Tests for Isolation

```javascript
test('tenant A cannot see tenant B orders', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();

    await createOrder(tenantA, { total: 100 });
    await createOrder(tenantB, { total: 200 });

    const ordersForA = await getOrders(tenantA);
    expect(ordersForA).toHaveLength(1);
    expect(ordersForA[0].total).toBe(100);
    expect(ordersForA).not.toContainEqual(
        expect.objectContaining({ tenant_id: tenantB.id })
    );
});
```

Every API endpoint that returns tenant data has a cross-tenant isolation test. These tests run on every PR. Boring to write. Essential to keep.

## Choosing Your Strategy: A Decision Framework

I use this framework now instead of defaulting to "cheapest option":

| Factor | Shared Schema | Separate Schema | Separate DB |
|--------|--------------|-----------------|-------------|
| Tenant count | < 500 | 50–500 | Any (but ops cost scales) |
| Compliance | Moderate | Moderate–High | High |
| Enterprise sales | Startup/SMB | Mid-market | Enterprise |
| Team size | Small | Medium | Large (need DevOps) |
| Data sensitivity | Low–Moderate | Moderate–High | High |

**My current recommendation for new SaaS:**

Start with shared database, shared schema — but implement RLS from day one, not day three hundred. Add tenant context middleware before the first API endpoint ships. Write isolation tests before the second tenant onboards.

Migrate to separate databases when contracts or compliance demand it, not when Twitter says you should.

## The Hybrid Approach (What We Ended Up With)

Most mature SaaS platforms I know don't pick one strategy — they use all three:

- **Small tenants:** shared schema with RLS
- **Mid-market tenants:** separate schema or dedicated shard
- **Enterprise tenants:** dedicated database, sometimes dedicated region

```javascript
function getDatabase(tenantId) {
    const tier = getTenantTier(tenantId);

    switch (tier) {
        case 'enterprise':
            return dedicatedDatabases[tenantId];
        case 'business':
            return shardPools[getShard(tenantId)];
        default:
            return sharedPool; // RLS handles isolation
    }
}
```

The routing layer is the complexity. Invest in tooling that provisions, migrates, and monitors tenant infrastructure automatically. Manual database provisioning doesn't scale past fifty enterprise customers.

## Performance and Noisy Neighbors

Isolation isn't just about data leaks. One tenant running a heavy analytics query can slow everyone on a shared database.

**Mitigations I've used:**

- **Read replicas** for reporting queries — analytics workloads don't touch the primary
- **Query timeouts** per tenant tier — free tier gets 5s, enterprise gets 60s
- **Connection pool limits** per tenant — prevents one tenant from exhausting the pool
- **Rate limiting** at the API layer — catches abuse before it hits the database

The project that taught me this: a tenant imported 2 million rows via CSV on a Friday afternoon and degraded API response times for everyone over the weekend. We added async import queues and moved bulk operations to background workers with dedicated resources.

## Compliance and Data Residency

If you sell to EU customers post-GDPR, or healthcare customers under HIPAA, your isolation strategy isn't just engineering — it's legal.

- **Data residency:** separate databases in required regions. Shared schema with a `region` column is not sufficient for strict interpretations.
- **Right to deletion:** easier with separate schemas/databases (drop schema vs. cascading deletes across shared tables)
- **Audit trails:** log every cross-tenant admin action. "Super admin viewed tenant X's data" must be in immutable audit logs.

Talk to your legal/compliance team before choosing shared schema for regulated data. Engineering convenience doesn't override contractual obligations.

## Practical Takeaways

Multi-tenant isolation is a spectrum, not a checkbox. The right strategy depends on tenant count, compliance requirements, team capacity, and how much an isolation failure costs your business.

For us, that cost was $47,000 in misattributed revenue, three angry customers, two weeks of audit, and a quarter of engineering time rebuilding guardrails we should have built at the start.

**If you're starting today:**

1. Use shared schema if you must, but enable PostgreSQL RLS immediately
2. Set tenant context in middleware, not in individual queries
3. Write cross-tenant isolation tests for every data endpoint
4. Audit queries in CI for missing tenant filters
5. Plan your migration path to stronger isolation before enterprise sales demands it

**If you're fixing an existing system:**

1. Enable RLS first — highest impact, lowest risk
2. Add isolation tests — map your blast radius
3. Audit existing queries — assume there are bugs until proven otherwise
4. Migrate enterprise tenants to dedicated infrastructure when contracts require it

The `WHERE tenant_id = ?` clause is necessary but not sufficient. Real isolation is a system property — enforced by the database, validated by tests, and reviewed in every PR that touches tenant data.

---

*Multi-tenant isolation strategies — May 2023. Architecture choices depend on your compliance requirements, tenant count, and risk tolerance.*

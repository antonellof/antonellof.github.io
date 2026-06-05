---
layout: post
title: "MySQL vs PostgreSQL: Choosing the Right Database"
date: 2016-08-05
categories: [Comparison]
tags: [MySQL, PostgreSQL, Database, Comparison]
excerpt: "The database holy war, defused — an honest MySQL vs PostgreSQL comparison from someone who's debugged production issues on both sides."
---

Every new project eventually hits the same Slack thread: "MySQL or PostgreSQL?" Someone links a benchmark from 2012. Someone else says they've "always used MySQL." A third person mentions JSON support and the thread goes quiet for six hours.

I've run both in production — MySQL for a read-heavy CMS that needed to survive traffic spikes, PostgreSQL for a financial reporting system where a bad join could embarrass us in front of auditors. Neither database is universally better. They're better at different things, and pretending otherwise is how you pick the wrong one and spend six months rationalizing the choice.

Here's an honest comparison from mid-2016, when MySQL 5.7 and PostgreSQL 9.5 were the versions you'd actually deploy.

## Quick Comparison

| Feature | MySQL | PostgreSQL |
|---------|-------|------------|
| License | GPL/Commercial | PostgreSQL License (BSD-like) |
| ACID Compliance | Yes (InnoDB) | Yes |
| JSON Support | 5.7+ | 9.2+ (Better) |
| Full-Text Search | Basic | Advanced (tsvector) |
| Window Functions | 8.0+ | 9.0+ |
| Replication | Master-Slave | Streaming Replication |
| Performance | Fast reads | Complex queries |

That table oversimplifies everything, which is the problem with database comparisons in general. Let's get into the details that actually matter when you're choosing.

## Performance Characteristics

### MySQL Strengths

MySQL earned its reputation on simple, read-heavy workloads. When your queries look like "fetch row by indexed key" or "count rows matching a status," MySQL is hard to beat:

```sql
-- MySQL handles simple queries very well
SELECT * FROM users WHERE email = 'user@example.com';
-- Uses index efficiently, very fast

-- Simple aggregations
SELECT COUNT(*) FROM orders WHERE status = 'completed';
-- Optimized for this pattern
```

Connection handling under high concurrency is another MySQL strength. Thousands of simple concurrent reads? MySQL has been optimized for this pattern for years. Replication for read scaling is well-understood and widely deployed.

Where MySQL struggles: complex analytical queries with multiple joins, window functions (pre-8.0), and anything requiring sophisticated query planning. It's not that MySQL can't do these things — it's that PostgreSQL's planner was built for them.

### PostgreSQL Strengths

PostgreSQL shines when queries get interesting — CTEs, window functions, complex joins, subqueries that would make a lesser planner cry:

```sql
-- PostgreSQL handles complex queries better
WITH user_stats AS (
    SELECT 
        u.id,
        COUNT(o.id) as order_count,
        SUM(o.total) as total_spent,
        AVG(o.total) as avg_order_value
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.created_at > '2016-01-01'
    GROUP BY u.id
)
SELECT 
    u.*,
    us.order_count,
    us.total_spent,
    us.avg_order_value,
    CASE 
        WHEN us.total_spent > 1000 THEN 'VIP'
        WHEN us.total_spent > 500 THEN 'Premium'
        ELSE 'Standard'
    END as customer_tier
FROM users u
JOIN user_stats us ON u.id = us.id
ORDER BY us.total_spent DESC;
-- PostgreSQL's query planner optimizes this better
```

The query planner is genuinely sophisticated. PostgreSQL will try multiple strategies, use statistics aggressively, and handle complex data types natively. The tradeoff: simple point lookups aren't dramatically faster than MySQL, and you pay for that sophistication in operational complexity.

## Feature Comparison

### JSON Support

Both databases added JSON around the same era, but the implementations diverged significantly.

**MySQL 5.7+ JSON:**

```sql
-- MySQL JSON
CREATE TABLE products (
    id INT PRIMARY KEY,
    name VARCHAR(255),
    attributes JSON
);

INSERT INTO products VALUES (
    1,
    'Laptop',
    '{"brand": "Dell", "ram": "16GB", "storage": "512GB"}'
);

-- Query JSON
SELECT * FROM products 
WHERE JSON_EXTRACT(attributes, '$.ram') = '16GB';

-- Index JSON
ALTER TABLE products 
ADD INDEX idx_ram ((CAST(attributes->>'$.ram' AS CHAR(10))));
```

Functional but clunky. JSON in MySQL 5.7 felt bolted on — because it was.

**PostgreSQL JSONB:**

```sql
-- PostgreSQL JSONB (more efficient)
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    attributes JSONB
);

INSERT INTO products VALUES (
    1,
    'Laptop',
    '{"brand": "Dell", "ram": "16GB", "storage": "512GB"}'::jsonb
);

-- Query JSONB (more powerful)
SELECT * FROM products 
WHERE attributes @> '{"ram": "16GB"}';

-- Index JSONB (GIN index)
CREATE INDEX idx_attributes ON products USING GIN (attributes);

-- Advanced queries
SELECT * FROM products 
WHERE attributes ? 'ram'  -- Key exists
AND attributes->>'brand' = 'Dell';
```

JSONB stores data in a decomposed binary format — faster queries, better indexing, richer operators. If your application stores significant JSON, PostgreSQL wins here without debate.

### Full-Text Search

**MySQL Full-Text:**

```sql
-- MySQL full-text search
ALTER TABLE articles ADD FULLTEXT(title, content);

SELECT * FROM articles 
WHERE MATCH(title, content) AGAINST('database performance' IN NATURAL LANGUAGE MODE);
```

Works for basic search. Limited ranking, limited language support, no phrase queries worth mentioning.

**PostgreSQL Full-Text:**

```sql
-- PostgreSQL full-text search (more powerful)
ALTER TABLE articles ADD COLUMN search_vector tsvector;

CREATE INDEX idx_search ON articles USING GIN(search_vector);

-- Update search vector
UPDATE articles SET search_vector = 
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''));

-- Search with ranking
SELECT 
    title,
    ts_rank(search_vector, query) AS rank
FROM articles, to_tsquery('english', 'database & performance') query
WHERE search_vector @@ query
ORDER BY rank DESC;
```

`tsvector`/`tsquery` with GIN indexes, ranking, stemming, and language-aware tokenization. You can build real search without Elasticsearch for moderate scale. PostgreSQL wins again.

### Data Integrity

This is where opinions get loud, so let's be specific.

PostgreSQL enforces constraints aggressively — foreign keys, check constraints, exclusion constraints, custom types. It will reject bad data at the database layer, which is exactly what you want when correctness matters more than convenience.

MySQL (with InnoDB) supports foreign keys and transactions, but historically was more permissive about edge cases — silent truncation, implicit type coercion, the infamous "zero date" problem. MySQL 5.7 tightened strict mode defaults, which helped, but PostgreSQL still feels stricter by design.

For a blog CMS? Either works. For anything involving money, inventory, or audit trails? PostgreSQL's rigor is a feature, not pedantry.

## Replication and Operations

**MySQL replication** in 2016 meant master-slave async replication. Well-documented, widely deployed, understood by every hosting provider. Read replicas scale reads; failover requires tooling (MHA, Orchestrator, or managed services).

**PostgreSQL streaming replication** offered synchronous options, logical replication (in later versions), and hot standby. More flexible, slightly more complex to operate yourself. Managed PostgreSQL (RDS, Heroku, etc.) closed much of this gap.

Neither is "easier" universally — it depends on your team's experience and whether you're self-hosting or using managed services.

## Use Case Recommendations

### Choose MySQL When

Your application is straightforward — blog, CMS, simple e-commerce, read-heavy CRUD. Your team knows MySQL. Your hosting provider optimizes for it. Your queries are simple indexed lookups and basic aggregations.

MySQL isn't the "beginner database." It's the right tool when your workload matches what it's optimized for.

### Choose PostgreSQL When

You need complex reporting, analytics, or queries that join five tables and aggregate across time windows. Data integrity is non-negotiable. You're storing JSON, doing full-text search, or using advanced types (arrays, hstore, geometric). Your team values SQL standards compliance.

PostgreSQL isn't the "serious database." It's the right tool when your data model and query patterns demand a sophisticated planner.

## Migration Considerations

Switching databases mid-project is painful regardless of direction. A few realities:

- **ORM abstractions lie.** Laravel Eloquent, Django ORM, and Sequelize hide dialect differences until they don't. Raw SQL, date handling, and JSON operators diverge.
- **Schema migrations differ.** Auto-increment vs. serial, boolean types, timestamp precision — small differences compound.
- **Query rewrites take time.** That complex report that PostgreSQL handles natively may need restructuring for MySQL, and vice versa.

If you're choosing for a greenfield project, pick based on projected complexity, not current team comfort alone. Learning PostgreSQL is easier than migrating to it later.

## Hosting and Ecosystem Reality

In 2016, the "which database" decision wasn't purely technical — it was also about what your hosting environment made painless.

**MySQL** was the default everywhere. Shared hosting, managed WordPress, cheap VPS templates, every Laravel tutorial — MySQL was the path of least resistance. If your team deployed to a typical LAMP stack provider, MySQL support was guaranteed. Replication guides were abundant. DBAs for hire knew MySQL cold.

**PostgreSQL** had caught up on managed services (RDS, Heroku Postgres, DigitalOcean) but still felt like the choice you had to justify to stakeholders who'd only heard of MySQL. The tooling gap was closing — pgAdmin, PostGIS, and strong Rails/Django support helped — but MySQL's ubiquity in tutorials and job postings meant more developers arrived with MySQL muscle memory.

This matters for hiring and onboarding. A PostgreSQL shop hiring PHP developers who've only used MySQL will spend weeks on dialect surprises. A MySQL shop that later needs window functions and CTEs will spend months on query rewrites. Pick with your team's starting point in mind, but bias toward where the data model is heading, not where it is today.

## When We Picked Each (Real Projects)

**MySQL won** for a content-heavy publishing platform: simple CRUD, heavy read caching, straightforward replication to read replicas, team with years of MySQL experience. The most complex query was a tagged article listing. PostgreSQL would have worked fine; MySQL was the faster path to production.

**PostgreSQL won** for a subscription billing system: complex reporting (MRR, churn cohorts, revenue recognition), strict constraints on financial data, JSONB for flexible plan metadata, and full-text search on support tickets without adding Elasticsearch. MySQL could have handled the CRUD; PostgreSQL handled the reporting without bolting on a warehouse prematurely.

Neither choice was ideological. Both were workload fits.

## The Uncomfortable Truth

Most applications in 2016 didn't need either database's advanced features. A well-indexed MySQL instance and a well-indexed PostgreSQL instance would both serve a typical SaaS app fine. The choice matters more as complexity grows — and complexity always grows.

I've seen teams pick MySQL because "it's faster" and then struggle with reporting queries that PostgreSQL would handle natively. I've seen teams pick PostgreSQL because "it's more correct" and then over-engineer a simple CRUD app that MySQL would serve effortlessly.

The best database is the one your team can operate confidently for your actual workload.

## Wrapping Up

**MySQL** when you have simple, read-heavy workloads, a team that knows it, and queries that stay simple.

**PostgreSQL** when you need complex queries, strong data integrity, advanced types, or JSON/full-text search without bolting on another system.

Both are excellent, mature, production-proven databases. The holy war is mostly tribal. The engineering decision is workload-specific.

Pick based on what your application will ask of the database in two years, not what Twitter argued about last week.

---

*Comparison based on MySQL 5.7 and PostgreSQL 9.5, reflecting the state of both databases in mid-2016. Both have evolved significantly since — MySQL 8.0 added window functions and better JSON; PostgreSQL 10+ improved partitioning and replication — but the fundamental tradeoffs remain.*

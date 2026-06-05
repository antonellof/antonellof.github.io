---
layout: post
title: "PostgreSQL Performance Tuning: Advanced Techniques"
date: 2021-08-18
categories: [How-To]
tags: [PostgreSQL, Performance, Database]
excerpt: "Our API was 'slow.' PostgreSQL wasn't broken—we were asking it stupid questions. EXPLAIN ANALYZE, strategic indexes, and config tuning turned 2-second queries into 20ms without upgrading hardware."
---

The API was slow. Engineering wanted a bigger database instance. $2,400/month more on AWS RDS.

I ran `EXPLAIN ANALYZE` first. Three queries accounted for 80% of database time. One was missing an index. One was an N+1 pattern the ORM hid. One was scanning 4 million rows to return 10. Total fix time: four hours. Monthly savings: $2,400.

PostgreSQL is rarely the bottleneck. **Bad queries** are the bottleneck. Performance tuning isn't magic configuration—it's understanding what your database is actually doing and stopping the worst offenses.

Here's the systematic approach I use before anyone talks about bigger instances.

## Step 1: Find the Slow Queries

Enable `pg_stat_statements`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT
    query,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    round(mean_exec_time::numeric, 2) AS mean_ms,
    round(max_exec_time::numeric, 2) AS max_ms,
    rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

`total_exec_time` finds queries consuming the most aggregate time. A query running 5ms but called 1M times/day beats a 5-second query called once.

Reset stats after changes to measure improvement:

```sql
SELECT pg_stat_statements_reset();
```

## Step 2: EXPLAIN ANALYZE Everything

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT u.name, o.total
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.created_at > '2021-01-01'
ORDER BY o.total DESC
LIMIT 10;
```

Look for:
- **Seq Scan** on large tables → missing index
- **Nested Loop** with high row counts → join strategy problem
- **Sort** with high cost → missing index for ORDER BY
- **Buffers: shared hit/read** → cache effectiveness

```
Limit  (cost=0.85..145.32 rows=10 width=45) (actual time=0.045..0.312 rows=10 loops=1)
  ->  Nested Loop  (cost=0.85..14532.00 rows=1000 width=45) (actual time=0.043..0.298 rows=10 loops=1)
        ->  Index Scan using idx_users_created_at on users u  (cost=0.43..2341.00 rows=5000 width=20)
              Index Cond: (created_at > '2021-01-01'::date)
        ->  Index Scan using idx_orders_user_id on orders o  (cost=0.42..2.20 rows=3 width=29)
              Index Cond: (user_id = u.id)
Planning Time: 0.234 ms
Execution Time: 0.345 ms
```

Index scans, sub-millisecond execution. That's the goal.

## Index Strategy: Not More Indexes, Right Indexes

### B-tree (Default)

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_orders_user_id ON orders(user_id);
```

Equality and range queries. Covers `=`, `<`, `>`, `BETWEEN`, `ORDER BY`.

### Composite Indexes (Column Order Matters)

```sql
-- For: WHERE user_id = ? ORDER BY created_at DESC
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at DESC);
```

Leftmost column first. `(user_id, created_at)` helps `WHERE user_id = 5` but not `WHERE created_at > '2021-01-01'` alone.

### Partial Indexes (Smaller, Faster)

```sql
-- Only index active users — index is 10% the size
CREATE INDEX idx_active_users_email ON users(email) 
WHERE status = 'active';
```

When queries always filter on the same condition, partial indexes are dramatically smaller and faster.

### Covering Indexes (Index-Only Scans)

```sql
CREATE INDEX idx_users_covering ON users(id) INCLUDE (name, email);
```

Query needs only indexed columns? PostgreSQL reads the index without touching the table.

### Find Unused Indexes

```sql
SELECT
    schemaname || '.' || relname AS table,
    indexrelname AS index,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE contype IN ('p', 'u'));
```

Unused indexes slow writes and waste storage. We dropped 12 unused indexes and write latency dropped 15%.

## Query Patterns: Fix the SQL

### N+1: The ORM's Gift

```sql
-- Bad: 1 + N queries
SELECT * FROM users WHERE id = 1;
SELECT * FROM orders WHERE user_id = 1;
SELECT * FROM orders WHERE user_id = 2;
-- ... 100 more

-- Good: 1 query
SELECT u.*, o.*
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.id = ANY($1);
```

Enable query logging temporarily to catch ORM N+1:

```sql
SET log_min_duration_statement = 100;  -- Log queries > 100ms
```

### EXISTS vs COUNT

```sql
-- Bad: scans all matching rows
SELECT COUNT(*) > 0 FROM orders WHERE user_id = 1;

-- Good: stops at first match
SELECT EXISTS(SELECT 1 FROM orders WHERE user_id = 1);
```

### Pagination Without OFFSET Pain

```sql
-- Bad for page 10000: scans and discards 200,000 rows
SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 200000;

-- Good: cursor-based
SELECT * FROM orders WHERE id > $last_seen_id ORDER BY id LIMIT 20;
```

## Configuration Tuning

Defaults are conservative. Tune for your hardware and workload.

```sql
-- Memory (on 16GB RAM instance)
shared_buffers = 4GB              -- 25% of RAM
effective_cache_size = 12GB       -- 75% of RAM (OS + PG cache)
work_mem = 64MB                   -- Per sort/hash operation
maintenance_work_mem = 1GB        -- VACUUM, CREATE INDEX

-- Connections
max_connections = 200             -- Lower than you think; use pooling

-- WAL
wal_buffers = 64MB
checkpoint_completion_target = 0.9

-- Query planner
random_page_cost = 1.1            -- For SSD storage (default 4.0 is HDD-era)
effective_io_concurrency = 200    -- SSD parallelism
```

**Use connection pooling.** PgBouncer or RDS Proxy. 500 application connections → 50 database connections. PostgreSQL spends memory per connection (~10MB each).

## Partitioning Large Tables

When tables exceed 50-100M rows, queries slow even with indexes:

```sql
CREATE TABLE orders (
    id BIGSERIAL,
    user_id INTEGER,
    total DECIMAL,
    created_at TIMESTAMP NOT NULL
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2024_q1 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');

CREATE TABLE orders_2024_q2 PARTITION OF orders
    FOR VALUES FROM ('2024-04-01') TO ('2024-07-01');
```

Queries filtering by `created_at` scan only relevant partitions. Old partitions can be archived or dropped.

## Maintenance: The Unglamorous Essential

```sql
-- Check table bloat
SELECT
    schemaname, relname,
    n_live_tup, n_dead_tup,
    last_vacuum, last_autovacuum,
    last_analyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

Dead tuples accumulate from UPDATE/DELETE. Autovacuum cleans them. If autovacuum can't keep up, queries slow down.

```sql
-- Manual vacuum for heavily updated tables
VACUUM (ANALYZE) orders;

-- Reindex if bloated
REINDEX INDEX CONCURRENTLY idx_orders_user_id;
```

## Monitoring Checklist

- **Query latency p95/p99** — not just mean
- **Cache hit ratio** — `blks_hit / (blks_hit + blks_read)` should be > 99%
- **Connection count** — approaching max_connections?
- **Replication lag** — if using replicas
- **Disk I/O** — IOPS saturation?
- **Autovacuum activity** — dead tuples accumulating?

## The Tuning Order

1. **Find slow queries** (pg_stat_statements)
2. **EXPLAIN ANALYZE** the worst offenders
3. **Fix query patterns** (N+1, unnecessary columns, bad joins)
4. **Add indexes** (strategic, not speculative)
5. **Configure memory** (shared_buffers, work_mem)
6. **Add connection pooling**
7. **Partition** if tables are huge
8. **Upgrade hardware** — only after 1-7

Most teams jump to step 8. Don't.

## Conclusion

Our "slow API" didn't need a bigger database. It needed three indexes, one JOIN instead of N+1 queries, and connection pooling. Four hours of work. $2,400/month saved. Sub-50ms p95 queries.

PostgreSQL is extraordinarily capable out of the box. Performance problems are almost always query problems—missing indexes, bad patterns, or configuration defaults designed for 512MB RAM circa 2005.

Run EXPLAIN ANALYZE. Fix the top three queries. Measure. Repeat. Save the instance upgrade for when you've actually exhausted query optimization.

The database isn't slow. The questions you're asking it might be.

---

*PostgreSQL performance tuning from August 2021, covering advanced optimization techniques.*

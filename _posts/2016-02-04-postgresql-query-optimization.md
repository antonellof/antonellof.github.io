---
layout: post
title: "PostgreSQL Query Optimization: A Practical Guide"
date: 2016-02-04
categories: [Deep Dive]
tags: [PostgreSQL, Database, Performance, Optimization]
excerpt: "How I turned a 30-second dashboard query into a 300ms one — EXPLAIN ANALYZE, indexes that actually help, and the anti-patterns that keep PostgreSQL guessing."
---

The dashboard timed out every Monday morning. Not because traffic spiked — because someone ran a report that joined three tables, grouped by a dozen columns, and filtered on a function-wrapped date field. PostgreSQL did exactly what we asked. It just took 30 seconds to do it.

I spent a week living inside `EXPLAIN ANALYZE` output, and what I learned wasn't magic. PostgreSQL isn't slow; it's honest. It tells you exactly how it plans to suffer through your query. Your job is to stop making it suffer.

This is the playbook I used to turn 30-second queries into sub-second responses — and the mistakes I kept making until I understood how the planner thinks.

## Understanding EXPLAIN

`EXPLAIN` is the single most useful tool in your optimization toolkit. `EXPLAIN ANALYZE` runs the query and shows you what actually happened, not just what the planner guessed:

```sql
EXPLAIN ANALYZE
SELECT u.name, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.created_at > '2016-01-01'
GROUP BY u.id, u.name
ORDER BY order_count DESC
LIMIT 10;
```

Typical output:

```
Limit  (cost=1234.56..1234.58 rows=10 width=48) (actual time=45.123..45.125 rows=10 loops=1)
  ->  Sort  (cost=1234.56..1289.12 rows=21824 width=48) (actual time=45.121..45.122 rows=10 loops=1)
        Sort Key: (count(o.id)) DESC
        Sort Method: top-N heapsort  Memory: 25kB
        ->  HashAggregate  (cost=789.45..890.23 rows=21824 width=48) (actual time=42.345..43.678 rows=15000 loops=1)
              Group Key: u.id
              ->  Hash Left Join  (cost=234.12..678.90 rows=25000 width=40) (actual time=12.345..35.678 rows=25000 loops=1)
```

What to watch:

- **cost** — planner's estimate, not wall-clock time
- **rows** — estimated row count (when this is wildly wrong, your stats are stale)
- **actual time** — real milliseconds per node
- **loops** — how many times a node executed (nested loop × 50,000 rows = pain)

When estimated rows and actual rows diverge by orders of magnitude, don't reach for a new index first. Run `ANALYZE` on the table.

## Index Basics

Indexes aren't free — they speed reads and slow writes. The goal is putting them where the planner actually needs them.

### B-tree Index (Default)

Equality and range queries:

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
```

Composite index column order matters. Put the most selective column first, or match your `WHERE` clause left-to-right.

### Partial Index

Index only the rows you actually query:

```sql
-- Only index active users
CREATE INDEX idx_active_users ON users(email) WHERE status = 'active';

-- Only index recent orders
CREATE INDEX idx_recent_orders ON orders(created_at) 
WHERE created_at > '2015-01-01';
```

Smaller index, faster scans, less write overhead. I use partial indexes more than I expected once I started looking at real query patterns.

### GIN Index

Full-text search and JSONB:

```sql
-- Full-text search
CREATE INDEX idx_posts_content_gin ON posts USING GIN(to_tsvector('english', content));

-- JSONB columns
CREATE INDEX idx_user_preferences ON users USING GIN(preferences);
```

### GiST Index

Geometric data and some full-text cases:

```sql
CREATE INDEX idx_locations ON stores USING GIST(location);
```

## Common Query Anti-patterns

These are the patterns I see in slow-query logs over and over.

### N+1 Query Problem

**Bad:**

```sql
-- First query
SELECT * FROM posts WHERE author_id = 123;

-- Then for each post (N queries)
SELECT * FROM comments WHERE post_id = ?;
```

**Good:**

```sql
-- Single query with JOIN
SELECT p.*, c.*
FROM posts p
LEFT JOIN comments c ON p.id = c.post_id
WHERE p.author_id = 123;
```

ORMs make N+1 embarrassingly easy. If your log shows the same query with different IDs thousands of times, you found it.

### SELECT * Instead of Specific Columns

**Bad:**

```sql
SELECT * FROM users WHERE email = 'john@example.com';
```

**Good:**

```sql
SELECT id, name, email FROM users WHERE email = 'john@example.com';
```

Narrower selects enable covering indexes and reduce I/O. Your `users` table has 40 columns you don't need for this lookup.

### Function Calls in WHERE Clause

**Bad:**

```sql
SELECT * FROM users WHERE LOWER(email) = 'john@example.com';
```

The planner can't use a plain index on `email` here. **Good:**

```sql
-- Create functional index
CREATE INDEX idx_users_email_lower ON users(LOWER(email));

-- Or store data in lowercase
SELECT * FROM users WHERE email = lower('john@example.com');
```

### OR Conditions Across Different Columns

**Bad:**

```sql
SELECT * FROM orders 
WHERE user_id = 123 OR created_at > '2016-01-01';
```

The planner often gives up and sequential-scans. **Good:**

```sql
-- Use UNION when indexes exist on both columns
SELECT * FROM orders WHERE user_id = 123
UNION
SELECT * FROM orders WHERE created_at > '2016-01-01';
```

## Optimizing JOINs

JOIN type choice matters. `EXISTS` often beats `IN` for correlated subqueries:

```sql
-- INNER JOIN: Only matching rows
SELECT o.*, u.name
FROM orders o
INNER JOIN users u ON o.user_id = u.id;

-- LEFT JOIN: All rows from left table
SELECT u.*, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id;

-- EXISTS: More efficient than IN for subqueries
SELECT * FROM users u
WHERE EXISTS (
    SELECT 1 FROM orders o 
    WHERE o.user_id = u.id AND o.status = 'completed'
);
```

Always index foreign keys. This sounds obvious. Check your schema anyway — you'll find at least one missing index:

```sql
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
```

## Window Functions for Complex Queries

Window functions can replace expensive correlated subqueries:

**Bad:**

```sql
SELECT u.*, 
    (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders,
    (SELECT SUM(amount) FROM orders WHERE user_id = u.id) as total_spent
FROM users u;
```

**Good:**

```sql
SELECT u.*, 
    COUNT(o.id) OVER (PARTITION BY u.id) as total_orders,
    SUM(o.amount) OVER (PARTITION BY u.id) as total_spent
FROM users u
LEFT JOIN orders o ON u.id = o.user_id;
```

## Analyzing Query Performance

### Check Index Usage

Find indexes that never get touched — candidates for removal:

```sql
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC;
```

### Find Slow Queries

Enable slow query logging in `postgresql.conf`:

```conf
log_min_duration_statement = 1000  # Log queries taking > 1 second
log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
log_statement = 'all'
```

### Table Statistics

Stale statistics make the planner confidently wrong:

```sql
-- Manual analyze
ANALYZE users;

-- Vacuum and analyze
VACUUM ANALYZE orders;

-- Auto-vacuum settings in postgresql.conf
autovacuum = on
autovacuum_vacuum_scale_factor = 0.2
autovacuum_analyze_scale_factor = 0.1
```

## Practical Optimization Example

A real query from that Monday morning dashboard:

**Original (30 seconds):**

```sql
SELECT 
    u.name,
    u.email,
    COUNT(o.id) as order_count,
    SUM(o.total) as total_spent
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.created_at > '2015-01-01'
AND (u.subscription_status = 'active' OR o.status = 'completed')
GROUP BY u.id, u.name, u.email
HAVING COUNT(o.id) > 10
ORDER BY total_spent DESC;
```

`EXPLAIN ANALYZE` told the story:

1. No index on `users.created_at`
2. OR condition blocking index usage
3. Sequential scan on a table that had outgrown sequential scans

**Optimized (0.3 seconds):**

```sql
-- Add indexes
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE INDEX idx_users_subscription_status ON users(subscription_status);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);

-- Rewrite query
WITH active_users AS (
    SELECT id, name, email
    FROM users
    WHERE created_at > '2015-01-01'
    AND subscription_status = 'active'
),
completed_orders AS (
    SELECT user_id, COUNT(*) as order_count, SUM(total) as total_spent
    FROM orders
    WHERE status = 'completed'
    GROUP BY user_id
    HAVING COUNT(*) > 10
)
SELECT 
    au.name,
    au.email,
    COALESCE(co.order_count, 0) as order_count,
    COALESCE(co.total_spent, 0) as total_spent
FROM active_users au
LEFT JOIN completed_orders co ON au.id = co.user_id
ORDER BY total_spent DESC;
```

Splitting the OR into CTEs let each subquery use its own index. The rewrite took an afternoon. The dashboard has been fine on Mondays since.

## Configuration Tuning

Defaults assume a small shared server. Tune for your hardware:

```conf
# Memory Settings
shared_buffers = 256MB              # 25% of RAM
effective_cache_size = 1GB          # 50-75% of RAM
work_mem = 16MB                     # Per operation
maintenance_work_mem = 128MB        # For VACUUM, CREATE INDEX

# Query Planning
random_page_cost = 1.1              # Lower for SSD
effective_io_concurrency = 200      # Higher for SSD

# WAL Settings
wal_buffers = 16MB
checkpoint_completion_target = 0.9
```

Don't copy these numbers blindly. A 4GB VPS and a 64GB dedicated box want different values.

## Monitoring Tools

Queries I still run in production:

```sql
-- Current active queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query 
FROM pg_stat_activity 
WHERE state = 'active' 
ORDER BY duration DESC;

-- Table sizes
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Index hit ratio (should be > 95%)
SELECT 
    sum(idx_blks_hit) / (sum(idx_blks_hit) + sum(idx_blks_read)) AS index_hit_ratio
FROM pg_statio_user_indexes;
```

An index hit ratio below 95% usually means missing indexes or queries that can't use the ones you have.

## Wrapping Up

PostgreSQL optimization is iterative, not heroic. Start with `EXPLAIN ANALYZE`, fix the obvious anti-patterns, add indexes that match real query shapes, keep statistics fresh, and tune configuration for your hardware.

The difference between a 30-second query and a 300ms one is rarely a single clever trick. It's usually understanding what the planner sees — and stopping asking it to scan a million rows when an index would do.

---

*Performance tips based on PostgreSQL 9.5 features available in early 2016. Modern PostgreSQL has improved parallel query, better JSONB indexing, and smarter planners — but EXPLAIN never goes out of style.*

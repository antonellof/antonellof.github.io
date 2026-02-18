---
layout: post
title: "PostgreSQL Query Optimization: A Practical Guide"
date: 2016-02-04
categories: [Deep Dive]
tags: [PostgreSQL, Database, Performance, Optimization]
excerpt: "Learn how to identify and fix slow PostgreSQL queries using EXPLAIN, indexes, and query planning techniques. Real-world examples and performance improvements."
---

After spending countless hours optimizing database queries in production, I've learned that PostgreSQL performance isn't magic—it's about understanding how the database thinks. Let me share practical techniques that have helped me turn 30-second queries into sub-second responses.

## Understanding EXPLAIN

The `EXPLAIN` command is your best friend for query optimization. It shows you how PostgreSQL plans to execute your query:

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

Output breakdown:
```
Limit  (cost=1234.56..1234.58 rows=10 width=48) (actual time=45.123..45.125 rows=10 loops=1)
  ->  Sort  (cost=1234.56..1289.12 rows=21824 width=48) (actual time=45.121..45.122 rows=10 loops=1)
        Sort Key: (count(o.id)) DESC
        Sort Method: top-N heapsort  Memory: 25kB
        ->  HashAggregate  (cost=789.45..890.23 rows=21824 width=48) (actual time=42.345..43.678 rows=15000 loops=1)
              Group Key: u.id
              ->  Hash Left Join  (cost=234.12..678.90 rows=25000 width=40) (actual time=12.345..35.678 rows=25000 loops=1)
```

Key metrics to watch:
- **cost**: Estimated query cost (not real time)
- **rows**: Estimated number of rows
- **actual time**: Real execution time in milliseconds
- **loops**: Number of times a node was executed

## Index Basics

Indexes are crucial for query performance. Here's when to use each type:

### B-tree Index (Default)
Best for equality and range queries:

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
```

### Partial Index
Index only rows that match a condition:

```sql
-- Only index active users
CREATE INDEX idx_active_users ON users(email) WHERE status = 'active';

-- Only index recent orders
CREATE INDEX idx_recent_orders ON orders(created_at) 
WHERE created_at > '2015-01-01';
```

### GIN Index
For full-text search and JSONB:

```sql
-- Full-text search
CREATE INDEX idx_posts_content_gin ON posts USING GIN(to_tsvector('english', content));

-- JSONB columns
CREATE INDEX idx_user_preferences ON users USING GIN(preferences);
```

### GiST Index
For geometric and full-text search:

```sql
CREATE INDEX idx_locations ON stores USING GIST(location);
```

## Common Query Anti-patterns

### 1. N+1 Query Problem

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

### 2. SELECT * Instead of Specific Columns

**Bad:**
```sql
SELECT * FROM users WHERE email = 'john@example.com';
```

**Good:**
```sql
SELECT id, name, email FROM users WHERE email = 'john@example.com';
```

This allows PostgreSQL to use covering indexes and reduces I/O.

### 3. Function Calls in WHERE Clause

**Bad:**
```sql
SELECT * FROM users WHERE LOWER(email) = 'john@example.com';
```

This prevents index usage. **Good:**

```sql
-- Create functional index
CREATE INDEX idx_users_email_lower ON users(LOWER(email));

-- Or store data in lowercase
SELECT * FROM users WHERE email = lower('john@example.com');
```

### 4. OR Conditions Across Different Columns

**Bad:**
```sql
SELECT * FROM orders 
WHERE user_id = 123 OR created_at > '2016-01-01';
```

**Good:**
```sql
-- Use UNION when indexes exist on both columns
SELECT * FROM orders WHERE user_id = 123
UNION
SELECT * FROM orders WHERE created_at > '2016-01-01';
```

## Optimizing JOINs

### Use Appropriate JOIN Types

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

### Index Foreign Keys

Always index foreign key columns:

```sql
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
```

## Window Functions for Complex Queries

Window functions can replace inefficient subqueries:

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

```sql
-- See which indexes are being used
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

Keep statistics up to date:

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

Let's optimize a real-world query:

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

Problems identified by EXPLAIN:
1. No index on `users.created_at`
2. OR condition prevents index usage
3. Sequential scan on large table

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

## Configuration Tuning

Key PostgreSQL parameters for performance:

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

## Monitoring Tools

Use these tools to monitor performance:

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

## Conclusion

PostgreSQL query optimization is an iterative process:
1. Identify slow queries using EXPLAIN ANALYZE
2. Add appropriate indexes
3. Rewrite queries to use indexes effectively
4. Monitor and tune configuration
5. Keep statistics up to date

The difference between a slow and fast query often comes down to proper indexing and understanding how PostgreSQL's query planner works. Start with EXPLAIN, be patient, and the performance improvements will come.

---

*Performance tips are based on PostgreSQL 9.5 features available in early 2016.*

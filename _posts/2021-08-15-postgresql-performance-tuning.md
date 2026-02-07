---
layout: post
title: "PostgreSQL Performance Tuning: Advanced Techniques"
date: 2021-08-15
categories: [How-To]
tags: [PostgreSQL, Performance, Database]
excerpt: "Optimize PostgreSQL performance: query optimization, index strategies, connection pooling, configuration tuning, and monitoring for high-performance databases."
---

PostgreSQL performance tuning requires understanding the database. After optimizing production databases, here are advanced techniques.

## Query Optimization

### EXPLAIN ANALYZE

```sql
EXPLAIN ANALYZE
SELECT u.name, o.total
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.created_at > '2021-01-01'
ORDER BY o.total DESC
LIMIT 10;
```

### Index Strategies

```sql
-- B-tree index (default)
CREATE INDEX idx_users_email ON users(email);

-- Partial index
CREATE INDEX idx_active_users ON users(email) 
WHERE status = 'active';

-- Composite index
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at);

-- Covering index
CREATE INDEX idx_users_covering ON users(id, name, email);
```

## Configuration Tuning

### Memory Settings

```sql
-- shared_buffers: 25% of RAM
shared_buffers = 4GB

-- effective_cache_size: 50-75% of RAM
effective_cache_size = 12GB

-- work_mem: Per operation
work_mem = 64MB

-- maintenance_work_mem: For maintenance
maintenance_work_mem = 1GB
```

### Connection Settings

```sql
-- max_connections
max_connections = 200

-- Connection pooling recommended
-- Use pgBouncer or PgPool
```

## Index Optimization

### Analyze Index Usage

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

### Unused Indexes

```sql
SELECT
    schemaname || '.' || tablename AS table,
    indexname AS index,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
AND indexrelid NOT IN (
    SELECT conindid FROM pg_constraint
);
```

## Query Patterns

### Avoid N+1 Queries

```sql
-- Bad: N+1 queries
SELECT * FROM users WHERE id = 1;
SELECT * FROM orders WHERE user_id = 1;
SELECT * FROM orders WHERE user_id = 2;
-- ...

-- Good: Single query with JOIN
SELECT u.*, o.*
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.id IN (1, 2, 3, ...);
```

### Use EXISTS Instead of COUNT

```sql
-- Bad
SELECT COUNT(*) FROM orders WHERE user_id = 1;

-- Good
SELECT EXISTS(SELECT 1 FROM orders WHERE user_id = 1);
```

## Partitioning

### Range Partitioning

```sql
CREATE TABLE orders (
    id SERIAL,
    user_id INTEGER,
    total DECIMAL,
    created_at TIMESTAMP
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2021_q1 PARTITION OF orders
    FOR VALUES FROM ('2021-01-01') TO ('2021-04-01');

CREATE TABLE orders_2021_q2 PARTITION OF orders
    FOR VALUES FROM ('2021-04-01') TO ('2021-07-01');
```

## Monitoring

### Slow Queries

```sql
-- Enable pg_stat_statements
CREATE EXTENSION pg_stat_statements;

-- Find slow queries
SELECT
    query,
    calls,
    total_exec_time,
    mean_exec_time,
    max_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### Table Statistics

```sql
SELECT
    schemaname,
    tablename,
    n_live_tup,
    n_dead_tup,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

## Best Practices

1. **Analyze queries** - Use EXPLAIN ANALYZE
2. **Index strategically** - Based on queries
3. **Monitor performance** - Track metrics
4. **Vacuum regularly** - Maintain tables
5. **Tune configuration** - Based on workload
6. **Use connection pooling** - Manage connections
7. **Partition large tables** - Improve performance
8. **Review regularly** - Continuous optimization

## Conclusion

PostgreSQL performance tuning requires:
- Query optimization
- Strategic indexing
- Configuration tuning
- Continuous monitoring

Start with query analysis, then optimize indexes and configuration. The techniques shown here improve database performance.

---

*PostgreSQL performance tuning from August 2021, covering advanced optimization techniques.*

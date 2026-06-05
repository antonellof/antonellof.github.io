---
layout: post
title: "PostgreSQL Partitioning: Managing Large Tables"
date: 2022-06-03
categories: [How-To]
tags: [PostgreSQL, Partitioning, Database]
excerpt: "Our orders table hit 800 million rows and queries that used to take 50ms started taking 45 seconds. The index wasn't the problem—the table was. Partitioning turned a database crisis into a Tuesday afternoon migration."
---

There's a particular kind of dread that comes with watching a PostgreSQL query's EXPLAIN output. You see the index scan. You see the filter. And then you see `Rows Removed by Filter: 847,293,881` and realize your "optimized" query is scanning nearly a billion rows because the index can't save you when the table itself is the bottleneck.

That was our orders table. 800 million rows. Growing at 2 million per day. Queries by date range—our most common access pattern—were scanning the entire table because PostgreSQL had to check every row to find the ones in last week's date range, even with an index on `created_at`.

Vacuum was taking 6 hours. Backups were a negotiation with the infra team. Adding an index required planning a maintenance window that never seemed to arrive.

[Table partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) fixed what indexing couldn't. Instead of one massive table, we had dozens of smaller ones—queries touched only the partitions they needed, maintenance operated partition-by-partition, and old data dropped with a `DROP TABLE` instead of a `DELETE` that locked everything for hours.

## When Partitioning Makes Sense

Partitioning isn't free—it adds query planning complexity and requires thoughtful partition key selection. But it's the right tool when:

- **Table exceeds 100GB** and keeps growing
- **Queries consistently filter on a specific column** (date, region, tenant ID)
- **You need to drop old data regularly** (retention policies)
- **Maintenance windows can't keep up** with vacuum/analyze on the monolith
- **Different partitions have different access patterns** (hot recent data vs. cold archive)

If your queries don't filter on the partition key, partitioning makes things *worse*—PostgreSQL scans every partition. Don't partition for the sake of partitioning.

## Choosing a Partition Strategy

PostgreSQL supports three partitioning methods. Pick based on your query patterns:

| Method | Partition Key Example | Best For |
|--------|----------------------|----------|
| Range | Date, numeric ID ranges | Time-series, sequential data |
| List | Country code, status | Categorical with known values |
| Hash | User ID, UUID | Even distribution, no natural range |

Our orders table screamed **range partitioning by date**. Analytics queries always included date ranges. Retention policy dropped data older than 7 years. Range partitioning made both patterns natural.

## Range Partitioning: The Workhorse

Range partitioning divides data by contiguous ranges—most commonly time:

```sql
-- Parent table (doesn't store data directly)
CREATE TABLE orders (
    id          BIGSERIAL,
    user_id     INTEGER NOT NULL,
    total       DECIMAL(10,2) NOT NULL,
    status      VARCHAR(20) NOT NULL,
    created_at  TIMESTAMP NOT NULL,
    updated_at  TIMESTAMP NOT NULL
) PARTITION BY RANGE (created_at);

-- Create partitions (one per quarter)
CREATE TABLE orders_2022_q1 PARTITION OF orders
    FOR VALUES FROM ('2022-01-01') TO ('2022-04-01');

CREATE TABLE orders_2022_q2 PARTITION OF orders
    FOR VALUES FROM ('2022-04-01') TO ('2022-07-01');

CREATE TABLE orders_2022_q3 PARTITION OF orders
    FOR VALUES FROM ('2022-07-01') TO ('2022-10-01');

CREATE TABLE orders_2022_q4 PARTITION OF orders
    FOR VALUES FROM ('2022-10-01') TO ('2023-01-01');
```

Queries with date filters now hit only relevant partitions:

```sql
-- Only scans orders_2022_q2 — partition pruning in action
SELECT COUNT(*), SUM(total)
FROM orders
WHERE created_at >= '2022-04-01'
  AND created_at < '2022-07-01';
```

Verify partition pruning with EXPLAIN:

```sql
EXPLAIN SELECT * FROM orders WHERE created_at >= '2022-05-01';

-- Look for: "Partitions removed: 3" or specific partition names
-- Bad sign: scanning all partitions
```

### Automating Partition Creation

Don't create partitions manually forever. A scheduled job creates future partitions:

```sql
CREATE OR REPLACE FUNCTION create_orders_partition(partition_date DATE)
RETURNS void AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    start_date := date_trunc('quarter', partition_date);
    end_date := start_date + INTERVAL '3 months';
    partition_name := 'orders_' || to_char(start_date, 'YYYY_"q"Q');
    
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF orders
         FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date
    );
    
    RAISE NOTICE 'Created partition: %', partition_name;
END;
$$ LANGUAGE plpgsql;

-- Create next quarter's partition (run monthly via cron)
SELECT create_orders_partition(CURRENT_DATE + INTERVAL '3 months');
```

We run this on the first of each month, always staying one quarter ahead. Missing a partition means inserts fail—don't learn this the hard way.

### Dropping Old Data

This is where partitioning pays for itself. Seven-year retention policy?

```sql
-- Without partitioning: DELETE FROM orders WHERE created_at < '2015-01-01'
-- Locks table, generates massive WAL, takes hours

-- With partitioning:
DROP TABLE orders_2015_q1;
DROP TABLE orders_2015_q2;
-- Instant. Metadata operation. No WAL explosion.
```

We automated retention too:

```sql
CREATE OR REPLACE FUNCTION drop_old_orders_partitions(retention_years INTEGER DEFAULT 7)
RETURNS void AS $$
DECLARE
    partition_record RECORD;
    cutoff_date DATE;
BEGIN
    cutoff_date := date_trunc('quarter', CURRENT_DATE - (retention_years || ' years')::INTERVAL);
    
    FOR partition_record IN
        SELECT inhrelid::regclass AS partition_name
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        WHERE parent.relname = 'orders'
    LOOP
        -- Extract date from partition name and compare
        -- (Implementation depends on naming convention)
        IF partition_is_older_than(partition_record.partition_name, cutoff_date) THEN
            EXECUTE format('DROP TABLE %s', partition_record.partition_name);
            RAISE NOTICE 'Dropped old partition: %', partition_record.partition_name;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
```

## List Partitioning: Categorical Data

When data divides naturally by category, list partitioning works well:

```sql
CREATE TABLE events (
    id          BIGSERIAL,
    event_type  VARCHAR(50) NOT NULL,
    user_id     INTEGER,
    payload     JSONB,
    created_at  TIMESTAMP NOT NULL
) PARTITION BY LIST (event_type);

CREATE TABLE events_pageview PARTITION OF events
    FOR VALUES IN ('pageview', 'page_view');

CREATE TABLE events_click PARTITION OF events
    FOR VALUES IN ('click', 'button_click', 'link_click');

CREATE TABLE events_purchase PARTITION OF events
    FOR VALUES IN ('purchase', 'add_to_cart', 'checkout_start');

-- Catch-all for new event types
CREATE TABLE events_default PARTITION OF events DEFAULT;
```

The `DEFAULT` partition catches anything not explicitly listed—critical for avoiding insert failures when marketing invent new event types on Friday afternoon.

List partitioning shines for multi-tenant scenarios:

```sql
CREATE TABLE tenant_data (
    id          BIGSERIAL,
    tenant_id   VARCHAR(50) NOT NULL,
    data        JSONB,
    created_at  TIMESTAMP
) PARTITION BY LIST (tenant_id);

CREATE TABLE tenant_data_enterprise PARTITION OF tenant_data
    FOR VALUES IN ('acme-corp', 'bigco-inc', 'megacorp');

CREATE TABLE tenant_data_smb PARTITION OF tenant_data
    FOR VALUES IN ('startup-a', 'startup-b', 'startup-c');

CREATE TABLE tenant_data_default PARTITION OF tenant_data DEFAULT;
```

Enterprise tenants get dedicated partitions with tailored indexes. SMB tenants share a partition. Query isolation without separate databases.

## Hash Partitioning: Even Distribution

When there's no natural range or category, hash partitioning distributes data evenly:

```sql
CREATE TABLE user_sessions (
    id          BIGSERIAL,
    user_id     INTEGER NOT NULL,
    session_token VARCHAR(255),
    data        JSONB,
    expires_at  TIMESTAMP
) PARTITION BY HASH (user_id);

CREATE TABLE user_sessions_0 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 8, REMAINDER 0);

CREATE TABLE user_sessions_1 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 8, REMAINDER 1);

-- ... through user_sessions_7
```

Eight partitions, data distributed by `hash(user_id) % 8`. Queries filtering by `user_id` hit exactly one partition. Queries without `user_id` scan all eight—avoid those.

Hash partitioning helps with:
- Lock contention (writes spread across partitions)
- Parallel vacuum/analyze
- Index size (smaller indexes per partition)

It doesn't help with data retention—you can't drop a hash partition without dropping data across all time periods.

## Indexes on Partitioned Tables

Indexes work differently on partitioned tables. You can:

**Create indexes on the parent** (propagates to all partitions):

```sql
CREATE INDEX idx_orders_user_id ON orders (user_id);
-- Creates idx_orders_user_id on every partition automatically
```

**Create partition-specific indexes** when access patterns differ:

```sql
-- Recent partitions: index everything
CREATE INDEX idx_orders_2022_q4_status ON orders_2022_q4 (status);

-- Old partitions: maybe skip indexes that aren't queried
-- (Archive partitions are scan-only)
```

Our strategy: full indexes on partitions newer than 1 year, minimal indexes on archive partitions. Reduced index maintenance on data nobody queries with filters.

## Migrating an Existing Table

You can't just `ALTER TABLE ... PARTITION BY` on an existing 800-million-row table. Migration requires a cutover:

### Strategy 1: Create New, Copy, Swap

```sql
-- Step 1: Create partitioned table structure
CREATE TABLE orders_new (...) PARTITION BY RANGE (created_at);
-- Create all partitions

-- Step 2: Copy data in batches (avoid long locks)
INSERT INTO orders_new
SELECT * FROM orders
WHERE created_at >= '2022-01-01' AND created_at < '2022-04-01';

-- Repeat for each partition/date range

-- Step 3: Swap tables (brief lock)
BEGIN;
ALTER TABLE orders RENAME TO orders_old;
ALTER TABLE orders_new RENAME TO orders;
COMMIT;

-- Step 4: Verify, then drop old table
DROP TABLE orders_old;
```

### Strategy 2: Logical Replication

For zero-downtime migration, use logical replication:

1. Create partitioned table
2. Set up logical replication from old → new
3. Wait for sync
4. Brief cutover window to switch application
5. Drop old table

We used Strategy 1 with batched copies during low-traffic hours. Took a weekend, but the query performance improvement was immediate.

## Monitoring Partitioned Tables

New metrics to watch:

```sql
-- Partition sizes
SELECT
    child.relname AS partition_name,
    pg_size_pretty(pg_relation_size(child.oid)) AS size,
    pg_stat_get_live_tuples(child.oid) AS row_count
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON pg_inherits.inhrelid = child.oid
WHERE parent.relname = 'orders'
ORDER BY pg_relation_size(child.oid) DESC;

-- Verify partition pruning is working
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE created_at >= '2022-06-01';
-- Check "Partitions removed" in output

-- Find queries NOT using partition pruning (scanning all partitions)
SELECT query, calls, mean_time
FROM pg_stat_statements
WHERE query LIKE '%orders%'
ORDER BY mean_time DESC;
```

Alert when:
- A partition exceeds expected size (bad data distribution?)
- Partition count grows unexpectedly (automation failure?)
- Queries scan all partitions (missing partition key in WHERE?)

## Common Mistakes

**Wrong partition key.** We initially considered partitioning by `user_id`. But 90% of queries filtered by date. Partitioning by user_id would have meant scanning all partitions for every date-range query.

**Partitions too small.** One partition per day on moderate-volume data creates hundreds of partitions. PostgreSQL handles many partitions, but query planning overhead increases. Quarterly or monthly partitions are usually the sweet spot.

**Partitions too large.** One partition per year defeats the purpose. If your retention policy drops quarterly data and queries target months, quarterly partitions match both patterns.

**Forgetting the DEFAULT partition.** Inserts fail hard when no partition matches. Always have a DEFAULT or automated partition creation.

**No partition pruning verification.** Assumed partitioning was working. Discovered six months later that OR conditions in queries defeated pruning:

```sql
-- BAD: Partition pruning fails with OR
SELECT * FROM orders
WHERE created_at >= '2022-01-01' OR status = 'pending';

-- GOOD: UNION ALL preserves pruning
SELECT * FROM orders WHERE created_at >= '2022-01-01'
UNION ALL
SELECT * FROM orders WHERE status = 'pending' AND created_at >= '2022-01-01';
```

## Results After Partitioning

Our numbers after migrating the orders table:

| Metric | Before | After |
|--------|--------|-------|
| Date-range query p99 | 45s | 120ms |
| Vacuum duration | 6 hours | 20 min/partition |
| Data retention drop | 4-hour DELETE | Instant DROP |
| Backup size (incremental) | Full table scan | Changed partitions only |
| Index rebuild | Maintenance window | Per-partition, online |

The 800-million-row problem didn't disappear—we just made it manageable by not treating it as one problem.

## Conclusion

PostgreSQL partitioning turns one overwhelming table into many manageable ones. Choose your partition key based on query patterns, not convenience. Automate partition creation and retention. Verify partition pruning with EXPLAIN. And start before you hit 800 million rows—migrating under pressure is no fun.

Range partitioning for time-series data. List partitioning for categorical splits. Hash partitioning for even distribution when nothing else fits. Match the strategy to your access patterns, and your future self won't be staring at EXPLAIN output showing 847 million rows removed by filter.

**Further Resources:**
- [PostgreSQL Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — Official documentation
- [pg_partman](https://github.com/pgpartman/pg_partman) — Partition management extension
- [PostgreSQL Partition Pruning](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITION-PRUNING) — How pruning works
- [Citus Data: Time-Series Best Practices](https://www.citusdata.com/blog/) — Advanced partitioning patterns

---

*PostgreSQL partitioning from June 2022, covering range, list, and hash partitioning.*

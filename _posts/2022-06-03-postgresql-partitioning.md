---
layout: post
title: "PostgreSQL Partitioning: Managing Large Tables"
date: 2022-06-03
categories: [How-To]
tags: [PostgreSQL, Partitioning, Database]
excerpt: "Partition large PostgreSQL tables: range partitioning, list partitioning, hash partitioning, and strategies for managing billions of rows efficiently."
---

Partitioning improves performance for large tables. After partitioning production databases, here's how to use it effectively.

## Partitioning Types

### Range Partitioning

```sql
CREATE TABLE orders (
    id SERIAL,
    user_id INTEGER,
    total DECIMAL,
    created_at TIMESTAMP
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2022_q1 PARTITION OF orders
    FOR VALUES FROM ('2022-01-01') TO ('2022-04-01');

CREATE TABLE orders_2022_q2 PARTITION OF orders
    FOR VALUES FROM ('2022-04-01') TO ('2022-07-01');
```

### List Partitioning

```sql
CREATE TABLE users (
    id SERIAL,
    name VARCHAR(255),
    country VARCHAR(2)
) PARTITION BY LIST (country);

CREATE TABLE users_us PARTITION OF users
    FOR VALUES IN ('US');

CREATE TABLE users_eu PARTITION OF users
    FOR VALUES IN ('GB', 'FR', 'DE');
```

### Hash Partitioning

```sql
CREATE TABLE events (
    id SERIAL,
    user_id INTEGER,
    event_type VARCHAR(50),
    data JSONB
) PARTITION BY HASH (user_id);

CREATE TABLE events_0 PARTITION OF events
    FOR VALUES WITH (modulus 4, remainder 0);

CREATE TABLE events_1 PARTITION OF events
    FOR VALUES WITH (modulus 4, remainder 1);
```

## Best Practices

1. **Choose partition key** - Based on queries
2. **Partition size** - Keep partitions manageable
3. **Indexes** - Per partition
4. **Maintenance** - Regular cleanup
5. **Monitor** - Track partition sizes
6. **Query optimization** - Partition pruning
7. **Backup strategy** - Per partition
8. **Documentation** - Clear partition strategy

## Conclusion

Partitioning enables:
- Better performance
- Easier maintenance
- Scalability
- Query optimization

Start with range partitioning, then optimize. The patterns shown here handle large tables effectively.

---

*PostgreSQL partitioning from June 2022, covering range, list, and hash partitioning.*

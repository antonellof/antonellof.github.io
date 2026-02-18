---
layout: post
title: "PostgreSQL vs DynamoDB: Use Cases and Trade-offs"
date: 2019-09-11
categories: [Deep Dive]
tags: [PostgreSQL, DynamoDB, Database]
excerpt: "Compare PostgreSQL and DynamoDB: when to use each, performance characteristics, cost considerations, and migration strategies. Learn the trade-offs between SQL and NoSQL."
---

Choosing between PostgreSQL and DynamoDB depends on use case. After using both in production, here's a comprehensive comparison.

## PostgreSQL Overview

PostgreSQL is:
- **Relational database** - ACID transactions
- **SQL support** - Complex queries
- **ACID compliance** - Data consistency
- **Open source** - Self-hosted or managed

## DynamoDB Overview

DynamoDB is:
- **NoSQL database** - Key-value/document store
- **Managed service** - AWS handles operations
- **Serverless** - Auto-scaling
- **Single-digit millisecond** - Low latency

## When to Use PostgreSQL

### Complex Queries

```sql
-- Join multiple tables
SELECT u.name, o.total, p.name
FROM users u
JOIN orders o ON u.id = o.user_id
JOIN products p ON o.product_id = p.id
WHERE u.created_at > '2019-01-01'
GROUP BY u.name, o.total, p.name
HAVING COUNT(o.id) > 5
ORDER BY o.total DESC;
```

### ACID Transactions

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

### Use Cases

- **Financial applications** - Need transactions
- **Reporting/analytics** - Complex aggregations
- **Multi-table relationships** - Normalized data
- **Full-text search** - PostgreSQL FTS
- **Geospatial data** - PostGIS extension

## When to Use DynamoDB

### Simple Access Patterns

```javascript
// Get item by key
const user = await dynamodb.get({
    TableName: 'Users',
    Key: { userId: '123' }
}).promise();

// Query by GSI
const orders = await dynamodb.query({
    TableName: 'Orders',
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
        ':userId': '123'
    }
}).promise();
```

### Use Cases

- **High-traffic applications** - Auto-scaling
- **Simple data models** - Key-value access
- **Serverless applications** - Lambda integration
- **Mobile apps** - Low latency
- **Session storage** - TTL support

## Performance Comparison

### Read Performance

**PostgreSQL:**
- Optimized queries: < 10ms
- Complex joins: 50-500ms
- Full table scan: seconds

**DynamoDB:**
- Single item: < 5ms
- Query: < 10ms
- Scan: 100ms - seconds

### Write Performance

**PostgreSQL:**
- Single insert: < 10ms
- Batch insert: 50-100ms
- With indexes: 20-50ms

**DynamoDB:**
- Single item: < 5ms
- Batch write: < 10ms
- Consistent writes: < 10ms

## Cost Comparison

### PostgreSQL (RDS)

- **Instance**: $50-500/month
- **Storage**: $0.10/GB/month
- **Backups**: $0.095/GB/month
- **Data transfer**: $0.09/GB

### DynamoDB

- **On-demand**: $1.25/million reads, $1.25/million writes
- **Provisioned**: $0.00025/RCU, $0.00125/WCU
- **Storage**: $0.25/GB/month
- **Backups**: $0.20/GB/month

**Example:**
- 1M reads/day, 500K writes/day
- PostgreSQL: ~$200/month
- DynamoDB (on-demand): ~$75/month

## Data Modeling

### PostgreSQL (Normalized)

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    email VARCHAR(255)
);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    total DECIMAL(10,2),
    created_at TIMESTAMP
);

CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    product_id INTEGER,
    quantity INTEGER,
    price DECIMAL(10,2)
);
```

### DynamoDB (Denormalized)

```javascript
{
    "PK": "USER#123",
    "SK": "PROFILE",
    "name": "John Doe",
    "email": "john@example.com"
}

{
    "PK": "USER#123",
    "SK": "ORDER#456",
    "orderId": "456",
    "total": 99.99,
    "items": [
        { "productId": "789", "quantity": 2, "price": 49.99 }
    ]
}
```

## Query Patterns

### PostgreSQL

```sql
-- Complex query
SELECT 
    u.name,
    COUNT(o.id) as order_count,
    SUM(o.total) as total_spent
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.created_at > '2019-01-01'
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 0
ORDER BY total_spent DESC
LIMIT 10;
```

### DynamoDB

```javascript
// Must know access patterns upfront
// Get user's orders
const orders = await dynamodb.query({
    TableName: 'Orders',
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
        ':pk': 'USER#123',
        ':prefix': 'ORDER#'
    }
}).promise();

// Or use GSI for different access pattern
const ordersByStatus = await dynamodb.query({
    TableName: 'Orders',
    IndexName: 'status-index',
    KeyConditionExpression: 'status = :status',
    ExpressionAttributeValues: {
        ':status': 'pending'
    }
}).promise();
```

## Scalability

### PostgreSQL

- **Vertical scaling** - Bigger instances
- **Read replicas** - Scale reads
- **Sharding** - Manual partitioning
- **Connection pooling** - Required

### DynamoDB

- **Auto-scaling** - Automatic
- **Partitioning** - Automatic
- **Global tables** - Multi-region
- **No connection management** - Serverless

## Migration Strategies

### PostgreSQL to DynamoDB

```javascript
// 1. Identify access patterns
// 2. Design DynamoDB schema
// 3. Migrate data
async function migrateUser(user) {
    await dynamodb.put({
        TableName: 'Users',
        Item: {
            PK: `USER#${user.id}`,
            SK: 'PROFILE',
            name: user.name,
            email: user.email,
            createdAt: user.created_at
        }
    }).promise();
}

// 4. Dual write during migration
async function createUser(user) {
    // Write to both
    await Promise.all([
        postgres.insert(user),
        dynamodb.put({ TableName: 'Users', Item: user })
    ]);
}
```

### DynamoDB to PostgreSQL

```sql
-- 1. Design normalized schema
-- 2. Migrate data
INSERT INTO users (id, name, email)
SELECT DISTINCT
    SUBSTRING(PK, 6) as id,
    name,
    email
FROM dynamodb_export
WHERE SK = 'PROFILE';

-- 3. Migrate related data
INSERT INTO orders (id, user_id, total)
SELECT
    SUBSTRING(SK, 7) as id,
    SUBSTRING(PK, 6) as user_id,
    total
FROM dynamodb_export
WHERE begins_with(SK, 'ORDER#');
```

## Hybrid Approach

Use both:

```javascript
// PostgreSQL for complex queries
const analytics = await postgres.query(`
    SELECT 
        DATE(created_at) as date,
        COUNT(*) as orders,
        SUM(total) as revenue
    FROM orders
    GROUP BY DATE(created_at)
    ORDER BY date DESC
`);

// DynamoDB for simple lookups
const user = await dynamodb.get({
    TableName: 'Users',
    Key: { userId: '123' }
}).promise();
```

## Decision Matrix

| Factor | PostgreSQL | DynamoDB |
|--------|-----------|----------|
| Complex queries | ✅ Excellent | ❌ Limited |
| ACID transactions | ✅ Full support | ⚠️ Conditional |
| Auto-scaling | ❌ Manual | ✅ Automatic |
| Cost at scale | ⚠️ Higher | ✅ Lower |
| Learning curve | ⚠️ Steeper | ✅ Easier |
| Multi-table joins | ✅ Excellent | ❌ Not supported |
| Managed service | ⚠️ RDS | ✅ Fully managed |

## Best Practices

### PostgreSQL

1. **Use indexes** - Optimize queries
2. **Connection pooling** - Manage connections
3. **Read replicas** - Scale reads
4. **Partitioning** - For large tables
5. **Regular VACUUM** - Maintain performance

### DynamoDB

1. **Design for access patterns** - Not normalization
2. **Use GSIs wisely** - They cost money
3. **Monitor capacity** - Watch throttling
4. **Use TTL** - Auto-delete old data
5. **Batch operations** - Reduce costs

## Conclusion

**Choose PostgreSQL when:**
- Complex queries needed
- ACID transactions required
- Multi-table relationships
- Reporting/analytics

**Choose DynamoDB when:**
- Simple access patterns
- High traffic/auto-scaling needed
- Serverless architecture
- Low latency critical

Both have their place. Choose based on your specific needs and access patterns.

---

*PostgreSQL vs DynamoDB comparison from September 2019, covering use cases and trade-offs.*

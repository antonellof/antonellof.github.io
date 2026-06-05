---
layout: post
title: "PostgreSQL vs DynamoDB: Use Cases and Trade-offs"
date: 2019-09-11
categories: [Deep Dive]
tags: [PostgreSQL, DynamoDB, Database]
excerpt: "PostgreSQL and DynamoDB aren't rivals — they're tools that punish you differently for bad decisions. Here's how to pick the one that matches your access patterns, not your AWS bill anxiety."
---

The database debate in 2019 had the energy of a religious war.

Team SQL would recite ACID compliance like a prayer. Team NoSQL would whisper "single-digit millisecond latency" and watch people's eyes glaze over with desire. Meanwhile, someone in the corner was trying to run complex analytics on DynamoDB and wondering why their query returned an invoice instead of results.

I've run both in production — PostgreSQL for the core product data, DynamoDB for high-throughput session and event storage — and the lesson that took longest to learn is this: **the choice isn't about which database is better. It's about which database punishes your specific mistakes less severely.**

PostgreSQL punishes you when you need to scale writes horizontally and haven't planned for it. DynamoDB punishes you when you need ad-hoc queries and designed your schema like it was PostgreSQL with an AWS logo.

## PostgreSQL: The Database That Does Almost Everything

PostgreSQL in 2019 was the default serious choice for relational data:

- Full ACID transactions across multiple tables
- Complex SQL — joins, aggregations, window functions, CTEs
- Rich extensions (PostGIS for geospatial, full-text search built in)
- Self-hosted or managed via RDS, with predictable instance-based pricing

It's the database you reach for when your data model has relationships, your queries are exploratory, and "eventual consistency" is not a phrase you want to explain to finance.

### When PostgreSQL Shines: Complex Queries

```sql
SELECT u.name, o.total, p.name
FROM users u
JOIN orders o ON u.id = o.user_id
JOIN products p ON o.product_id = p.id
WHERE u.created_at > '2019-01-01'
GROUP BY u.name, o.total, p.name
HAVING COUNT(o.id) > 5
ORDER BY o.total DESC;
```

Three-table join with aggregation and filtering. PostgreSQL eats this for breakfast. You write the query, add an index, run `EXPLAIN ANALYZE`, and move on with your day.

Try expressing this in DynamoDB and you'll end up with three tables, two GSIs, a denormalized cache, and a strong opinion about your life choices.

### When PostgreSQL Shines: ACID Transactions

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

Money moves atomically or not at all. No "the debit succeeded but the credit is still propagating" explanations to your compliance team.

DynamoDB has transactions (they landed in 2018), but they're conditional, limited to 25 items, and not the natural mode of operation. PostgreSQL transactions are the default assumption.

### PostgreSQL Sweet Spots

- Financial applications where consistency isn't negotiable
- Reporting and analytics with ad-hoc aggregations
- Multi-table relational data with foreign keys
- Full-text search without bolting on Elasticsearch
- Geospatial queries via PostGIS

## DynamoDB: The Database That Scales If You Behave

DynamoDB is AWS's managed NoSQL key-value/document store:

- Single-digit millisecond latency at virtually any scale
- Automatic horizontal scaling — no sharding scripts at 2 AM
- Serverless pricing model (on-demand or provisioned capacity)
- Native TTL for automatic data expiration
- Tight Lambda integration for event-driven architectures

The catch — and it's a big one — is that **you must know your access patterns before you design your schema.** DynamoDB isn't schema-less. It's schema-flexible with very expensive consequences for getting the schema wrong.

### When DynamoDB Shines: Simple, Predictable Access

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

Key lookup: sub-5ms. Query on a well-designed GSI: sub-10ms. No connection pooling, no vacuum maintenance, no "the DBA is on vacation and the replica is lagging."

This is beautiful when your access patterns are simple. It's a trap when they're not.

### DynamoDB Sweet Spots

- High-traffic applications with predictable read/write patterns
- Session storage with TTL expiration
- Mobile backends needing low-latency key lookups
- Serverless architectures (Lambda + DynamoDB is a natural pairing)
- Event sourcing and append-only access patterns

## Performance: The Numbers That Matter (And the Ones That Don't)

Benchmarks in 2019 blog posts were everywhere. Here's what actually mattered in production:

### Read Performance

**PostgreSQL:**
- Indexed point queries: under 10ms
- Complex multi-table joins: 50–500ms (highly dependent on data size and indexes)
- Full table scans: seconds to minutes (please don't)

**DynamoDB:**
- Single-item GetItem: under 5ms
- Query on partition key or GSI: under 10ms
- Table scans: expensive in both time and money (DynamoDB charges per item scanned)

The headline "DynamoDB is faster" is true for key lookups and misleading for everything else. PostgreSQL with proper indexes is fast enough for most applications. DynamoDB is faster when you've designed for exactly the access pattern you're using.

### Write Performance

**PostgreSQL:**
- Single insert: under 10ms
- Batch inserts: 50–100ms for hundreds of rows
- Write-heavy workloads eventually hit vertical scaling limits

**DynamoDB:**
- Single item write: under 5ms
- Batch writes: under 10ms for batches of 25
- Scales horizontally without you managing shards

If you're writing millions of events per hour with simple key-based access, DynamoDB's write scaling is genuinely impressive. If you're doing complex multi-row transactions, PostgreSQL is the only sane choice.

## Cost: Where Surprises Live

### PostgreSQL on RDS

- Instance: $50–500/month depending on size
- Storage: ~$0.10/GB/month
- Backups: ~$0.095/GB/month
- Data transfer: ~$0.09/GB

Predictable. You pick an instance size, you pay for it, you scale vertically when needed. The bill doesn't surprise you unless you forget to turn off the staging RDS instance (we all did this).

### DynamoDB

- On-demand: $1.25 per million read request units, $1.25 per million write request units
- Provisioned: $0.00025/RCU/hour, $0.00125/WCU/hour
- Storage: $0.25/GB/month
- Backups: $0.20/GB/month
- GSIs: each one doubles your write costs for that data

**Example workload:** 1M reads/day, 500K writes/day

- PostgreSQL (db.t3.medium RDS): ~$200/month
- DynamoDB on-demand: ~$75/month

DynamoDB wins on cost for simple, high-volume key access. Add three GSIs, a few table scans, and an accidentally unbounded query — and DynamoDB's bill starts reading like a phone number.

The real cost difference isn't the monthly invoice. It's the engineering cost of working around each database's limitations.

## Data Modeling: Where the Philosophies Diverge

### PostgreSQL: Normalize, Then Denormalize If Needed

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    email VARCHAR(255)
);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    total DECIMAL(10, 2),
    created_at TIMESTAMP
);

CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    product_id INTEGER,
    quantity INTEGER,
    price DECIMAL(10, 2)
);
```

Clean relational model. Foreign keys enforce integrity. Joins compose data at query time. Add a new access pattern? Write a new query. PostgreSQL is flexible about how you read data.

### DynamoDB: Design for Access Patterns, Denormalize Aggressively

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

Single-table design pattern. Related data colocated by partition key. Order items embedded in the order document because DynamoDB doesn't do joins. Add a new access pattern? You might need a new GSI — and GSIs cost money and write throughput.

This is the fundamental trade-off. PostgreSQL optimizes for flexible queries. DynamoDB optimizes for predictable access at scale.

## Query Patterns: The Moment of Truth

### PostgreSQL: Ask Anything (Within Reason)

```sql
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

Top 10 customers by spend since January. One query. No schema changes. This is what PostgreSQL was built for.

### DynamoDB: Know What You're Asking Before You Build

```javascript
// Get user's orders — designed for this access pattern
const orders = await dynamodb.query({
    TableName: 'Orders',
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
        ':pk': 'USER#123',
        ':prefix': 'ORDER#'
    }
}).promise();

// Get orders by status — needs a GSI designed upfront
const ordersByStatus = await dynamodb.query({
    TableName: 'Orders',
    IndexName: 'status-index',
    KeyConditionExpression: 'status = :status',
    ExpressionAttributeValues: {
        ':status': 'pending'
    }
}).promise();
```

"What are the top 10 customers by total spend?" is a scan or a pre-computed aggregation table in DynamoDB. Not impossible, but not natural. If your product team regularly asks questions you didn't anticipate, PostgreSQL will save you weeks of schema redesign.

## Scalability: Different Paths to "Big"

### PostgreSQL

- Vertical scaling first (bigger instance)
- Read replicas for read-heavy workloads
- Connection pooling (PgBouncer) is mandatory at scale
- Manual sharding when vertical scaling stops working
- Partitioning for large tables (PostgreSQL 10+ native partitioning)

PostgreSQL scaling is well-understood but operationally involved. You feel the ceiling approaching and you plan for it.

### DynamoDB

- Automatic partitioning and scaling
- No connection management (it's HTTP-based)
- Global tables for multi-region replication
- On-demand mode handles traffic spikes without capacity planning

DynamoDB scaling is closer to "set and forget" — as long as your access patterns don't include hot partitions. Write everything to the same partition key and you'll discover that "unlimited scale" has an asterisk.

## Migration: The Paths Nobody Wants to Walk

### PostgreSQL to DynamoDB

```javascript
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

// Dual write during migration
async function createUser(user) {
    await Promise.all([
        postgres.insert(user),
        dynamodb.put({ TableName: 'Users', Item: user })
    ]);
}
```

The migration isn't the code — it's the schema redesign. Every access pattern in PostgreSQL becomes an explicit design decision in DynamoDB. Budget weeks for schema design, not days for data copying.

### DynamoDB to PostgreSQL

```sql
INSERT INTO users (id, name, email)
SELECT DISTINCT
    SUBSTRING(PK, 6) as id,
    name,
    email
FROM dynamodb_export
WHERE SK = 'PROFILE';

INSERT INTO orders (id, user_id, total)
SELECT
    SUBSTRING(SK, 7) as id,
    SUBSTRING(PK, 6) as user_id,
    total
FROM dynamodb_export
WHERE begins_with(SK, 'ORDER#');
```

Denormalized DynamoDB data must be re-normalized for PostgreSQL. Embedded arrays become separate tables. GSIs become indexes. The export is the easy part.

## The Hybrid Approach: Using Both (Guilt-Free)

```javascript
// PostgreSQL for complex analytics
const analytics = await postgres.query(`
    SELECT 
        DATE(created_at) as date,
        COUNT(*) as orders,
        SUM(total) as revenue
    FROM orders
    GROUP BY DATE(created_at)
    ORDER BY date DESC
`);

// DynamoDB for fast session lookups
const user = await dynamodb.get({
    TableName: 'Users',
    Key: { userId: '123' }
}).promise();
```

This isn't architectural indecision. It's using each database where it's strongest. PostgreSQL for the reporting dashboard. DynamoDB for the session store that handles 50K reads per second. The complexity cost is real, but so is the alternative — forcing one database to do everything it's bad at.

## Decision Framework

| Factor | PostgreSQL | DynamoDB |
|--------|-----------|----------|
| Complex ad-hoc queries | Excellent | Poor |
| ACID multi-row transactions | Native | Limited |
| Auto-scaling writes | Manual effort | Automatic |
| Cost at simple high volume | Higher baseline | Often lower |
| Schema flexibility at read time | High | Low |
| Operational overhead | Moderate (even on RDS) | Low (fully managed) |
| Multi-table joins | Core feature | Not supported |
| Learning curve for SQL devs | Low | Medium (different mental model) |

## Operating Each Database Well

With PostgreSQL, indexes are not optional decorations — they're the difference between 5ms and 5 seconds. Connection pooling via PgBouncer becomes mandatory once you're past a handful of application servers. Read replicas help until your writes become the bottleneck, at which point you're having the partitioning conversation. Run `VACUUM` and monitor bloat; PostgreSQL doesn't maintain itself.

With DynamoDB, design your table around access patterns before you write code — retrofitting GSIs is painful and expensive. Every GSI duplicates write costs for indexed attributes, so add them deliberately, not speculatively. Watch for throttling in CloudWatch; on-demand mode helps but hot partitions can still bite you. Use TTL for data that should expire (sessions, temp tokens). Batch operations (up to 25 items) reduce both cost and latency.

## The Honest Conclusion

**Choose PostgreSQL when:**
- Your queries are complex, ad-hoc, or join-heavy
- ACID transactions across multiple rows are core to your business logic
- Your team thinks in SQL and you want to leverage that
- Reporting and analytics run against the same database

**Choose DynamoDB when:**
- Access patterns are simple, known, and key-based
- You need automatic scaling without operational overhead
- You're building serverless on AWS (Lambda + DynamoDB is a natural fit)
- Sub-10ms latency at high throughput is a hard requirement

**Choose both when:**
- Different parts of your system have genuinely different access patterns
- You can afford the operational complexity of two data stores
- Neither database alone would force you into ugly workarounds

The worst database decision isn't picking the wrong one. It's picking based on hype instead of access patterns, then spending six months fighting the database's natural grain.

PostgreSQL will never be a great key-value store at infinite scale. DynamoDB will never be a great ad-hoc analytics engine. Respect what each does well, and your future self won't be writing a migration blog post at 2 AM.

---

*Written September 2019, comparing PostgreSQL and DynamoDB for production use cases. DynamoDB has since added features (transactions, on-demand scaling improvements, PartiQL), and PostgreSQL continues to evolve — but the fundamental trade-off between query flexibility and operational scale remains.*

---
layout: post
title: "DynamoDB Data Modeling: Patterns and Best Practices"
date: 2018-04-23
categories: [How-To]
tags: [DynamoDB, AWS, NoSQL, Data Modeling]
excerpt: "I tried to make DynamoDB behave like PostgreSQL. DynamoDB won. Here's the access-pattern-first mindset that finally made NoSQL click."
---

I spent my first week with DynamoDB trying to recreate relational tables. Users table. Orders table. OrderItems table. Foreign keys in my head. JOINs in my dreams.

DynamoDB let me create all three tables just fine. Then I tried to query orders by status across all users, and DynamoDB looked at me the way a cat looks at someone knocking on the wrong apartment door. Not angry. Just fundamentally uninterested.

DynamoDB isn't a relational database that chose not to implement JOINs out of spite. It's a key-value store with superpowers, optimized for predictable access patterns at massive scale. The modeling process is inverted: in PostgreSQL you normalize first and query however you want. In DynamoDB you figure out how you'll query first, then design keys that make those queries fast.

Once I stopped fighting the model and started designing for access patterns, things clicked. Here's what that looks like in practice.

## The Building Blocks

Before patterns, the vocabulary:

- **Partition Key (PK)**: Determines which physical partition stores your item. All items with the same partition key live together. This is your primary routing mechanism.
- **Sort Key (SK)**: Orders items within a partition. Enables range queries, hierarchical data, and multiple item types per partition.
- **GSI (Global Secondary Index)**: An alternate partition key + sort key combination. Basically a second way to look up your data. Costs money and has its own capacity.
- **LSI (Local Secondary Index)**: Same partition key, different sort key. Less flexible than GSIs, but free on provisioned capacity (with constraints).

```python
import boto3

dynamodb = boto3.resource('dynamodb')

# Create table
table = dynamodb.create_table(
    TableName='Users',
    KeySchema=[
        {
            'AttributeName': 'userId',
            'KeyType': 'HASH'  # Partition key
        },
        {
            'AttributeName': 'timestamp',
            'KeyType': 'RANGE'  # Sort key
        }
    ],
    AttributeDefinitions=[
        {
            'AttributeName': 'userId',
            'AttributeType': 'S'
        },
        {
            'AttributeName': 'timestamp',
            'AttributeType': 'N'
        }
    ],
    BillingMode='PAY_PER_REQUEST'
)
```

`PAY_PER_REQUEST` (on-demand) was new around this time and a gift for workloads with unpredictable traffic. No more capacity planning roulette.

## Access Patterns First: The DynamoDB Design Process

Before you write a single line of table definition, list every way your application reads and writes data:

```
Access Patterns:
1. Get user by ID
2. Get user's orders
3. Get orders by status (across all users)
4. Get user's recent activity
```

Each access pattern needs a key structure that supports it with a Query operation—not a Scan. Scans read every item in the table. Scans at scale are how you blow your AWS budget and your pager simultaneously.

If an access pattern doesn't map to a key-based query, you need a GSI—or you need to rethink whether DynamoDB is the right store for that data.

## Single Table Design: One Table to Rule Them All

The single-table design pattern stores multiple entity types in one table, using composite keys to organize them. It sounds wrong if you're coming from relational modeling. It works because DynamoDB doesn't care what your items represent—it cares about partition keys and sort keys.

```python
# User profile
{
    "PK": "USER#123",
    "SK": "PROFILE",
    "GSI1PK": "USER#123",
    "GSI1SK": "PROFILE",
    "userId": "123",
    "name": "John Doe",
    "email": "john@example.com",
    "type": "user"
}

# User's order
{
    "PK": "USER#123",
    "SK": "ORDER#456",
    "GSI1PK": "ORDER#456",
    "GSI1SK": "STATUS#pending",
    "orderId": "456",
    "userId": "123",
    "status": "pending",
    "total": 99.99,
    "type": "order"
}

# User's activity
{
    "PK": "USER#123",
    "SK": "ACTIVITY#2018-04-15T10:00:00Z",
    "GSI1PK": "ACTIVITY",
    "GSI1SK": "2018-04-15T10:00:00Z",
    "activityType": "login",
    "timestamp": "2018-04-15T10:00:00Z",
    "type": "activity"
}
```

Notice the pattern: `PK` groups everything belonging to a user. `SK` distinguishes entity types with prefixes (`PROFILE`, `ORDER#`, `ACTIVITY#`). `GSI1PK` and `GSI1SK` provide alternate access paths.

The `type` attribute is for your application code, not DynamoDB. It helps you deserialize the right model when items of different shapes share a partition.

### Querying the Single Table

```python
# Get user profile
response = table.query(
    KeyConditionExpression='PK = :pk AND SK = :sk',
    ExpressionAttributeValues={
        ':pk': 'USER#123',
        ':sk': 'PROFILE'
    }
)

# Get all of a user's orders
response = table.query(
    KeyConditionExpression='PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues={
        ':pk': 'USER#123',
        ':prefix': 'ORDER#'
    }
)

# Get orders by status (via GSI1)
response = table.query(
    IndexName='GSI1',
    KeyConditionExpression='GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues={
        ':pk': 'ORDER#456',
        ':prefix': 'STATUS#'
    }
)
```

`begins_with` on the sort key is one of DynamoDB's most useful operators. It turns a partition into a filtered list without scanning unrelated items.

## Patterns You'll Use Constantly

### Entity with Related Metadata

Not everything is a separate table—or even a separate item type. Settings, preferences, and configuration can live as distinct items under the same partition:

```python
# User entity
{
    "PK": "USER#123",
    "SK": "METADATA",
    "name": "John Doe",
    "email": "john@example.com"
}

# User's notification settings
{
    "PK": "USER#123",
    "SK": "SETTINGS#notifications",
    "emailNotifications": True,
    "pushNotifications": False
}
```

Update notification settings without touching the user profile. Query all settings with `begins_with(SK, 'SETTINGS#')`. Clean boundaries, one partition.

### Time-Series Data

Sensor readings, audit logs, activity feeds—anything where you query by entity and time range:

```python
# Sensor reading
{
    "PK": "SENSOR#temp-1",
    "SK": "2018-04-15T10:00:00Z",
    "temperature": 72.5,
    "humidity": 45.2
}

# Query recent readings
response = table.query(
    KeyConditionExpression='PK = :pk AND SK >= :timestamp',
    ExpressionAttributeValues={
        ':pk': 'SENSOR#temp-1',
        ':timestamp': '2018-04-15T00:00:00Z'
    },
    ScanIndexForward=False  # Descending order—newest first
)
```

ISO 8601 timestamps as sort keys give you natural chronological ordering. `ScanIndexForward=False` flips to descending—newest readings first. Combine with `Limit` for "last 10 readings" queries.

### Many-to-Many Relationships

Social follows, tag associations, enrollment records—relationships that in SQL need a junction table:

```python
# User 123 follows user 456
{
    "PK": "USER#123",
    "SK": "FOLLOWS#456",
    "followedUserId": "456",
    "followedAt": "2018-04-15T10:00:00Z"
}

# Reverse lookup: who follows user 123?
{
    "PK": "USER#123",
    "SK": "FOLLOWED_BY#789",
    "followerId": "789",
    "followedAt": "2018-04-15T10:00:00Z"
}

# Or flip via GSI for a single write pattern
{
    "PK": "USER#123",
    "SK": "FOLLOWS#456",
    "GSI1PK": "USER#456",
    "GSI1SK": "FOLLOWED_BY#123"
}
```

The adjacency list pattern stores relationships as items. The GSI flip lets you query "who does user 123 follow?" via the main table and "who follows user 456?" via the GSI—without duplicating the relationship data.

Yes, sometimes you write two items for one relationship. Storage is cheap. Query flexibility is expensive.

## GSI Patterns: Alternate Views of Your Data

GSIs are powerful and costly. Every GSI replicates data and consumes write capacity on every write to the base table. Use them deliberately.

### Sparse Indexes

Only items that need an alternate access path populate the GSI:

```python
# Only active orders get a GSI entry
{
    "PK": "USER#123",
    "SK": "ORDER#456",
    "GSI1PK": "STATUS#active",  # Only present if status is active
    "GSI1SK": "2018-04-15T10:00:00Z",
    "status": "active"
}

# Completed orders omit GSI1PK entirely—they won't appear in the index
{
    "PK": "USER#123",
    "SK": "ORDER#789",
    "status": "completed"
    # No GSI1PK—this item is invisible to GSI1
}
```

Query all active orders across all users:

```python
response = table.query(
    IndexName='GSI1',
    KeyConditionExpression='GSI1PK = :status',
    ExpressionAttributeValues={
        ':status': 'STATUS#active'
    }
)
```

Sparse indexes keep GSI size proportional to the data you actually need to query alternately—not the total table size. When an order completes, delete the GSI attributes (or overwrite the item without them) and it vanishes from the index.

### Inverted Indexes

When you need to look up relationships from either direction:

```python
# Forward: user's orders
{
    "PK": "USER#123",
    "SK": "ORDER#456",
    "orderId": "456"
}

# Inverted: order to user lookup
{
    "PK": "ORDER#456",
    "SK": "USER#123",
    "GSI1PK": "ORDER#456",
    "GSI1SK": "USER#123"
}
```

"Who placed order 456?" is a direct query on `PK = ORDER#456`. No scan, no GSI required if you write the inverted item.

## Batch Operations: Efficiency at Scale

```python
# Batch write—up to 25 items per call
with table.batch_writer() as batch:
    for item in items:
        batch.put_item(Item=item)

# Batch get—up to 100 items per call
response = dynamodb.batch_get_item(
    RequestItems={
        'Users': {
            'Keys': [
                {'userId': '123'},
                {'userId': '456'},
                {'userId': '789'}
            ]
        }
    }
)
```

The batch writer handles retries and chunking automatically. Use it for seed data, bulk imports, and any write-heavy operation. Individual `put_item` calls in a loop will be slower and more expensive.

## What We Got Wrong (So You Don't Have To)

**Designing for access patterns, not normalization.** This is the big one. If you can't express an access pattern as a Query with a key condition, redesign the keys or add a GSI. Don't Scan and filter in application code.

**Single table when patterns overlap.** Multiple entity types sharing a table works when they share access patterns. If your users and your sensor readings have nothing in common query-wise, separate tables are fine. Single table is a tool, not a religion.

**Denormalize without guilt.** Store the user's name on their order item. Update it when the name changes (or don't, if eventual consistency is acceptable for your use case). DynamoDB doesn't do JOINs—you do JOINs at write time.

**GSIs cost real money.** Each GSI doubles your write costs for items it indexes. Plan two or three GSIs, not ten. Sparse indexes help keep costs manageable.

**Hot partitions are real.** If every request hits `PK = GLOBAL_CONFIG`, one partition handles all the traffic. Distribute load across partition keys—use random suffixes, time-based sharding, or write sharding patterns for high-traffic keys.

**Composite keys unlock complex queries.** `PK` + `SK` together give you a hierarchical namespace. `USER#123` / `ORDER#456` / `ITEM#789` is a tree you can traverse with `begins_with`.

**Watch for throttling.** On provisioned capacity, hot partitions or underestimated throughput cause `ProvisionedThroughputExceededException`. On-demand mode reduces this but doesn't eliminate it at extreme scale. CloudWatch metrics are your friend.

**TTL for automatic cleanup.** Session data, temporary tokens, audit logs you only need for 90 days—set a `ttl` attribute and let DynamoDB delete expired items for free.

## The Mental Model Shift

Coming from relational databases, DynamoDB modeling feels backwards. You don't design tables and then figure out queries. You list queries and then design keys.

The process that worked for us:

1. Write down every access pattern (reads and writes)
2. Identify the key structure for each (PK, SK, which index)
3. Check that every pattern is a Query, not a Scan
4. Denormalize data to avoid needing JOINs
5. Add GSIs only for access patterns the main table can't serve
6. Prototype with real data volumes and measure

DynamoDB will happily store millions of items and serve single-digit millisecond reads—if your keys are right. If your keys are wrong, it will also happily store millions of items and make you regret your career choices every time you run a Scan.

Start with access patterns. Design your keys. Test with volume. The patterns in this post handled millions of items in production for us—they're the foundation, not the ceiling.

---

*Written in April 2018, covering DynamoDB production patterns including on-demand billing (launched late 2018) and single-table design approaches popularized by AWS solutions architects around this time.*

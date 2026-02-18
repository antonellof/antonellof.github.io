---
layout: post
title: "DynamoDB Data Modeling: Patterns and Best Practices"
date: 2018-04-23
categories: [How-To]
tags: [DynamoDB, AWS, NoSQL, Data Modeling]
excerpt: "Learn DynamoDB data modeling patterns including single-table design, access patterns, GSIs, and how to model relational data in a NoSQL database."
---

DynamoDB requires a different mindset than relational databases. After modeling complex applications in DynamoDB, I've learned that understanding access patterns is more important than normalization.

## DynamoDB Basics

### Key Concepts

- **Partition Key**: Determines data distribution
- **Sort Key**: Orders items within partition
- **GSI**: Global Secondary Index (different partition/sort keys)
- **LSI**: Local Secondary Index (same partition, different sort key)

### Table Structure

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

## Access Patterns First

Design your table based on how you'll query it:

```
Access Patterns:
1. Get user by ID
2. Get user's orders
3. Get orders by status
4. Get user's recent activity
```

## Single Table Design

### Denormalized Data Model

```python
# Single table for users, orders, and activities
{
    "PK": "USER#123",           # Partition key
    "SK": "PROFILE",            # Sort key
    "GSI1PK": "USER#123",
    "GSI1SK": "PROFILE",
    "userId": "123",
    "name": "John Doe",
    "email": "john@example.com",
    "type": "user"
}

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

### Query Patterns

```python
# Get user profile
response = table.query(
    KeyConditionExpression='PK = :pk AND SK = :sk',
    ExpressionAttributeValues={
        ':pk': 'USER#123',
        ':sk': 'PROFILE'
    }
)

# Get user's orders
response = table.query(
    KeyConditionExpression='PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues={
        ':pk': 'USER#123',
        ':prefix': 'ORDER#'
    }
)

# Get orders by status (using GSI1)
response = table.query(
    IndexName='GSI1',
    KeyConditionExpression='GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues={
        ':pk': 'ORDER#456',
        ':prefix': 'STATUS#'
    }
)
```

## Common Patterns

### Pattern 1: Entity with Metadata

```python
# User entity
{
    "PK": "USER#123",
    "SK": "METADATA",
    "name": "John Doe",
    "email": "john@example.com"
}

# User's settings
{
    "PK": "USER#123",
    "SK": "SETTINGS#notifications",
    "emailNotifications": True,
    "pushNotifications": False
}
```

### Pattern 2: Time-Series Data

```python
# Sensor readings
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
    ScanIndexForward=False  # Descending order
)
```

### Pattern 3: Many-to-Many Relationships

```python
# User-Follow relationship
{
    "PK": "USER#123",
    "SK": "FOLLOWS#456",
    "followedUserId": "456",
    "followedAt": "2018-04-15T10:00:00Z"
}

# Reverse: Who follows user 123
{
    "PK": "USER#123",
    "SK": "FOLLOWED_BY#789",
    "followerId": "789",
    "followedAt": "2018-04-15T10:00:00Z"
}

# Or use GSI
{
    "PK": "USER#123",
    "SK": "FOLLOWS#456",
    "GSI1PK": "USER#456",  # Flipped for reverse lookup
    "GSI1SK": "FOLLOWED_BY#123"
}
```

## GSI Patterns

### Sparse Index

```python
# Only index active orders
{
    "PK": "USER#123",
    "SK": "ORDER#456",
    "GSI1PK": "STATUS#active",  # Only if active
    "GSI1SK": "2018-04-15T10:00:00Z",
    "status": "active"
}

# Query active orders
response = table.query(
    IndexName='GSI1',
    KeyConditionExpression='GSI1PK = :status',
    ExpressionAttributeValues={
        ':status': 'STATUS#active'
    }
)
```

### Inverted Index

```python
# Original
{
    "PK": "USER#123",
    "SK": "ORDER#456",
    "orderId": "456"
}

# Inverted for lookup
{
    "PK": "ORDER#456",
    "SK": "USER#123",
    "GSI1PK": "ORDER#456",
    "GSI1SK": "USER#123"
}
```

## Batch Operations

```python
# Batch write
with table.batch_writer() as batch:
    for item in items:
        batch.put_item(Item=item)

# Batch get
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

## Best Practices

1. **Design for access patterns** - Not normalization
2. **Use single table** - When access patterns overlap
3. **Denormalize data** - Reduce queries
4. **Use GSIs wisely** - They cost money
5. **Hot partition avoidance** - Distribute load
6. **Use composite keys** - For complex queries
7. **Monitor capacity** - Watch throttling
8. **Use TTL** - Auto-delete old data

## Conclusion

DynamoDB modeling requires:
- Understanding access patterns first
- Denormalization over normalization
- Strategic use of GSIs
- Single table design when appropriate

Start with access patterns, then design your keys. The patterns shown here handle millions of items in production.

---

*DynamoDB data modeling from April 2018, covering production patterns.*

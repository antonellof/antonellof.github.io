---
layout: post
title: "MongoDB Schema Design Patterns"
date: 2017-11-17
categories: [How-To]
tags: [MongoDB, Database Design, NoSQL, Schema Patterns]
excerpt: "MongoDB schema design patterns for common use cases, including embedding vs referencing, one-to-many relationships, and denormalization strategies."
---

MongoDB's flexible schema is both a blessing and a curse. After designing schemas for various applications, I've learned that good MongoDB schema design requires different thinking than relational databases.

## Embedding vs Referencing

### When to Embed

Embed when:
- Data is accessed together
- One-to-few relationships
- Data doesn't change frequently

```javascript
// User with addresses (one-to-few)
{
    _id: ObjectId("..."),
    name: "John Doe",
    email: "john@example.com",
    addresses: [
        {
            street: "123 Main St",
            city: "New York",
            zip: "10001"
        },
        {
            street: "456 Oak Ave",
            city: "Boston",
            zip: "02101"
        }
    ]
}
```

### When to Reference

Reference when:
- Many-to-many relationships
- Data changes frequently
- Data is large
- Need to query independently

```javascript
// Users collection
{
    _id: ObjectId("user1"),
    name: "John Doe",
    email: "john@example.com"
}

// Orders collection
{
    _id: ObjectId("order1"),
    userId: ObjectId("user1"),  // Reference
    items: [
        { productId: ObjectId("prod1"), quantity: 2 },
        { productId: ObjectId("prod2"), quantity: 1 }
    ],
    total: 99.99
}
```

## One-to-Many Patterns

### Pattern 1: Embedding (Small N)

```javascript
// Good for small, bounded arrays
{
    _id: ObjectId("blog1"),
    title: "MongoDB Patterns",
    author: "John Doe",
    comments: [
        {
            author: "Alice",
            text: "Great article!",
            date: ISODate("2017-11-15")
        },
        {
            author: "Bob",
            text: "Very helpful",
            date: ISODate("2017-11-16")
        }
    ]
}
```

### Pattern 2: Child References (Large N)

```javascript
// Parent document
{
    _id: ObjectId("blog1"),
    title: "MongoDB Patterns",
    author: "John Doe"
}

// Child documents
{
    _id: ObjectId("comment1"),
    blogId: ObjectId("blog1"),
    author: "Alice",
    text: "Great article!",
    date: ISODate("2017-11-15")
}

// Query with $lookup
db.blogs.aggregate([
    { $match: { _id: ObjectId("blog1") } },
    {
        $lookup: {
            from: "comments",
            localField: "_id",
            foreignField: "blogId",
            as: "comments"
        }
    }
]);
```

### Pattern 3: Parent References

```javascript
// For many-to-many relationships
// Tags collection
{
    _id: ObjectId("tag1"),
    name: "mongodb"
}

// Posts collection
{
    _id: ObjectId("post1"),
    title: "MongoDB Guide",
    tagIds: [ObjectId("tag1"), ObjectId("tag2")]
}
```

## Denormalization Patterns

### Pattern 1: One-Way Embedding

```javascript
// Embed frequently accessed data
// User document
{
    _id: ObjectId("user1"),
    name: "John Doe",
    email: "john@example.com"
}

// Order document (embeds user name)
{
    _id: ObjectId("order1"),
    userId: ObjectId("user1"),
    userName: "John Doe",  // Denormalized
    items: [...],
    total: 99.99
}
```

### Pattern 2: Two-Way Embedding

```javascript
// User document
{
    _id: ObjectId("user1"),
    name: "John Doe",
    recentOrders: [
        { orderId: ObjectId("order1"), total: 99.99 },
        { orderId: ObjectId("order2"), total: 149.99 }
    ]
}

// Order document
{
    _id: ObjectId("order1"),
    userId: ObjectId("user1"),
    userName: "John Doe",
    items: [...],
    total: 99.99
}
```

## Precomputed Patterns

### Pattern 1: Precomputed Aggregates

```javascript
// Product document with precomputed stats
{
    _id: ObjectId("prod1"),
    name: "Laptop",
    price: 999.99,
    stats: {
        totalSales: 1250,
        totalRevenue: 1249987.50,
        averageRating: 4.5,
        reviewCount: 342
    }
}

// Update stats on each sale
db.products.update(
    { _id: ObjectId("prod1") },
    {
        $inc: {
            "stats.totalSales": 1,
            "stats.totalRevenue": 999.99
        }
    }
);
```

### Pattern 2: Bucket Pattern

```javascript
// Store time-series data in buckets
{
    _id: ObjectId("sensor1"),
    sensorId: "temp-sensor-1",
    metadata: { location: "Room 101" },
    measurements: [
        {
            timestamp: ISODate("2017-11-15T10:00:00Z"),
            temperature: 72.5
        },
        {
            timestamp: ISODate("2017-11-15T10:05:00Z"),
            temperature: 73.1
        }
        // ... up to 1000 measurements per document
    ]
}
```

## Polymorphic Pattern

```javascript
// Different document types in same collection
// Content collection
[
    {
        _id: ObjectId("content1"),
        type: "article",
        title: "MongoDB Guide",
        body: "...",
        author: "John Doe"
    },
    {
        _id: ObjectId("content2"),
        type: "video",
        title: "MongoDB Tutorial",
        url: "https://...",
        duration: 600,
        author: "John Doe"
    },
    {
        _id: ObjectId("content3"),
        type: "podcast",
        title: "MongoDB Podcast",
        audioUrl: "https://...",
        transcript: "...",
        author: "John Doe"
    }
]

// Query by type
db.content.find({ type: "article" });
```

## Extended Reference Pattern

```javascript
// Store frequently accessed fields with reference
// Order document
{
    _id: ObjectId("order1"),
    userId: ObjectId("user1"),
    // Extended reference
    user: {
        _id: ObjectId("user1"),
        name: "John Doe",
        email: "john@example.com"
    },
    items: [
        {
            productId: ObjectId("prod1"),
            productName: "Laptop",  // Denormalized
            price: 999.99,
            quantity: 1
        }
    ]
}
```

## Schema Versioning

```javascript
// Add version field for schema migrations
{
    _id: ObjectId("user1"),
    schemaVersion: 2,
    name: "John Doe",
    email: "john@example.com",
    // New fields in v2
    preferences: {
        theme: "dark",
        notifications: true
    }
}

// Migration script
async function migrateToV3() {
    const users = await db.users.find({ schemaVersion: 2 });
    
    for (const user of users) {
        await db.users.update(
            { _id: user._id },
            {
                $set: {
                    schemaVersion: 3,
                    profile: {
                        bio: "",
                        avatar: null
                    }
                }
            }
        );
    }
}
```

## Indexing Strategies

```javascript
// Compound indexes for common queries
db.orders.createIndex({ userId: 1, createdAt: -1 });

// Text index for search
db.articles.createIndex({
    title: "text",
    content: "text"
});

// Geospatial index
db.locations.createIndex({ location: "2dsphere" });

// TTL index for expiration
db.sessions.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 3600 }
);
```

## Best Practices

1. **Design for queries** - Structure based on access patterns
2. **Embed for one-to-few** - Reference for one-to-many
3. **Denormalize carefully** - Balance consistency vs performance
4. **Use appropriate indexes** - Support your queries
5. **Consider document size** - Keep under 16MB
6. **Version your schema** - Plan for migrations
7. **Precompute aggregates** - For frequently accessed data
8. **Use buckets** - For time-series data

## Common Anti-Patterns

### Anti-Pattern 1: Massive Arrays

```javascript
// BAD: Unbounded array growth
{
    _id: ObjectId("user1"),
    logins: [
        // Could grow to millions
    ]
}

// GOOD: Use separate collection or buckets
{
    _id: ObjectId("login1"),
    userId: ObjectId("user1"),
    timestamp: ISODate("2017-11-15T10:00:00Z")
}
```

### Anti-Pattern 2: Over-Normalization

```javascript
// BAD: Too many references (like relational DB)
{
    _id: ObjectId("order1"),
    userId: ObjectId("user1"),
    itemIds: [ObjectId("item1"), ObjectId("item2")]
}

// GOOD: Embed when appropriate
{
    _id: ObjectId("order1"),
    userId: ObjectId("user1"),
    items: [
        { productId: ObjectId("prod1"), name: "Laptop", price: 999.99 }
    ]
}
```

## Conclusion

MongoDB schema design requires:
- Understanding access patterns
- Choosing embedding vs referencing
- Strategic denormalization
- Proper indexing
- Schema versioning

Design for your queries, not for normalization. The patterns shown here handle millions of documents in production.

---

*MongoDB schema patterns from November 2017, covering common design patterns for NoSQL databases.*

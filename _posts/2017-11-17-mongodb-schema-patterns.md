---
layout: post
title: "MongoDB Schema Design Patterns"
date: 2017-11-17
categories: [How-To]
tags: [MongoDB, Database Design, NoSQL, Schema Patterns]
excerpt: "MongoDB doesn't have a schema — which is the best and worst thing about it. Here's how we stopped fighting the document model and started using it."
---

The senior engineer on our team had a habit of drawing relational ER diagrams for every new feature. Boxes, lines, foreign keys, the works. Then we'd implement it in MongoDB and wonder why our queries needed four `$lookup` stages and a prayer.

MongoDB's flexible schema isn't "no schema." It's "you design the schema, just not the way Postgres trained you to." After designing schemas for e-commerce, content platforms, and analytics pipelines, the lesson was consistent: **design for how you query, not for how you normalize.**

Here's the pattern library that survived production — and the anti-patterns that caused 3 a.m. incidents.

## The Eternal Question: Embed or Reference?

Relational databases make this decision for you: normalize, use foreign keys, join at query time. MongoDB shrugs and says "your call."

**Embed** when data is read together, the relationship is one-to-few, and the embedded data doesn't change independently very often.

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

One query, full user profile. No joins. This is MongoDB on its best behavior.

**Reference** when the relationship is many-to-many, data changes independently, documents would get too large, or you need to query the child data on its own.

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

Orders grow unboundedly. Users have many orders. Embedding all orders inside the user document is how you discover MongoDB's 16MB document limit the hard way.

## One-to-Many: Three Patterns for Three Scales

### Small N: Just Embed It

A blog with a dozen comments? Embed them. Don't overthink it.

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

Fast reads, atomic updates, simple queries. The dream.

### Large N: Child References

When comments become thousands (or you hope they will), move them out.

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

`$lookup` is MongoDB's join. It works, but it's not free. Index `blogId` on the comments collection or this aggregation becomes a collection scan with a side of regret.

### Many-to-Many: Parent References (Both Sides)

```javascript
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

Store references on the side you query from most often. Need "all posts with tag X"? Index `tagIds`. Need "all tags for post Y"? The array is right there.

## Denormalization: Copy Data on Purpose

In Postgres, duplicating data is a sin. In MongoDB, it's a performance strategy — if you do it deliberately.

### One-Way Embedding: Copy What You Read

```javascript
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

Order history pages show the customer name on every order. Embedding `userName` means one query, no join. The tradeoff: if John changes his name, old orders still say "John Doe" unless you update them (or accept staleness for historical records).

### Two-Way Embedding: Optimize Both Directions

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

Now the user profile loads recent orders instantly, and order details have the customer name. The cost: every order creation updates two documents. Use transactions (MongoDB 4.0+) or accept brief inconsistency.

## Precomputed Patterns: Do the Math Up Front

### Precomputed Aggregates

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

Running `COUNT(*)` and `SUM()` across millions of order documents for every product page view is how you fund your DBA's early retirement. Precompute on write, read the cached numbers.

Recalculate averages carefully — a running average update is trickier than a counter increment. We used periodic batch jobs to reconcile precomputed stats with source data. Trust, but verify.

### The Bucket Pattern for Time-Series

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

One reading per document means billions of tiny documents and indexes that eat your RAM. Bucketing — say, 1000 measurements per document — keeps document count manageable while preserving time-range queryability.

## Polymorphic Collections: One Collection, Many Shapes

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

A `type` discriminator field and an index on it. Your application code handles the different shapes. This beats maintaining three near-empty collections.

## Extended Reference: The Best of Both Worlds

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

You get the reference (`userId`) for when you need the canonical data, plus the embedded snapshot for when you need fast reads. Redundancy with a purpose.

## Schema Versioning: Because Documents Live Forever

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

Unlike SQL migrations that run once on deploy, MongoDB documents persist in old shapes until you migrate them. A `schemaVersion` field and lazy migration (update on read, batch migrate in background) keeps you sane.

## Indexing: The Part You Can't Skip

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

Every access pattern needs an index. "We'll add indexes later" is how you discover that `$lookup` on an unindexed foreign field turns your API into a DDoS attack against yourself.

Compound index field order matters: `{ userId: 1, createdAt: -1 }` supports "orders for user X, newest first." It does not efficiently support "all orders sorted by date across all users."

## Anti-Patterns That Hurt

### The Unbounded Array

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

Every login appended to a user document. Document size grew. Index updates slowed. Reads got expensive. The 16MB limit isn't theoretical — we got uncomfortably close on an activity log before catching it.

### Over-Normalizing in a Document Database

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

If you need four `$lookup` stages to render an order confirmation page, you built a relational schema inside a document database. Embrace embedding where reads are colocated.

## How We Actually Decide

We start with the query: "What does the screen need?" Then we work backward to the document shape. One-to-few and read-together → embed. One-to-many or independent updates → reference. Frequently displayed together but stored separately → denormalize the display fields.

We index before we ship, version our schemas before we need migrations, and precompute aggregates before the dashboard queries get slow. We keep documents under 16MB (ideally well under) and use buckets for anything that grows without bound.

## The Bottom Line

MongoDB schema design isn't about normalization — it's about access patterns. The right shape makes queries fast and code simple. The wrong shape makes `$lookup` pipelines and 3 a.m. index emergencies.

Embed for one-to-few. Reference for one-to-many. Denormalize deliberately, with a plan for staleness. Index for your actual queries. Version your schema. Precompute what you read often. Bucket what grows forever.

Design for how your app reads data, not for how a textbook draws ER diagrams. The patterns here handled millions of documents in production — not because we found the "correct" schema, but because we matched schema to query and adjusted when the queries changed.

---

*Written November 2017, reflecting MongoDB 3.x/3.6 patterns. Later versions added transactions, improved aggregation, and changed some defaults — but the embed-vs-reference tradeoffs are timeless.*

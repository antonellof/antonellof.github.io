---
layout: post
title: "Database Connection Pooling: Best Practices"
date: 2019-05-15
categories: [Architecture]
tags: [Database, Connection Pooling, Performance]
excerpt: "Optimize database connections with connection pooling. Learn pool sizing, connection lifecycle, monitoring, and production patterns for PostgreSQL, MySQL, and MongoDB."
---

Connection pooling is critical for database performance. After optimizing connection pools in production, here are the patterns that work.

## What is Connection Pooling?

Connection pooling:
- Reuses database connections
- Reduces connection overhead
- Limits concurrent connections
- Improves application performance

## PostgreSQL Pooling

### pgBouncer

```ini
# pgbouncer.ini
[databases]
mydb = host=localhost port=5432 dbname=mydb

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3
max_db_connections = 100
max_user_connections = 100
```

### Node.js with pg

```javascript
const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'user',
    password: 'password',
    max: 20,                    // Maximum pool size
    min: 5,                      // Minimum pool size
    idleTimeoutMillis: 30000,    // Close idle clients after 30s
    connectionTimeoutMillis: 2000, // Return error after 2s if connection unavailable
    maxUses: 7500,              // Close (and replace) a connection after it has been used this many times
});

// Use pool
async function getUser(userId) {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
        return result.rows[0];
    } finally {
        client.release(); // Return to pool
    }
}
```

### Python with psycopg2

```python
import psycopg2
from psycopg2 import pool

# Create connection pool
connection_pool = psycopg2.pool.SimpleConnectionPool(
    5,  # min connections
    20, # max connections
    host="localhost",
    port=5432,
    database="mydb",
    user="user",
    password="password"
)

def get_user(user_id):
    connection = connection_pool.getconn()
    try:
        cursor = connection.cursor()
        cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        return cursor.fetchone()
    finally:
        connection_pool.putconn(connection)
```

## MySQL Pooling

### Node.js with mysql2

```javascript
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'user',
    password: 'password',
    database: 'mydb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

async function getUser(userId) {
    const [rows] = await pool.execute(
        'SELECT * FROM users WHERE id = ?',
        [userId]
    );
    return rows[0];
}
```

### Python with PyMySQL

```python
import pymysql
from pymysql import pool

# Create connection pool
connection_pool = pool.ConnectionPool(
    creator=pymysql,
    maxconnections=20,
    mincached=5,
    host='localhost',
    user='user',
    password='password',
    database='mydb',
    charset='utf8mb4'
)

def get_user(user_id):
    connection = connection_pool.connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            return cursor.fetchone()
    finally:
        connection.close()
```

## MongoDB Pooling

### Node.js with mongodb

```javascript
const { MongoClient } = require('mongodb');

const client = new MongoClient('mongodb://localhost:27017', {
    maxPoolSize: 10,
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
});

async function getUser(userId) {
    await client.connect();
    const db = client.db('mydb');
    const user = await db.collection('users').findOne({ id: userId });
    return user;
}
```

## Pool Sizing

### Formula

```
connections = ((core_count * 2) + effective_spindle_count)
```

**Example:**
- 4 CPU cores
- 1 disk spindle
- Pool size = (4 * 2) + 1 = 9 connections

### Guidelines

- **Small applications**: 5-10 connections
- **Medium applications**: 10-20 connections
- **Large applications**: 20-50 connections
- **Very large**: 50-100 connections (with pgBouncer)

## Connection Lifecycle

```javascript
class ConnectionManager {
    constructor(config) {
        this.pool = new Pool(config);
        this.setupEventHandlers();
    }
    
    setupEventHandlers() {
        // Connection acquired
        this.pool.on('acquire', (client) => {
            console.log('Connection acquired');
        });
        
        // Connection released
        this.pool.on('release', (client) => {
            console.log('Connection released');
        });
        
        // Connection error
        this.pool.on('error', (err, client) => {
            console.error('Unexpected error on idle client', err);
        });
        
        // Pool exhausted
        this.pool.on('connect', (client) => {
            console.log('New client connected');
        });
    }
    
    async query(text, params) {
        const start = Date.now();
        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;
            console.log('Query executed', { text, duration, rows: result.rowCount });
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            console.error('Query error', { text, duration, error });
            throw error;
        }
    }
}
```

## Monitoring

### Pool Metrics

```javascript
function getPoolStats(pool) {
    return {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
    };
}

// Monitor pool
setInterval(() => {
    const stats = getPoolStats(pool);
    console.log('Pool stats:', stats);
    
    if (stats.waitingCount > 0) {
        console.warn('Clients waiting for connections!');
    }
    
    if (stats.idleCount === 0 && stats.totalCount === pool.options.max) {
        console.warn('Pool exhausted!');
    }
}, 5000);
```

### Prometheus Metrics

```javascript
const prometheus = require('prom-client');

const poolSizeGauge = new prometheus.Gauge({
    name: 'db_pool_size',
    help: 'Database connection pool size',
    labelNames: ['state']
});

const poolWaitCounter = new prometheus.Counter({
    name: 'db_pool_wait_total',
    help: 'Total number of clients waiting for connections'
});

function updateMetrics(pool) {
    poolSizeGauge.set({ state: 'total' }, pool.totalCount);
    poolSizeGauge.set({ state: 'idle' }, pool.idleCount);
    poolSizeGauge.set({ state: 'active' }, pool.totalCount - pool.idleCount);
    
    if (pool.waitingCount > 0) {
        poolWaitCounter.inc(pool.waitingCount);
    }
}
```

## Best Practices

1. **Size pool appropriately** - Based on workload
2. **Monitor pool metrics** - Track usage
3. **Set timeouts** - Prevent hanging
4. **Handle errors** - Graceful degradation
5. **Use connection poolers** - pgBouncer for PostgreSQL
6. **Test under load** - Verify pool sizing
7. **Close connections** - Always release
8. **Use transactions** - For consistency

## Common Issues

### Pool Exhaustion

```javascript
// Problem: Too many connections
// Solution: Increase pool size or use connection pooler

const pool = new Pool({
    max: 50, // Increase from 20
    // Or use pgBouncer
});
```

### Connection Leaks

```javascript
// Problem: Connections not released
// Solution: Always use try/finally

async function getUser(userId) {
    const client = await pool.connect();
    try {
        return await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    } finally {
        client.release(); // Always release
    }
}
```

### Slow Queries

```javascript
// Problem: Queries holding connections too long
// Solution: Set query timeout

const pool = new Pool({
    statement_timeout: 5000, // 5 seconds
    query_timeout: 5000
});
```

## Conclusion

Connection pooling:
- Improves performance
- Reduces overhead
- Limits connections
- Requires proper sizing

Size pools based on workload, monitor metrics, and handle errors gracefully. The patterns shown here handle production workloads.

---

*Database connection pooling from May 2019, covering production patterns.*

---
layout: post
title: "Database Connection Pooling: Best Practices"
date: 2019-05-26
categories: [Architecture]
tags: [Database, Connection Pooling, Performance]
excerpt: "We scaled to 200 app instances and PostgreSQL said 'absolutely not' to 200 connections. Connection pooling turned a capacity crisis into a configuration change."
---

The alert said `FATAL: sorry, too many clients already`.

We had scaled the application horizontally—more pods, more throughput, happier users. PostgreSQL, meanwhile, was having the database equivalent of a house party where everyone brought a plus-one and the fire marshal showed up.

Each app instance was opening its own connections. Twenty instances times twenty connections per pool is four hundred handshakes to a database that defaults to **one hundred max connections**. The math wasn't subtle. The fix wasn't "buy a bigger database" (though finance was ready). The fix was **connection pooling**—reuse a small set of connections instead of treating every HTTP request like it needs a fresh TCP soul mate.

## What pooling actually does

Opening a database connection is expensive: TCP handshake, authentication, memory on the server, sometimes SSL negotiation. Closing and reopening per request is like renting a new apartment every time you want to make coffee.

A pool:
- Maintains a set of warm connections ready to use
- Lends one to your code for the duration of a query/transaction
- Takes it back when you're done
- Caps total connections so you don't overwhelm the database

You trade a little complexity for a lot of stability. Worth it.

## PostgreSQL: pgBouncer is your friend

Application-level pools help. When you have many app servers, **pgBouncer** (or Pgpool-II) in front of PostgreSQL multiplexes thousands of client connections onto a smaller set of server connections.

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

**Pool modes matter:**
- `session` — connection tied to client for whole session (safest, least multiplexing)
- `transaction` — connection returned after each transaction (sweet spot for most web apps)
- `statement` — aggressive; breaks some session features; use carefully

We ran `transaction` mode for stateless APIs and slept better.

### Node.js with `pg`

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

`client.release()` in `finally` is non-negotiable. Forget it once and you've got a leak. Forget it in production and you've got a leak that grows until someone pages you.

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

Same rule: `putconn` in `finally`, every time.

## MySQL pooling

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

`mysql2/promise` pool handles acquire/release for simple queries. For transactions, grab a connection explicitly and release in `finally`.

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

## MongoDB pooling

The MongoDB driver pools by default—you configure it, not reinvent it:

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

Create **one** `MongoClient` per application process. Connecting per request is the Mongo equivalent of the PostgreSQL party problem.

## How big should the pool be?

The classic formula (from PostgreSQL wiki folklore):

```
connections = (core_count * 2) + effective_spindle_count
```

Example: 4 cores, 1 disk → `(4 * 2) + 1 = 9` connections.

Reality is messier. Rules of thumb that survived production:
- **Small apps**: 5-10 connections per process
- **Medium apps**: 10-20
- **Large apps**: 20-50 per process, often with pgBouncer in front
- **Many replicas**: divide database `max_connections` by instance count—don't let each pod claim 50 if you have forty pods

More connections ≠ faster queries. PostgreSQL context-switches between connections; past a point you hurt throughput. Profile under load; don't max the knob because it exists.

## Lifecycle: know what's happening inside the pool

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

Event handlers are noisy in dev and invaluable when debugging "why is everything waiting?"

## Monitor the pool (if you can't see it, you'll guess wrong)

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

`waitingCount > 0` means requests are queued for connections—either pool too small, queries too slow, or leaks.

### Export to Prometheus

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

Alert on sustained pool exhaustion before users feel it.

## The failures you'll actually hit

### Pool exhaustion

Symptom: timeouts, `waitingCount` climbing, database CPU oddly low (queries aren't running—they're queued in app land).

Fix: increase pool size modestly, add pgBouncer, or—often the real answer—**fix slow queries** holding connections hostage.

```javascript
const pool = new Pool({
    max: 50, // Increase from 20—but ask why you need to
});
```

### Connection leaks

Symptom: pool slowly drains until restart; `totalCount` stuck at max with nothing idle.

Fix: `release()` in `finally`. Every code path. Including the one that throws.

```javascript
async function getUser(userId) {
    const client = await pool.connect();
    try {
        return await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    } finally {
        client.release(); // Always release
    }
}
```

We once leaked connections in an error handler that logged and returned without releasing. Classic.

### Slow queries monopolizing the pool

Symptom: pool looks full, queries pile up, individual queries are fine in isolation.

Fix: statement timeouts, query optimization, read replicas for heavy reads.

```javascript
const pool = new Pool({
    statement_timeout: 5000, // 5 seconds
    query_timeout: 5000
});
```

A query that runs ten minutes shouldn't hold a connection for ten minutes without you explicitly deciding that's okay.

## Principles that survived our incidents

Size pools from **database limits and instance count**, not vibes. Monitor idle, active, and waiting counts. Set connection and query timeouts so failures fail fast. Always release connections in `finally`. Use pgBouncer (or equivalent) when many app servers share one database. Load-test pool sizing—staging with one user lies. Wrap multi-statement work in transactions so pgBouncer transaction mode behaves predictably.

Connection pooling isn't glamorous. Nobody puts "optimized pgBouncer config" on a conference slide. But it's the difference between horizontal scale that works and horizontal scale that DDOSes your own database.

## Start here

If you're running more than a handful of app instances against PostgreSQL: deploy pgBouncer in transaction mode, set per-process pool sizes so total server connections stay under ~70% of `max_connections`, add pool metrics to your dashboard, and grep your codebase for `connect()` without matching `release()`.

Your database will stop acting like a nightclub with a one-in-one-out policy. Your on-call rotation might even get a quiet weekend.

---

*Written May 2019, covering pg, pgBouncer, mysql2, and MongoDB driver pooling patterns. Managed databases and serverless connection proxies (RDS Proxy, etc.) extend these ideas; the math of "don't open a connection per request" hasn't changed.*

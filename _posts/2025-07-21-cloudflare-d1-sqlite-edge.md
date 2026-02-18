---
layout: post
title: "Cloudflare D1: SQLite at the Edge"
date: 2025-07-21
categories: [How-To]
tags: [Cloudflare D1, SQLite, Edge, Database]
excerpt: "Use Cloudflare D1 for edge databases: SQLite at the edge, global replication, query patterns, and how D1 enables low-latency database access."
---

[Cloudflare D1](https://developers.cloudflare.com/d1/) is SQLite running at the edge—familiar SQL, global replication, sub-10ms queries from anywhere. It's SQLite's simplicity combined with Cloudflare's distribution network.

I built a user preferences system with D1 and was surprised by how well it worked. Query latency from Sydney? 6ms. From São Paulo? 8ms. The same database, automatically replicated to edge locations, responding fast everywhere. No sharding configuration, no multi-region complexity—just SQLite that runs globally.

D1 makes sense for read-heavy workloads that benefit from geographic proximity: user settings, feature flags, product catalogs, metadata stores. It's less suited for write-heavy transactional systems (those need stronger consistency guarantees).

Based on SQLite (the [most widely deployed database](https://www.sqlite.org/mostdeployed.html)), D1 brings that reliability to the edge.

## Why D1?

**Familiar SQL** - If you know SQLite, you know D1. Standard SQL syntax, no new query language.

**Global replication** - Writes propagate to edge locations automatically. Reads are always local and fast.

**Workers integration** - First-class integration with Cloudflare Workers. No connection pooling, no ORMs—just direct access.

**Cost-effective** - $0.75/million reads, $5.00/GB storage. No per-database charges.

**Zero-configuration scaling** - No sharding, no read replicas, no deployment topology. It just works.

Read the [D1 announcement](https://blog.cloudflare.com/introducing-d1/) for Cloudflare's vision.

## Using D1 with Workers

D1 integrates natively with Cloudflare Workers:

### Create Database

```bash
# Install Wrangler
npm install -g wrangler

# Create D1 database
wrangler d1 create my-database

# Output: database_name = "my-database", database_id = "xxx-xxx-xxx"
```

Add to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"  # Available as env.DB in Workers
database_name = "my-database"
database_id = "xxx-xxx-xxx"
```

### Create Tables

```bash
# Create schema file
cat > schema.sql << 'EOF'
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS preferences (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
EOF

# Apply schema
wrangler d1 execute my-database --file=schema.sql
```

### Query from Workers

```typescript
// worker.ts
export interface Env {
    DB: D1Database;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        
        if (url.pathname === '/api/users' && request.method === 'GET') {
            // List users
            const result = await env.DB
                .prepare('SELECT id, email, name, created_at FROM users ORDER BY created_at DESC LIMIT 10')
                .all();
            
            return Response.json(result.results);
        }
        
        if (url.pathname === '/api/users' && request.method === 'POST') {
            // Create user
            const body = await request.json();
            
            const result = await env.DB
                .prepare('INSERT INTO users (email, name, created_at) VALUES (?, ?, ?) RETURNING id')
                .bind(body.email, body.name, Date.now())
                .first();
            
            return Response.json({ id: result.id }, { status: 201 });
        }
        
        if (url.pathname.startsWith('/api/users/')) {
            const userId = url.pathname.split('/')[3];
            
            // Get user with preferences
            const user = await env.DB
                .prepare('SELECT * FROM users WHERE id = ?')
                .bind(userId)
                .first();
            
            if (!user) {
                return Response.json({ error: 'User not found' }, { status: 404 });
            }
            
            const prefs = await env.DB
                .prepare('SELECT key, value FROM preferences WHERE user_id = ?')
                .bind(userId)
                .all();
            
            return Response.json({
                ...user,
                preferences: Object.fromEntries(
                    prefs.results.map(p => [p.key, p.value])
                ),
            });
        }
        
        return Response.json({ error: 'Not found' }, { status: 404 });
    },
};
```

### Batch Operations

Batch multiple statements for efficiency:

```typescript
async function createUserWithPreferences(
    db: D1Database,
    email: string,
    name: string,
    preferences: Record<string, string>
) {
    // Prepare statements
    const insertUser = db
        .prepare('INSERT INTO users (email, name, created_at) VALUES (?, ?, ?) RETURNING id')
        .bind(email, name, Date.now());
    
    // Execute in batch (returns array of results)
    const results = await db.batch([
        insertUser,
        ...Object.entries(preferences).map(([key, value]) =>
            db.prepare('INSERT INTO preferences (user_id, key, value) VALUES (?, ?, ?)')
                .bind('(SELECT last_insert_rowid())', key, value)
        ),
    ]);
    
    const userId = results[0].results[0].id;
    return userId;
}
```

Batching reduces round trips—crucial for edge performance.

### Prepared Statements

Always use prepared statements (parameterized queries):

```typescript
// Good: Prepared statement (prevents SQL injection)
const user = await env.DB
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first();

// Bad: String interpolation (SQL injection risk!)
const user = await env.DB
    .prepare(`SELECT * FROM users WHERE email = '${email}'`)
    .first();
```

D1 automatically caches prepared statement plans for performance.

## Production Best Practices

### 1. Schema Design

Keep schemas simple and focused:

```sql
-- Good: Compact rows, appropriate types
CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,  -- Store cents as INTEGER
    active INTEGER DEFAULT 1,  -- SQLite uses INTEGER for booleans
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_active ON products(active) WHERE active = 1;

-- Avoid: Large TEXT/BLOB columns at edge
-- Store large data (images, documents) in R2, keep references in D1
```

**Guidelines:**
- Normalize appropriately—D1 supports JOINs efficiently
- Use INTEGER for timestamps (Unix epoch)
- Index foreign keys and frequently queried columns
- Keep row sizes under 1KB when possible
- Store large blobs in R2, reference by key

### 2. Query Optimization

```typescript
// Use EXPLAIN QUERY PLAN to understand queries
const plan = await env.DB
    .prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE email = ?')
    .bind('test@example.com')
    .all();

console.log(plan.results);
// Shows if query uses indexes or table scans
```

**Optimization tips:**
- Use indexes for WHERE, ORDER BY, and JOIN columns
- Avoid `SELECT *`—specify columns you need
- Use LIMIT for pagination
- Consider denormalization for read-heavy workloads
- Profile queries in development with EXPLAIN

See [SQLite query optimization](https://www.sqlite.org/optoverview.html) for deep dives.

### 3. Migrations

Version your schema changes:

```bash
# Create migrations directory
mkdir -p migrations

# Migration 001: Initial schema
cat > migrations/001_initial.sql << 'EOF'
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
);
EOF

# Migration 002: Add name column
cat > migrations/002_add_name.sql << 'EOF'
ALTER TABLE users ADD COLUMN name TEXT;
EOF

# Apply migrations in order
for migration in migrations/*.sql; do
    echo "Applying $migration..."
    wrangler d1 execute my-database --file="$migration"
done
```

**Migration best practices:**
- Make migrations idempotent (use IF NOT EXISTS)
- Test in staging first
- Keep migrations small and focused
- Never delete migrations after deployment
- Document breaking changes

### 4. Backups

D1 provides automatic backups, but export critical data:

```bash
# Export database to SQL
wrangler d1 export my-database --output=backup.sql

# Or export to CSV
wrangler d1 execute my-database \
    --command="SELECT * FROM users" \
    --json > users_backup.json
```

Schedule regular exports to R2 for redundancy.

### 5. Monitoring

Track query performance:

```typescript
async function queryWithMetrics(
    db: D1Database,
    query: string,
    ...params: any[]
) {
    const start = Date.now();
    
    try {
        const result = await db.prepare(query).bind(...params).all();
        const duration = Date.now() - start;
        
        // Log slow queries
        if (duration > 100) {  // 100ms threshold
            console.warn('Slow query', {
                query,
                duration,
                rows: result.results.length,
            });
        }
        
        return result;
    } catch (error) {
        console.error('Query failed', { query, error });
        throw error;
    }
}
```

Monitor:
- Query latency (p50, p95, p99)
- Slow query frequency
- Error rates
- Database size growth
- Read/write ratio

## D1 vs Other Databases

| Feature | D1 | Planet Scale | Neon | Traditional RDS |
|---------|----|--------------|----- |-----------------|
| Latency (read) | 5-10ms | 50-200ms | 30-100ms | 50-300ms |
| Global read | ✅ Automatic | ❌ Single region | ❌ Single region | ❌ Manual setup |
| SQL dialect | SQLite | MySQL | Postgres | Various |
| Scaling | Automatic | Automatic | Automatic | Manual |
| Cost (10GB + 100M reads) | ~$80/mo | ~$40/mo | ~$60/mo | ~$200/mo |
| Edge integration | ✅ Native | ❌ | ❌ | ❌ |

**Choose D1 when:**
- Read-heavy workloads at global scale
- Sub-10ms latency requirements
- Using Cloudflare Workers
- Simple to moderate complexity queries

**Choose alternatives when:**
- Strong consistency critical (use Postgres/MySQL)
- Complex transactions required
- Existing Postgres/MySQL dependency
- Need advanced features (triggers, stored procedures)

## Limitations

D1 is early—know the constraints:

**Size limits (as of 2025):**
- Database size: 10GB (soft limit)
- Row size: ~1MB
- Query execution time: 30s max
- Batch size: 50 statements

**Feature gaps:**
- No full-text search (FTS) yet
- Limited geospatial support
- No database-level replication control
- Eventual consistency for writes (typically <1s propagation)

Check [D1 limits documentation](https://developers.cloudflare.com/d1/platform/limits/) for current constraints.

## Practical Use Cases

**1. User preferences/settings**
```sql
CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,
    theme TEXT DEFAULT 'light',
    language TEXT DEFAULT 'en',
    notifications INTEGER DEFAULT 1,
    updated_at INTEGER
);
```

**2. Feature flags**
```sql
CREATE TABLE feature_flags (
    flag_key TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    rollout_percentage INTEGER DEFAULT 0,
    updated_at INTEGER
);
```

**3. Product catalog**
```sql
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL,
    inventory INTEGER NOT NULL,
    metadata TEXT  -- JSON string
);
```

**4. API rate limiting**
```sql
CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);
```

## Conclusion

D1 brings SQLite's simplicity and SQLite's proven reliability to the edge. For read-heavy workloads that benefit from global distribution, it's compelling—sub-10ms queries from anywhere with zero configuration.

The Developer Experience is excellent: familiar SQL, direct Workers integration, no connection pooling headaches. The automatic replication is invisible and just works.

D1 is young. Features are still rolling out. But for the right use case—globally distributed, read-heavy data with moderate write frequency—it's hard to beat. SQLite at the edge is a powerful primitive.

**Further Resources:**
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/) - Official docs
- [D1 Get Started Guide](https://developers.cloudflare.com/d1/get-started/) - Quick start
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) - D1 management
- [SQLite Documentation](https://www.sqlite.org/docs.html) - SQL reference
- [SQLite Query Optimization](https://www.sqlite.org/optoverview.html) - Performance tuning
- [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) - Cost details
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) - Current constraints

---

*Cloudflare D1 from July 2025 — updated with production guidance.*

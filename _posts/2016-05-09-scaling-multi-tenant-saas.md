---
layout: post
title: "Scaling Multi-Tenant SaaS Applications"
date: 2016-05-09
categories: [Architecture]
tags: [SaaS, Multi-Tenancy, Scalability, Architecture]
excerpt: "We went from 10 tenants to 1,000+ and learned the hard way that one missing WHERE clause leaks everyone's data. Here's the architecture that survived — and the hybrid model we wish we'd picked on day one."
---

Every SaaS founder has the same dream at 10 customers: "We'll figure out multi-tenancy later."

Every SaaS engineer has the same nightmare at 1,000 customers: "We figured out multi-tenancy later."

We lived both versions. Scaling from 10 tenants to over 1,000 taught us that multi-tenancy isn't a feature you bolt on — it's the foundation everything else stands on. Database design, caching, migrations, billing limits, offboarding — all of it branches from one decision you make early and regret if you get it wrong.

The good news: you don't need to predict the future perfectly. You need to understand the three tenancy models, pick the least-wrong starting point, and build guardrails that make data leaks structurally difficult. Here's what worked, what didn't, and the hybrid approach we eventually landed on.

## Three Ways to Share (or Not Share) a Database

Multi-tenancy is really a question about isolation vs. cost vs. operational pain. Every model trades those three.

### Shared Database, Shared Schema — The Startup Default

Everyone shares tables. A `tenant_id` column tells you whose data you're looking at.

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    total DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE INDEX idx_orders_tenant ON orders(tenant_id);
```

This is the cheapest, fastest-to-ship option. One schema, one migration path, one backup strategy. Your AWS bill smiles.

The downside is existential: one missing `WHERE tenant_id = ?` and Customer A sees Customer B's invoices. I've seen it happen. It's the kind of bug that ends up in a postmortem with words like "regulatory" and "notification requirements."

Customization per tenant is also painful. Enterprise client wants a custom field? You're adding nullable columns everyone shares, or building EAV tables, or lying to the sales team.

### Shared Database, Separate Schema — The Middle Child

Each tenant gets their own schema inside one database. Better isolation, still one server to manage.

```sql
-- Tenant 1
CREATE SCHEMA tenant_1;
CREATE TABLE tenant_1.users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE,
    name VARCHAR(255)
);

-- Tenant 2
CREATE SCHEMA tenant_2;
CREATE TABLE tenant_2.users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE,
    name VARCHAR(255)
);
```

Routing happens at the application layer:

```php
class TenantConnection
{
    public function setTenant($tenantId)
    {
        $schema = "tenant_{$tenantId}";
        DB::statement("SET search_path TO {$schema}");
    }
    
    public function getTenantConnection($tenantId)
    {
        $this->setTenant($tenantId);
        return DB::connection();
    }
}
```

Per-tenant schema customization becomes feasible. Backups per tenant are easier. Data leakage requires actively connecting to the wrong schema, which is harder to do accidentally than forgetting a WHERE clause.

The tax: migrations run N times. Connection pool limits become real. Cross-tenant analytics queries turn into nightmares. We spent a full sprint building a migration runner that didn't leave half our tenants on schema version 47 and the other half on 52.

### Separate Database Per Tenant — The Enterprise Flex

Each tenant gets a dedicated database. Sometimes on dedicated hardware. Sometimes in a different region because compliance said so.

```php
class MultiTenantDatabase
{
    private $connections = [];
    
    public function getConnection($tenantId)
    {
        if (!isset($this->connections[$tenantId])) {
            $config = [
                'driver' => 'mysql',
                'host' => $this->getHostForTenant($tenantId),
                'database' => "tenant_{$tenantId}",
                'username' => env('DB_USERNAME'),
                'password' => env('DB_PASSWORD'),
            ];
            
            $this->connections[$tenantId] = new PDO(
                "mysql:host={$config['host']};dbname={$config['database']}",
                $config['username'],
                $config['password']
            );
        }
        
        return $this->connections[$tenantId];
    }
    
    private function getHostForTenant($tenantId)
    {
        // Distribute tenants across database servers
        $servers = [
            'db1.example.com',
            'db2.example.com',
            'db3.example.com',
        ];
        
        return $servers[$tenantId % count($servers)];
    }
}
```

Complete isolation. Scale the noisy neighbor without affecting anyone else. Data residency compliance becomes a routing problem, not a rewrite.

The cost is literal and operational. Hundreds of databases means hundreds of migration targets, connection pools, monitoring dashboards, and 3 AM pages. Your DevOps team will develop opinions about your architecture choices.

## The Hybrid We Wish We'd Started With

Pure models are for textbooks. Production SaaS is tiered:

```php
class TenantRouter
{
    public function getConnection($tenant)
    {
        switch ($tenant->tier) {
            case 'enterprise':
                // Dedicated database
                return $this->getEnterpriseConnection($tenant);
                
            case 'professional':
                // Separate schema
                return $this->getSchemaConnection($tenant);
                
            case 'starter':
                // Shared schema
                return $this->getSharedConnection($tenant);
        }
    }
}
```

Starter tenants on shared schema — maximize margin. Professional on separate schemas — better isolation without dedicated infra costs. Enterprise on dedicated databases — because their contract demands it and their invoice justifies it.

This let us upsell isolation without re-architecting. A starter customer going enterprise didn't require a data migration crisis — we'd already built the routing layer.

## Finding the Tenant: Subdomains, Headers, and Context

You can't scope queries to a tenant you haven't identified.

### Subdomain-Based Routing

`acme.myapp.com` → tenant Acme. Classic pattern, works great until someone asks about custom domains (that's a whole other post).

```nginx
# Nginx configuration
server {
    listen 80;
    server_name *.myapp.com;
    
    location / {
        proxy_pass http://app_servers;
        proxy_set_header X-Tenant-Subdomain $host;
    }
}
```

```php
class TenantMiddleware
{
    public function handle($request, Closure $next)
    {
        $subdomain = $this->extractSubdomain($request->getHost());
        
        $tenant = Tenant::where('subdomain', $subdomain)->firstOrFail();
        
        // Set tenant context
        app()->instance('tenant', $tenant);
        
        // Set database connection
        DB::setDefaultConnection("tenant_{$tenant->id}");
        
        return $next($request);
    }
    
    private function extractSubdomain($host)
    {
        $parts = explode('.', $host);
        return $parts[0];
    }
}
```

Set tenant context once per request. Everything downstream reads from that context. Never pass `tenant_id` as a user-supplied parameter without validation.

### Header-Based for APIs

Subdomains don't work for machine clients. API keys map to tenants:

```php
class ApiTenantMiddleware
{
    public function handle($request, Closure $next)
    {
        $apiKey = $request->header('X-API-Key');
        
        if (!$apiKey) {
            return response()->json(['error' => 'Missing API key'], 401);
        }
        
        $tenant = Tenant::where('api_key', $apiKey)->firstOrFail();
        
        app()->instance('tenant', $tenant);
        
        return $next($request);
    }
}
```

## Automatic Query Scoping: Your Last Line of Defense

Global scopes aren't optional in shared-schema multi-tenancy. They're the seatbelt.

```php
// Model trait
trait BelongsToTenant
{
    protected static function bootBelongsToTenant()
    {
        // Automatically scope queries
        static::addGlobalScope('tenant', function ($builder) {
            if (app()->has('tenant')) {
                $builder->where('tenant_id', app('tenant')->id);
            }
        });
        
        // Automatically set tenant on create
        static::creating(function ($model) {
            if (app()->has('tenant') && !$model->tenant_id) {
                $model->tenant_id = app('tenant')->id;
            }
        });
    }
}

// Usage
class User extends Model
{
    use BelongsToTenant;
}

// Queries automatically scoped
$users = User::all(); // Only returns current tenant's users
$user = User::find(1); // Only finds if belongs to current tenant
```

`User::all()` returning only the current tenant's users feels like magic until someone runs `User::withoutGlobalScope('tenant')->all()` in production to debug something and forgets to put the scope back. Code review exists for a reason.

## Security: Making Leaks Hard, Not Just Unlikely

### Row-Level Security in PostgreSQL

Defense in depth — even if application code forgets the WHERE clause, the database refuses:

```sql
-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY tenant_isolation ON users
    USING (tenant_id = current_setting('app.current_tenant')::integer);

-- Set tenant in session
SET app.current_tenant = '123';
```

```php
class SecureQuery
{
    public function query($tenantId, $sql, $params = [])
    {
        // Set tenant context
        DB::statement("SET app.current_tenant = ?", [$tenantId]);
        
        // Execute query - RLS automatically enforced
        return DB::select($sql, $params);
    }
}
```

RLS saved us during a refactor where a raw query bypassed the ORM. The database said no. The audit log said thank you.

### Validating Queries and Input

Belt, suspenders, and a safety harness:

```php
class TenantValidator
{
    public function validateQuery($sql, $tenantId)
    {
        // Parse SQL
        $tables = $this->extractTables($sql);
        
        // Verify all tables have tenant_id filter
        foreach ($tables as $table) {
            if (!$this->hasTenantFilter($sql, $table)) {
                throw new SecurityException(
                    "Query missing tenant filter for {$table}"
                );
            }
        }
    }
    
    public function sanitizeInput($data, $tenantId)
    {
        // Ensure tenant_id matches current tenant
        if (isset($data['tenant_id']) && $data['tenant_id'] != $tenantId) {
            throw new SecurityException('Tenant ID mismatch');
        }
        
        // Add tenant_id if missing
        $data['tenant_id'] = $tenantId;
        
        return $data;
    }
}
```

Never trust client-supplied `tenant_id`. Ever. Someone will try to pass a different one. The validator overwrites or rejects — no negotiation.

## Performance: The Noisy Neighbor Problem

### Tenant-Aware Caching

Shared Redis without tenant prefixes is how you serve one customer's dashboard data to another. Ask me how I know.

```php
class TenantCache
{
    private $redis;
    private $ttl = 3600;
    
    public function get($key)
    {
        $tenant = app('tenant');
        $cacheKey = "tenant:{$tenant->id}:{$key}";
        
        return $this->redis->get($cacheKey);
    }
    
    public function set($key, $value, $ttl = null)
    {
        $tenant = app('tenant');
        $cacheKey = "tenant:{$tenant->id}:{$key}";
        
        return $this->redis->setex(
            $cacheKey,
            $ttl ?? $this->ttl,
            serialize($value)
        );
    }
    
    public function flush()
    {
        $tenant = app('tenant');
        $pattern = "tenant:{$tenant->id}:*";
        
        $keys = $this->redis->keys($pattern);
        if (!empty($keys)) {
            $this->redis->del($keys);
        }
    }
}
```

Prefix everything: `tenant:{id}:`. Flush per tenant without collateral damage.

### Connection Pooling Per Tenant

Separate-schema and separate-database models multiply connection pressure:

```php
class ConnectionPool
{
    private $pools = [];
    private $maxConnections = 10;
    
    public function getConnection($tenantId)
    {
        if (!isset($this->pools[$tenantId])) {
            $this->pools[$tenantId] = [];
        }
        
        // Find available connection
        foreach ($this->pools[$tenantId] as $conn) {
            if (!$conn->inUse) {
                $conn->inUse = true;
                return $conn;
            }
        }
        
        // Create new if under limit
        if (count($this->pools[$tenantId]) < $this->maxConnections) {
            $conn = $this->createConnection($tenantId);
            $conn->inUse = true;
            $this->pools[$tenantId][] = $conn;
            return $conn;
        }
        
        // Wait for available connection
        return $this->waitForConnection($tenantId);
    }
    
    public function releaseConnection($conn)
    {
        $conn->inUse = false;
    }
}
```

Monitor connection counts per tenant. One enterprise customer running heavy reports can exhaust a pool if you're not watching.

## Resource Limits: Because "Unlimited" Isn't a Plan Tier

SaaS economics require enforcement. Someone will upload 40GB of files on the starter plan if you let them.

```php
class TenantLimits
{
    public function checkLimit($tenant, $resource, $count = 1)
    {
        $limits = [
            'starter' => [
                'users' => 10,
                'storage_mb' => 100,
                'api_calls_per_day' => 1000,
            ],
            'professional' => [
                'users' => 100,
                'storage_mb' => 1000,
                'api_calls_per_day' => 10000,
            ],
            'enterprise' => [
                'users' => PHP_INT_MAX,
                'storage_mb' => PHP_INT_MAX,
                'api_calls_per_day' => PHP_INT_MAX,
            ],
        ];
        
        $tierLimits = $limits[$tenant->tier];
        $current = $this->getCurrentUsage($tenant, $resource);
        
        if ($current + $count > $tierLimits[$resource]) {
            throw new LimitExceededException(
                "Limit exceeded for {$resource}. Upgrade your plan."
            );
        }
        
        return true;
    }
    
    private function getCurrentUsage($tenant, $resource)
    {
        switch ($resource) {
            case 'users':
                return User::where('tenant_id', $tenant->id)->count();
                
            case 'storage_mb':
                return $this->calculateStorageUsage($tenant);
                
            case 'api_calls_per_day':
                return $this->getApiCallCount($tenant);
        }
    }
}
```

Check limits at write time, not display time. "You have 99 of 100 users" is helpful. "You can't add user 101" after they've already filled out the form is a UX war crime.

## Schema Migrations: The Part Nobody Budgets For

One migration in shared-schema land: run once, done.

One migration with 1,000 tenant schemas: run 1,000 times, pray.

```php
class TenantMigrator
{
    public function migrate($migration)
    {
        $tenants = Tenant::all();
        
        foreach ($tenants as $tenant) {
            try {
                echo "Migrating tenant {$tenant->id}...";
                
                // Set tenant context
                $this->setTenantConnection($tenant);
                
                // Run migration
                Artisan::call('migrate', [
                    '--path' => $migration,
                    '--database' => "tenant_{$tenant->id}",
                ]);
                
                echo " ✓\n";
                
            } catch (Exception $e) {
                echo " ✗ Error: {$e->getMessage()}\n";
                
                // Log error but continue
                Log::error("Migration failed for tenant {$tenant->id}", [
                    'error' => $e->getMessage(),
                    'migration' => $migration,
                ]);
            }
        }
    }
    
    public function rollback($steps = 1)
    {
        $tenants = Tenant::all();
        
        foreach ($tenants as $tenant) {
            $this->setTenantConnection($tenant);
            
            Artisan::call('migrate:rollback', [
                '--step' => $steps,
                '--database' => "tenant_{$tenant->id}",
            ]);
        }
    }
}
```

Log failures, continue on error, report at the end. One failed tenant shouldn't block 999 successful migrations. But track which tenants failed — schema drift is a slow-motion outage.

## Monitoring Per Tenant: Find the Noisy Neighbor Before They Find You

```php
class TenantMetrics
{
    public function recordMetric($tenant, $metric, $value)
    {
        $key = "metrics:tenant:{$tenant->id}:{$metric}:" . date('Y-m-d-H');
        
        Redis::hincrby($key, 'count', 1);
        Redis::hincrbyfloat($key, 'sum', $value);
        Redis::expire($key, 86400 * 7); // 7 days retention
    }
    
    public function getMetrics($tenant, $metric, $hours = 24)
    {
        $data = [];
        
        for ($i = 0; $i < $hours; $i++) {
            $hour = date('Y-m-d-H', strtotime("-{$i} hours"));
            $key = "metrics:tenant:{$tenant->id}:{$metric}:{$hour}";
            
            $count = Redis::hget($key, 'count') ?? 0;
            $sum = Redis::hget($key, 'sum') ?? 0;
            
            $data[] = [
                'hour' => $hour,
                'count' => $count,
                'average' => $count > 0 ? $sum / $count : 0,
            ];
        }
        
        return $data;
    }
}
```

Per-tenant metrics let you spot the customer running 10x normal API volume before they take down the shared database for everyone else.

## Offboarding: Churn Happens, Data Lingers

Suspended accounts still consume storage. Deleted accounts need grace periods. GDPR-ish requests need exports.

```php
class TenantOffboarding
{
    public function suspend($tenant)
    {
        $tenant->update(['status' => 'suspended']);
        
        // Clear cache
        Cache::tags("tenant:{$tenant->id}")->flush();
        
        // Notify admins
        Notification::send(
            $tenant->admins,
            new AccountSuspendedNotification()
        );
    }
    
    public function deleteData($tenant)
    {
        DB::transaction(function() use ($tenant) {
            // Soft delete tenant data
            User::where('tenant_id', $tenant->id)->delete();
            Order::where('tenant_id', $tenant->id)->delete();
            
            // Schedule hard delete after grace period
            DeleteTenantDataJob::dispatch($tenant)
                ->delay(now()->addDays(30));
        });
    }
    
    public function exportData($tenant)
    {
        $data = [
            'users' => User::where('tenant_id', $tenant->id)->get(),
            'orders' => Order::where('tenant_id', $tenant->id)->get(),
        ];
        
        $json = json_encode($data, JSON_PRETTY_PRINT);
        
        Storage::put(
            "exports/tenant-{$tenant->id}-" . date('Y-m-d') . ".json",
            $json
        );
        
        return Storage::url("exports/tenant-{$tenant->id}-" . date('Y-m-d') . ".json");
    }
}
```

Soft delete → grace period → hard delete. The grace period saves you when someone churns angrily and comes back three weeks later asking for their data.

## What Actually Matters

Multi-tenant SaaS scaling isn't one big decision — it's a stack of small ones that compound.

Pick a tenancy model that matches your current stage, not your pitch deck. Shared schema is fine at 50 tenants if your scoping is bulletproof. Dedicated databases make sense when contracts and margins justify the ops burden. Hybrid routing lets you evolve without emergency migrations.

**Always scope queries by `tenant_id`.** Say it again. Tattoo it on the onboarding doc. One missing WHERE clause doesn't cause a bug — it causes a breach.

Automatic tenant scoping via middleware and model traits. Row-level security where your database supports it. Tenant-prefixed cache keys. Per-tenant resource limits enforced at write time. Migration runners that don't leave stragglers. Graceful offboarding with export paths.

We started simple with shared schema and global scopes. We migrated high-value customers to dedicated resources as contracts demanded it. The hybrid model gave us cost efficiency at the bottom and isolation at the top without maintaining three separate codebases.

The architecture that survives is the one that makes the right thing easy and the wrong thing loud.

---

*Lessons learned from scaling a multi-tenant SaaS platform in 2016. The tiered hybrid model and scoping discipline remain relevant even as managed multi-tenant databases and row-level security tooling have matured.*

---
layout: post
title: "Scaling Multi-Tenant SaaS Applications"
date: 2016-05-09
categories: [Architecture]
tags: [SaaS, Multi-Tenancy, Scalability, Architecture]
excerpt: "Architectural patterns and practical strategies for scaling multi-tenant SaaS applications, covering database design, tenant isolation, and performance optimization."
---

Building a multi-tenant SaaS application that scales to thousands of customers requires careful architectural decisions from day one. After scaling our SaaS platform from 10 to 1000+ tenants, I learned that the choices you make early have massive implications later. Here's what worked (and what didn't).

## Multi-Tenancy Models

There are three main approaches to multi-tenancy, each with distinct tradeoffs:

### 1. Shared Database, Shared Schema

All tenants share the same database and tables, distinguished by a `tenant_id` column.

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

**Pros:**
- Simplest to implement
- Most cost-effective
- Easy schema updates

**Cons:**
- Risk of data leakage
- Difficult to customize per tenant
- Single point of failure

### 2. Shared Database, Separate Schema

Each tenant gets their own schema within a shared database.

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

Application layer routing:

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

**Pros:**
- Better data isolation
- Can customize schema per tenant
- Easier backup/restore per tenant

**Cons:**
- More complex queries
- Schema migrations harder
- Limited by database connection limits

### 3. Separate Database Per Tenant

Each tenant gets a dedicated database.

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

**Pros:**
- Complete isolation
- Easy to scale specific tenants
- Can use different hardware per tenant
- Easier compliance (data residency)

**Cons:**
- Most expensive
- Complex schema migrations
- More operational overhead

## Our Hybrid Approach

We use a hybrid model based on tenant tier:

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

## Tenant Identification

### Subdomain-Based

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

### Header-Based (for APIs)

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

## Query Scoping

Automatically scope all queries to current tenant:

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

## Data Isolation and Security

### Row-Level Security in PostgreSQL

```sql
-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY tenant_isolation ON users
    USING (tenant_id = current_setting('app.current_tenant')::integer);

-- Set tenant in session
SET app.current_tenant = '123';
```

Application layer:

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

### Preventing Cross-Tenant Queries

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

## Performance Optimization

### Tenant-Aware Caching

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

### Database Connection Pooling

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

## Resource Limits Per Tenant

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

## Schema Migrations

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

## Monitoring and Analytics

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

## Handling Tenant Churn

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

## Conclusion

Scaling multi-tenant SaaS applications requires:
- Choose the right tenancy model for your use case
- Implement automatic tenant scoping
- Enforce strict data isolation
- Monitor per-tenant resource usage
- Plan schema migrations carefully
- Implement graceful tenant offboarding

Our hybrid approach (shared/schema/dedicated based on tier) gave us the best balance of cost and isolation. Start simple with shared schema, then migrate high-value customers to dedicated resources as needed.

The most important lesson: **Always scope queries by tenant_id**. One missing WHERE clause can leak data across tenants.

---

*Lessons learned from scaling a multi-tenant SaaS platform in 2016.*

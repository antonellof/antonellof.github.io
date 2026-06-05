---
layout: post
title: "Building a Multi-Region AWS Architecture"
date: 2019-06-06
categories: [Architecture]
tags: [AWS, Multi-Region, High Availability]
excerpt: "Our single-region 'high availability' survived AZ failures and died to a regional outage like a house of cards in a breeze. Multi-region was expensive until we learned what actually needed to be everywhere."
---

We thought we were resilient. Multi-AZ RDS, Auto Scaling across availability zones, health checks on the load balancer—the works. Then `us-east-1` had a bad day (they have those), and we learned that **surviving an AZ failure is not the same as surviving a region failure**.

Single-region architecture is a bet that your region stays boring. Sometimes that bet pays off for years. When it doesn't, you're choosing between accepting downtime or executing a disaster recovery runbook that nobody has practiced since the company had twelve employees.

Multi-region AWS architecture is how you stop treating regional outages like acts of god. It's also how you serve users in Tokyo without routing them through Virginia. And sometimes it's how legal tells you data must stay in the EU.

It's not free. It's not simple. But after building a few production multi-region systems, the patterns repeat—and the expensive mistakes do too.

## Why bother? (Pick your adventure)

- **High availability** — survive when an entire region goes sideways
- **Disaster recovery** — meet RTO/RPO targets without heroic manual effort
- **Low latency** — put compute close to users
- **Compliance** — data residency requirements that aren't negotiable

Know which problem you're solving. "Multi-region because it sounds enterprise" is how you double your bill without doubling your uptime.

## Two patterns that cover most cases

### Active-passive (one region works, one waits)

```
Region A (Primary)          Region B (Standby)
┌─────────────┐            ┌─────────────┐
│   Active    │            │   Passive   │
│  Services   │            │  Services   │
└──────┬──────┘            └──────┬──────┘
       │                          │
       └──────────┬───────────────┘
                  │
            ┌─────▼─────┐
            │ Route 53  │
            │  Failover │
            └───────────┘
```

Cheaper. Simpler data model. Standby region might be warm (ready to take traffic) or cold (spin up on failover). RTO depends on how warm "warm" actually is—be honest in runbooks.

### Active-active (both regions serve traffic)

```
Region A                    Region B
┌─────────────┐            ┌─────────────┐
│   Active    │            │   Active     │
│  Services   │◄──────────►│  Services    │
└──────┬──────┘            └──────┬──────┘
       │                          │
       └──────────┬───────────────┘
                  │
            ┌─────▼─────┐
            │ Route 53  │
            │  Latency  │
            └───────────┘
```

Better latency globally. Higher complexity. Data consistency becomes a conversation with consequences. Start active-passive; evolve when you feel the pain of single-region latency or capacity.

## Route 53: DNS is your traffic cop

### Failover routing (active-passive)

```json
{
  "Comment": "Multi-region failover",
  "Changes": [
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "primary",
        "Failover": "PRIMARY",
        "TTL": 60,
        "ResourceRecords": [
          {
            "Value": "1.2.3.4"
          }
        ],
        "HealthCheckId": "health-check-primary"
      }
    },
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "secondary",
        "Failover": "SECONDARY",
        "TTL": 60,
        "ResourceRecords": [
          {
            "Value": "5.6.7.8"
          }
        ]
      }
    }
  ]
}
```

Health checks on the primary record are mandatory. Route 53 won't failover to secondary if it can't tell primary is sick.

### Latency-based routing (active-active)

```json
{
  "Comment": "Multi-region latency routing",
  "Changes": [
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "us-east-1",
        "Region": "us-east-1",
        "TTL": 60,
        "ResourceRecords": [
          {
            "Value": "1.2.3.4"
          }
        ]
      }
    },
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "eu-west-1",
        "Region": "eu-west-1",
        "TTL": 60,
        "ResourceRecords": [
          {
            "Value": "5.6.7.8"
          }
        ]
      }
    }
  ]
}
```

Users get routed to the lowest-latency healthy region. Magic, as long as both regions are actually healthy and data doesn't fight you.

TTL of 60 seconds is a tradeoff: faster failover vs more DNS queries. During incidents, sixty seconds feels like an hour anyway.

## RDS across regions (where DR gets real)

### Cross-region read replicas

```bash
# Create read replica in another region
aws rds create-db-instance-read-replica \
  --db-instance-identifier mydb-replica \
  --source-db-instance-identifier arn:aws:rds:us-east-1:123456789012:db:mydb \
  --db-instance-class db.t3.medium \
  --availability-zone eu-west-1a
```

Replicas give you a copy. They don't automatically give you failover—you need a plan to promote.

### Promoting a replica (the "we're not going back" button)

```bash
# Promote read replica to standalone
aws rds promote-read-replica \
  --db-instance-identifier mydb-replica

# Update application to use new endpoint
```

Promotion is manual unless you automate it. Test this. Reading the runbook during an outage is education; executing untested promotion is trauma.

### Terraform for primary + replica

```hcl
# Primary database
resource "aws_db_instance" "primary" {
  identifier     = "mydb-primary"
  engine         = "postgres"
  instance_class = "db.t3.large"
  allocated_storage = 100
  
  backup_retention_period = 7
  backup_window          = "03:00-04:00"
  maintenance_window     = "mon:04:00-mon:05:00"
  
  multi_az = true
}

# Cross-region replica
resource "aws_db_instance" "replica" {
  provider = aws.eu-west-1
  
  identifier     = "mydb-replica"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class = "db.t3.large"
  
  backup_retention_period = 0
  skip_final_snapshot    = true
}
```

Multi-AZ in the primary region handles AZ failure. Cross-region replica handles region failure. Different problems, both worth solving.

## S3 cross-region replication (objects need a backup home)

```json
{
  "Role": "arn:aws:iam::123456789012:role/replication-role",
  "Rules": [
    {
      "Id": "ReplicateAll",
      "Status": "Enabled",
      "Priority": 1,
      "Filter": {},
      "Destination": {
        "Bucket": "arn:aws:s3:::my-bucket-replica",
        "StorageClass": "STANDARD"
      }
    }
  ]
}
```

```hcl
resource "aws_s3_bucket" "primary" {
  bucket = "my-bucket-primary"
  region = "us-east-1"
}

resource "aws_s3_bucket" "replica" {
  provider = aws.eu-west-1
  bucket   = "my-bucket-replica"
  region   = "eu-west-1"
}

resource "aws_s3_bucket_replication_configuration" "replication" {
  role   = aws_iam_role.replication.arn
  bucket = aws_s3_bucket.primary.id
  
  rule {
    id     = "replicate-all"
    status = "Enabled"
    
    destination {
      bucket        = aws_s3_bucket.replica.arn
      storage_class = "STANDARD"
    }
  }
}
```

Replication is asynchronous. Know your RPO: objects written seconds before a regional failure might not have replicated yet.

## DynamoDB Global Tables (active-active data without inventing sync)

```hcl
resource "aws_dynamodb_table" "global" {
  name           = "my-table"
  hash_key       = "id"
  billing_mode   = "PAY_PER_REQUEST"
  
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"
  
  replica {
    region_name = "eu-west-1"
  }
  
  replica {
    region_name = "ap-southeast-1"
  }
}
```

Global Tables in 2019 gave you multi-master replication with last-writer-wins conflict resolution. Great for session data, feature flags, idempotent writes. Terrible for "bank account balance" without careful design.

## Application layer: regions are not invisible

### Detect where users should go

```javascript
// Detect user region
function getUserRegion() {
    // Use CloudFront headers
    const cloudFrontViewerCountry = req.headers['cloudfront-viewer-country'];
    
    // Or use geolocation API
    const ip = req.ip;
    const region = geolocate(ip);
    
    return mapCountryToRegion(region);
}

// Route to appropriate region
function routeToRegion(region) {
    const regionEndpoints = {
        'us-east-1': 'https://api-us.example.com',
        'eu-west-1': 'https://api-eu.example.com',
        'ap-southeast-1': 'https://api-ap.example.com'
    };
    
    return regionEndpoints[region] || regionEndpoints['us-east-1'];
}
```

CloudFront viewer headers are cheap and surprisingly good for routing decisions at the edge.

### Syncing data between regions (the hard part)

```javascript
// Sync data between regions
async function syncData(sourceRegion, targetRegion) {
    const sourceData = await fetchFromRegion(sourceRegion);
    await writeToRegion(targetRegion, sourceData);
}

// Event-driven sync
async function handleDataChange(event) {
    const regions = ['us-east-1', 'eu-west-1', 'ap-southeast-1'];
    
    await Promise.all(
        regions
            .filter(region => region !== event.region)
            .map(region => syncData(event.region, region))
    );
}
```

Event-driven replication beats batch cron jobs for most user-facing data—until events duplicate, reorder, or conflict. Design for idempotency.

## CloudFront: one URL, multiple origins

```hcl
resource "aws_cloudfront_distribution" "multi_region" {
  origin {
    domain_name = aws_lb.primary.dns_name
    origin_id   = "primary"
    
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  
  origin {
    domain_name = aws_lb.secondary.dns_name
    origin_id   = "secondary"
    
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  
  default_cache_behavior {
    target_origin_id       = "primary"
    viewer_protocol_policy = "redirect-to-https"
    
    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]
    
    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }
  
  # Failover to secondary
  ordered_cache_behavior {
    path_pattern     = "*"
    target_origin_id = "secondary"
    viewer_protocol_policy = "redirect-to-https"
    
    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]
  }
}
```

CloudFront origin failover groups (newer than some of this config) simplify primary/secondary origin health. The principle holds: edge caches content, origins fail over without users learning your region names.

## Health checks that Route 53 can trust

```javascript
// Health check endpoint
app.get('/health', async (req, res) => {
    const health = {
        status: 'healthy',
        region: process.env.AWS_REGION,
        timestamp: new Date().toISOString(),
        checks: {
            database: await checkDatabase(),
            cache: await checkCache(),
            storage: await checkStorage()
        }
    };
    
    const isHealthy = Object.values(health.checks).every(check => check.status === 'ok');
    
    res.status(isHealthy ? 200 : 503).json(health);
});

// Route 53 health check
const healthCheck = {
    type: 'HTTP',
    resourcePath: '/health',
    requestInterval: 30,
    failureThreshold: 3
};
```

A `/health` that always returns 200 is lying to DNS. Check dependencies that matter for serving traffic. Don't check dependencies that create cascading false negatives.

## Disaster recovery: RTO, RPO, and backups that cross borders

**RTO** — how long until you're back. **RPO** — how much data you can lose.

Define these before architecture, not during the outage.

```bash
# Automated backups
aws rds create-db-snapshot \
  --db-instance-identifier mydb \
  --db-snapshot-identifier mydb-backup-$(date +%Y%m%d)

# Copy to another region
aws rds copy-db-snapshot \
  --source-db-snapshot-identifier mydb-backup-20190101 \
  --target-db-snapshot-identifier mydb-backup-20190101 \
  --source-region us-east-1 \
  --target-region eu-west-1
```

Snapshots in another region are insurance. Restoring from them should be practiced quarterly, not discovered to take six hours when you need two.

## What we wish we'd known earlier

**Route 53 failover only works if health checks reflect reality.** Test failover by failing things on purpose.

**Replicate data, but know replication lag.** Your RPO is lag, not wishful thinking.

**Run DR drills.** The runbook nobody has executed is fiction.

**Automate failover where RTO demands it.** Manual promotion at 3am adds hours and typos.

**Document procedures in runbooks humans can follow tired.** "Call Dave" is not a runbook.

**Multi-region costs money.** Right-size standby regions; cold standby is cheaper than hot if RTO allows.

**Compliance drives architecture sometimes.** Build for residency requirements early; retrofitting is painful.

## Start active-passive, prove failover, then evolve

Multi-region isn't a badge. It's a set of tradeoffs: cost, complexity, consistency, and how much downtime you can afford.

Begin with a secondary region that has replicated data and a tested promotion path. Add latency routing when users spread globally. Move toward active-active only when you understand write conflicts and have the data layer to support them.

The goal isn't two of everything. The goal is **surviving the day your primary region isn't boring**—without improvising infrastructure from a hotel Wi-Fi connection.

We learned that the hard way so you might not have to.

---

*Written June 2019, covering Route 53 failover/latency routing, RDS cross-region replicas, S3 CRR, and DynamoDB Global Tables. AWS multi-region patterns and services (Global Accelerator, Aurora Global Database, etc.) have expanded since; DR discipline and honest RTO/RPO math remain non-negotiable.*

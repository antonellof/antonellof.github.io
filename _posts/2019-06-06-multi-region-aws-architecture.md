---
layout: post
title: "Building a Multi-Region AWS Architecture"
date: 2019-06-06
categories: [Architecture]
tags: [AWS, Multi-Region, High Availability]
excerpt: "Design multi-region AWS architectures for high availability and disaster recovery. Learn about Route 53, CloudFront, RDS Multi-AZ, S3 cross-region replication, and failover strategies."
---

Multi-region architectures provide high availability and disaster recovery. After building production multi-region systems, here's how to architect them effectively.

## Why Multi-Region?

Benefits:
- **High availability** - Survive region failures
- **Disaster recovery** - RTO/RPO targets
- **Low latency** - Serve users from nearby regions
- **Compliance** - Data residency requirements

## Architecture Patterns

### Active-Passive

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

### Active-Active

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

## Route 53 Configuration

### Failover Routing

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

### Latency-Based Routing

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

## RDS Multi-Region

### Cross-Region Read Replicas

```bash
# Create read replica in another region
aws rds create-db-instance-read-replica \
  --db-instance-identifier mydb-replica \
  --source-db-instance-identifier arn:aws:rds:us-east-1:123456789012:db:mydb \
  --db-instance-class db.t3.medium \
  --availability-zone eu-west-1a
```

### Failover Configuration

```bash
# Promote read replica to standalone
aws rds promote-read-replica \
  --db-instance-identifier mydb-replica

# Update application to use new endpoint
```

### Terraform Configuration

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

## S3 Cross-Region Replication

### Replication Configuration

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

### Terraform Configuration

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

## DynamoDB Global Tables

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

## Application Layer

### Region Detection

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

### Data Synchronization

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

## CloudFront Distribution

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

## Health Checks

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

## Disaster Recovery

### RTO/RPO Targets

- **RTO (Recovery Time Objective)**: Time to restore service
- **RPO (Recovery Point Objective)**: Maximum data loss

### Backup Strategy

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

## Best Practices

1. **Use Route 53** - For DNS failover
2. **Replicate data** - Cross-region backups
3. **Test failover** - Regular DR drills
4. **Monitor health** - Health checks
5. **Automate failover** - Reduce RTO
6. **Document procedures** - Runbooks
7. **Cost optimization** - Right-size resources
8. **Compliance** - Data residency

## Conclusion

Multi-region architectures provide:
- High availability
- Disaster recovery
- Low latency
- Compliance

Start with active-passive, then evolve to active-active. The patterns shown here handle production workloads.

---

*Multi-region AWS architecture from June 2019, covering production patterns.*

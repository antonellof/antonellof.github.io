---
layout: post
title: "AWS Cost Optimization: Strategies for Reducing Cloud Spending"
date: 2019-03-01
categories: [Deep Dive]
tags: [AWS, Cost Optimization, Cloud]
excerpt: "Our AWS bill once looked like a phone number nobody dialed on purpose. Here's how we cut 30-50% without pretending microservices were the problem."
---

The CFO didn't say "cloud is expensive." He said it while sliding a printout across the table that had more digits than our seed round.

We'd done everything right—or so we thought. Auto Scaling was on. We used managed services. Nobody was mining Bitcoin in the staging account (we checked). And yet the bill climbed every month like it had its own growth KPI.

AWS doesn't send you a bill for "being in the cloud." It sends you a itemized receipt for **every resource you forgot existed**. The good news: that's also where the savings live. After optimizing spend across a few organizations, we consistently found **30-50% reduction** without heroic rewrites—mostly by stopping waste, right-sizing what remained, and picking the right pricing model for each workload.

## You can't optimize what you can't see

Before you terminate anything (tempting), understand where money goes.

### Cost Explorer

```bash
# Enable Cost Explorer API
aws ce get-cost-and-usage \
  --time-period Start=2019-01-01,End=2019-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost
```

### Break down by service

```bash
# Get costs by service
aws ce get-cost-and-usage \
  --time-period Start=2019-01-01,End=2019-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=SERVICE
```

The first time you run this, prepare for surprises. NAT Gateways, idle load balancers, and "temporary" RDS instances from a hackathon six months ago are all popular villains.

Tag everything—`Environment`, `Team`, `Project`—so Cost Explorer can answer "who did this?" and not just "what did this?"

## EC2: where the big numbers usually live

### Right-sizing (stop paying for CPUs that nap)

Most instances are oversized because someone picked `m5.xlarge` once and nobody revisited it. CloudWatch tells the truth:

```bash
# Use CloudWatch metrics to analyze
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-1234567890abcdef0 \
  --start-time 2019-01-01T00:00:00Z \
  --end-time 2019-01-31T23:59:59Z \
  --period 3600 \
  --statistics Average,Maximum
```

Rough heuristics that work surprisingly well:
- Average CPU under 20% for weeks → try a smaller instance
- Sustained CPU over 80% → upsize (yes, optimization sometimes means spending more on the thing that matters)
- Memory-bound workloads need memory metrics, not CPU alone—don't downsize your database because CPU looks fine while you're swapping into oblivion

Right-sizing alone often yields **20-30% savings** on compute.

### Reserved Instances (commitment discount for grown-ups)

If a workload runs 24/7 and will for the next year, On-Demand pricing is a luxury:

```bash
# Purchase Reserved Instances
aws ec2 purchase-reserved-instances-offering \
  --reserved-instances-offering-id <offering-id> \
  --instance-count 10 \
  --limit-price Amount=1000.00,CurrencyCode=USD
```

Typical savings in 2019:
- 1-year term: 30-40% off On-Demand
- 3-year term: 50-60% off
- Convertible RIs: more flexibility, slightly less discount

Buy RIs for your **baseline** capacity, not peak. Burst with On-Demand or Spot.

### Spot Instances (cheap compute that might vanish)

```bash
# Request spot instances
aws ec2 request-spot-instances \
  --spot-price "0.10" \
  --instance-count 5 \
  --type "one-time" \
  --launch-specification file://specification.json
```

Perfect for:
- Batch processing and ETL
- CI/CD workers (build failed because Spot reclaimed? Re-run the job.)
- Data pipelines
- Dev/test environments where interruption is annoying, not catastrophic

Never run your primary database on Spot unless you're writing a case study about downtime.

### Auto Scaling (match capacity to reality)

```bash
# Create auto scaling group
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name my-asg \
  --min-size 2 \
  --max-size 10 \
  --desired-capacity 4 \
  --launch-configuration-name my-launch-config \
  --vpc-zone-identifier "subnet-123,subnet-456"
```

Scale down at 3am when traffic is a flat line. Scale up for Monday morning. Teams that leave `desired-capacity` frozen at peak all week are subsidizing AWS's yacht fund. Expect **30-50% savings** on variable workloads.

## Storage: the quiet budget killer

### S3 lifecycle policies (data gets old; your bill shouldn't pretend it's new)

```json
{
  "Rules": [
    {
      "Id": "Move to Glacier",
      "Status": "Enabled",
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER"
        }
      ]
    },
    {
      "Id": "Delete old versions",
      "Status": "Enabled",
      "NoncurrentVersionTransitions": [
        {
          "NoncurrentDays": 30,
          "StorageClass": "GLACIER"
        }
      ],
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 365
      }
    }
  ]
}
```

Not every object needs Standard storage forever. Logs from 2017 can live in Glacier. Lifecycle rules automate the decision so nobody has to remember.

### EBS: volumes, types, and snapshot hoarding

```bash
# Use gp3 instead of gp2
aws ec2 create-volume \
  --volume-type gp3 \
  --size 100 \
  --iops 3000 \
  --throughput 125

# Delete unused snapshots
aws ec2 describe-snapshots \
  --owner-ids self \
  --query 'Snapshots[?StartTime<`2019-01-01`].[SnapshotId,StartTime]' \
  --output table
```

Unattached EBS volumes are money on fire. Snapshots accumulate like browser tabs—delete what you don't need.

Automate snapshot cleanup:

```bash
#!/bin/bash
# Delete snapshots older than 30 days
SNAPSHOTS=$(aws ec2 describe-snapshots \
  --owner-ids self \
  --query 'Snapshots[?StartTime<`'$(date -d '30 days ago' -u +%Y-%m-%dT%H:%M:%S)'`].SnapshotId' \
  --output text)

for snapshot in $SNAPSHOTS; do
  aws ec2 delete-snapshot --snapshot-id $snapshot
done
```

Storage optimization routinely delivers **40-60% savings** on the storage line item—often more impactful than shaving instance sizes.

## Databases: expensive by design, optimizable by discipline

### RDS right-sizing

```bash
# Analyze RDS metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=mydb \
  --start-time 2019-01-01T00:00:00Z \
  --end-time 2019-01-31T23:59:59Z \
  --period 3600 \
  --statistics Average,Maximum
```

RDS is easy to oversize and scary to undersize. Watch CPU, memory, IOPS, and connection count. Read replicas can offload read-heavy traffic cheaper than upsizing the primary—for the right query patterns.

### DynamoDB: provisioned vs on-demand

```bash
# Enable auto-scaling
aws application-autoscaling register-scalable-target \
  --service-namespace dynamodb \
  --resource-id table/my-table \
  --scalable-dimension dynamodb:table:ReadCapacityUnits \
  --min-capacity 5 \
  --max-capacity 100
```

In 2019, DynamoDB on-demand was still new. Rule of thumb:
- **Spiky, unpredictable traffic** → on-demand (pay per request)
- **Steady, predictable traffic** → provisioned with auto-scaling
- **TTL** for data that should expire anyway—free cleanup beats batch deletes

## Network: data transfer adds up fast

### CloudFront (cache at the edge, pay less for egress)

```bash
# Create CloudFront distribution
aws cloudfront create-distribution \
  --distribution-config file://cloudfront-config.json
```

Serving static assets and cacheable API responses from edge locations cuts data transfer costs and makes users happier. Two wins, one config.

### VPC endpoints (stop paying NAT to reach S3)

```bash
# Create VPC endpoint for S3
aws ec2 create-vpc-endpoint \
  --vpc-id vpc-12345678 \
  --service-name com.amazonaws.us-east-1.s3 \
  --route-table-ids rtb-12345678
```

Traffic to S3 through a NAT Gateway is a tax on architecture. Gateway endpoints for S3 and DynamoDB are the boring fix that finance teams love.

## Guardrails: catch surprises before the CFO does

### Cost anomaly detection

```bash
# Create cost anomaly detector
aws ce create-anomaly-detector \
  --anomaly-detector-name cost-anomaly-detector \
  --anomaly-detector-type DIMENSIONAL \
  --monitor-dimension SERVICE
```

### Budget alerts

```json
{
  "BudgetName": "monthly-budget",
  "BudgetLimit": {
    "Amount": "1000",
    "Unit": "USD"
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "Service": ["Amazon Elastic Compute Cloud - Compute"]
  },
  "CalculatedSpend": {
    "ActualSpend": {
      "Amount": "0",
      "Unit": "USD"
    }
  },
  "NotificationsWithSubscribers": [
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 80
      },
      "Subscribers": [
        {
          "SubscriptionType": "EMAIL",
          "Address": "team@example.com"
        }
      ]
    }
  ]
}
```

Alert at 80% of budget, not 100%. By then you're already explaining things in meetings.

## The cleanup playbook (in order of satisfaction)

**This week—quick wins that feel like finding cash in old jeans:**
Delete unattached EBS volumes. Release Elastic IPs sitting in limbo. Remove old snapshots. Terminate stopped instances (stopped still costs for attached storage). Delete unused load balancers and security groups from projects that shipped and vanished.

**Next two weeks—structural fixes:**
Right-size EC2 and RDS. Purchase Reserved Instances for steady workloads. Enable S3 lifecycle policies. Turn on Auto Scaling where traffic varies. Move batch jobs to Spot.

**This quarter—habits that stick:**
Migrate to newer instance families (better price/performance). Implement tagging and cost allocation. Review architecture for serverless fits (Lambda isn't free, but it can be cheaper than idle EC2). Schedule monthly cost reviews with service owners, not just finance.

## Automate the boring revenge

Humans forget. Scripts don't:

```python
import boto3
from datetime import datetime

def cleanup_unused_resources():
    ec2 = boto3.client('ec2')
    
    # Find unattached volumes
    volumes = ec2.describe_volumes(
        Filters=[{'Name': 'status', 'Values': ['available']}]
    )
    
    for volume in volumes['Volumes']:
        age = (datetime.now() - volume['CreateTime'].replace(tzinfo=None)).days
        if age > 30:
            print(f"Deleting unused volume: {volume['VolumeId']}")
            ec2.delete_volume(VolumeId=volume['VolumeId'])
    
    # Find unattached elastic IPs
    addresses = ec2.describe_addresses()
    for address in addresses['Addresses']:
        if 'InstanceId' not in address:
            print(f"Releasing unattached IP: {address['PublicIp']}")
            ec2.release_address(AllocationId=address['AllocationId'])
```

Run this weekly in a sandbox first. Then production. Then sleep slightly better.

## Habits that keep the bill honest

Check Cost Explorer regularly—not quarterly when someone asks awkward questions. Set budgets with alerts. Tag resources at creation (retroactive tagging is archaeology). Right-size based on metrics, not vibes. Match pricing models to workload personality: On-Demand for experiments, RIs for baselines, Spot for fault-tolerant batch. Review storage lifecycle and snapshot policies like you'd review database backups.

Cost optimization isn't a one-time project. It's hygiene—like dependency updates, except finance notices when you skip it.

## Realistic savings expectations

| Lever | Typical impact |
|-------|----------------|
| Right-sizing | 20-30% on compute |
| Reserved Instances | 30-40% on committed workloads |
| Storage lifecycle | 40-60% on object storage |
| Auto Scaling | 30-50% on variable traffic |
| **Combined program** | **30-50% overall** |

Your mileage varies. A batch-heavy analytics shop saves differently than a steady-state SaaS API. The pattern holds: **waste first, then right-size, then commit.**

## The point

AWS will happily charge you for every resource until the heat death of the universe. Your job is to run what you need, in the size you need, for as long as you need—no longer.

Start with the quick wins this afternoon. They're satisfying, low-risk, and fund the harder conversations about architecture. The CFO's printout doesn't have to be a recurring meeting.

---

*Written March 2019, covering AWS Cost Explorer, Reserved/Spot pricing, and pre-Graviton-era instance families. Pricing models and instance types have evolved; the discipline of measure → eliminate waste → right-size → commit remains unchanged.*

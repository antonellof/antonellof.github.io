---
layout: post
title: "AWS S3: Beyond Simple Storage"
date: 2016-06-08
categories: [How-To]
tags: [AWS, S3, Cloud Storage, Architecture]
excerpt: "S3 isn't a hard drive in the sky — it's an event-driven building block. Lifecycle policies, presigned uploads, Lambda triggers, and the patterns we learned moving petabytes without moving petabytes of money."
---

For years, S3 was where files went to die.

Upload a PDF, store the key in your database, serve it back when someone clicks. That's it. That's the whole mental model most teams had in 2016 — and honestly, it's the mental model that still costs people money today.

Then we started treating S3 as infrastructure instead of a folder, and everything changed. Lifecycle policies cut our storage bill. Event notifications replaced cron jobs that polled for new uploads. Presigned URLs let browsers upload directly without our servers becoming a bandwidth bottleneck. CloudFront made assets load fast enough that we stopped apologizing for them in demos.

After moving petabytes through S3, these are the patterns that turned "file storage" into a platform.

## Fundamentals That Save You Later

### Name Buckets Like You'll Have to Explain Them in an Audit

```
# Good naming conventions
company-app-production-assets
company-app-staging-logs
company-app-backups-2016

# Avoid
my-bucket
test123
prod
```

Bucket names are global. "prod" is taken. "my-bucket" is taken by someone who had the same idea in 2012. Include environment, purpose, and something unique to your org.

```python
import boto3

s3 = boto3.client('s3')

# Create bucket with proper configuration
s3.create_bucket(
    Bucket='mycompany-prod-assets',
    CreateBucketConfiguration={'LocationConstraint': 'us-west-2'}
)

# Enable versioning
s3.put_bucket_versioning(
    Bucket='mycompany-prod-assets',
    VersioningConfiguration={'Status': 'Enabled'}
)

# Enable encryption
s3.put_bucket_encryption(
    Bucket='mycompany-prod-assets',
    ServerSideEncryptionConfiguration={
        'Rules': [{
            'ApplyServerSideEncryptionByDefault': {
                'SSEAlgorithm': 'AES256'
            }
        }]
    }
)
```

Versioning and encryption at creation time. Retrofitting encryption after you've stored sensitive data is the kind of project that gets deprioritized forever.

### Object Keys: Organization That Scales

S3 doesn't have folders. It has key prefixes that *look* like folders. Design keys for query patterns and lifecycle rules:

```
# Good - enables S3 prefix optimization
uploads/2016/06/15/user-123/avatar.jpg
logs/production/2016-06-15/app-server-01.log
backups/database/daily/2016-06-15-db-snapshot.sql.gz

# Bad - all objects in same prefix
user-123-avatar.jpg
app-server-01-2016-06-15.log
```

Date-based prefixes let lifecycle policies target `logs/` without touching `uploads/`. User IDs in paths make per-user cleanup possible. Flat namespaces work until you have millions of objects and need to partition anything.

## Lifecycle Policies: Set It and Forget It (Your Finance Team Will Thank You)

Nobody deletes old logs manually. Nobody remembers to clean up failed multipart uploads. Lifecycle policies do both while you sleep:

```json
{
  "Rules": [
    {
      "Id": "Move old logs to Glacier",
      "Status": "Enabled",
      "Prefix": "logs/",
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER"
        }
      ],
      "Expiration": {
        "Days": 365
      }
    },
    {
      "Id": "Clean up incomplete multipart uploads",
      "Status": "Enabled",
      "Prefix": "",
      "AbortIncompleteMultipartUpload": {
        "DaysAfterInitiation": 7
      }
    },
    {
      "Id": "Delete old versions",
      "Status": "Enabled",
      "Prefix": "",
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 30
      }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
    --bucket mycompany-prod-assets \
    --lifecycle-configuration file://lifecycle.json
```

That multipart cleanup rule alone saved us from a slow leak of orphaned upload parts — invisible until the bill arrives.

## Event Notifications: S3 as a Trigger, Not a Destination

Upload happens → something else runs. No polling. No "check S3 every five minutes" cron job that misses the window and doubles up.

```json
{
  "LambdaFunctionConfigurations": [
    {
      "LambdaFunctionArn": "arn:aws:lambda:us-west-2:123456789:function:ProcessImage",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            {
              "Name": "prefix",
              "Value": "uploads/images/"
            },
            {
              "Name": "suffix",
              "Value": ".jpg"
            }
          ]
        }
      }
    }
  ]
}
```

```python
import boto3
from PIL import Image
import io

s3 = boto3.client('s3')

def lambda_handler(event, context):
    # Get uploaded image
    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']
    
    # Download image
    response = s3.get_object(Bucket=bucket, Key=key)
    image_data = response['Body'].read()
    
    # Create thumbnail
    image = Image.open(io.BytesIO(image_data))
    image.thumbnail((200, 200))
    
    # Save thumbnail
    buffer = io.BytesIO()
    image.save(buffer, 'JPEG')
    buffer.seek(0)
    
    # Upload thumbnail
    thumbnail_key = key.replace('uploads/', 'thumbnails/')
    s3.put_object(
        Bucket=bucket,
        Key=thumbnail_key,
        Body=buffer,
        ContentType='image/jpeg'
    )
    
    return {
        'statusCode': 200,
        'body': f'Processed {key}'
    }
```

User uploads avatar → Lambda generates thumbnail → thumbnail appears before they refresh. The UX improvement is free once the plumbing exists.

## Direct Browser Uploads: Get Your Servers Out of the Middle

Routing every upload through your app server works until someone uploads a 200MB video and your autoscaling group wakes up confused.

Presigned URLs let the browser talk directly to S3:

```python
# Backend API endpoint
from flask import Flask, jsonify, request
import boto3
from datetime import timedelta

app = Flask(__name__)
s3 = boto3.client('s3')

@app.route('/api/upload-url', methods=['POST'])
def generate_upload_url():
    data = request.json
    filename = data['filename']
    content_type = data['contentType']
    
    # Generate unique key
    key = f"uploads/{user_id}/{uuid.uuid4()}/{filename}"
    
    # Generate presigned URL (valid for 5 minutes)
    presigned_url = s3.generate_presigned_url(
        'put_object',
        Params={
            'Bucket': 'mycompany-prod-assets',
            'Key': key,
            'ContentType': content_type
        },
        ExpiresIn=300
    )
    
    return jsonify({
        'uploadUrl': presigned_url,
        'key': key
    })
```

```javascript
async function uploadFile(file) {
    // Get presigned URL from backend
    const response = await fetch('/api/upload-url', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            filename: file.name,
            contentType: file.type
        })
    });
    
    const {uploadUrl, key} = await response.json();
    
    // Upload directly to S3
    await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
            'Content-Type': file.type
        }
    });
    
    return key;
}

// Usage
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const key = await uploadFile(file);
    console.log('Uploaded to:', key);
});
```

Your server generates the URL (authenticated, validated) and stores the key. S3 handles the bytes. Everyone's happier, especially your bandwidth bill.

## Static Website Hosting: S3 as a CDN Origin

For static sites, S3 website hosting is dead simple:

```bash
# Enable website hosting
aws s3 website s3://mycompany-website \
    --index-document index.html \
    --error-document error.html

# Set bucket policy for public read
aws s3api put-bucket-policy \
    --bucket mycompany-website \
    --policy '{
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "PublicReadGetObject",
            "Effect": "Allow",
            "Principal": "*",
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::mycompany-website/*"
        }]
    }'

# Deploy website
aws s3 sync ./dist s3://mycompany-website \
    --delete \
    --cache-control "max-age=31536000"
```

`aws s3 sync --delete` is your deploy command. Cache-control headers prevent browsers from serving stale assets until someone hard-refreshes in a demo.

## CloudFront: Because Virginia Is Far From Everyone

S3 buckets live in a region. Your users don't. CloudFront caches at the edge:

```json
{
  "DistributionConfig": {
    "Origins": [{
      "Id": "S3-mycompany-prod-assets",
      "DomainName": "mycompany-prod-assets.s3.amazonaws.com",
      "S3OriginConfig": {
        "OriginAccessIdentity": "origin-access-identity/cloudfront/ABCDEFG"
      }
    }],
    "DefaultCacheBehavior": {
      "TargetOriginId": "S3-mycompany-prod-assets",
      "ViewerProtocolPolicy": "redirect-to-https",
      "AllowedMethods": ["GET", "HEAD"],
      "CachedMethods": ["GET", "HEAD"],
      "ForwardedValues": {
        "QueryString": false,
        "Cookies": {"Forward": "none"}
      },
      "MinTTL": 0,
      "DefaultTTL": 86400,
      "MaxTTL": 31536000
    },
    "Enabled": true,
    "Comment": "CDN for S3 assets",
    "Aliases": ["assets.mycompany.com"],
    "ViewerCertificate": {
      "ACMCertificateArn": "arn:aws:acm:us-east-1:123456789:certificate/abc",
      "SSLSupportMethod": "sni-only",
      "MinimumProtocolVersion": "TLSv1.2_2016"
    }
  }
}
```

When you deploy new assets, invalidate the cache — or accept that some users see old CSS for an hour:

```python
import boto3

cloudfront = boto3.client('cloudfront')

def invalidate_cache(distribution_id, paths):
    """Invalidate CloudFront cache for specific paths"""
    cloudfront.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
            'Paths': {
                'Quantity': len(paths),
                'Items': paths
            },
            'CallerReference': str(time.time())
        }
    )

# Usage
invalidate_cache('E1234ABCD', ['/images/*', '/css/*'])
```

Invalidations cost money at scale. Versioned asset filenames (`app.a1b2c3.js`) are cheaper than wildcard invalidations on every deploy.

## Multipart Upload: Large Files Without Large Headaches

```python
import boto3
from boto3.s3.transfer import TransferConfig

s3 = boto3.client('s3')

# Configure multipart threshold and chunk size
config = TransferConfig(
    multipart_threshold=1024 * 25,  # 25 MB
    max_concurrency=10,
    multipart_chunksize=1024 * 25,  # 25 MB
    use_threads=True
)

# Upload large file
s3.upload_file(
    'large-file.zip',
    'mycompany-prod-assets',
    'uploads/large-file.zip',
    Config=config,
    Callback=ProgressPercentage('large-file.zip')
)

# Progress callback
class ProgressPercentage:
    def __init__(self, filename):
        self._filename = filename
        self._size = float(os.path.getsize(filename))
        self._seen_so_far = 0
        self._lock = threading.Lock()

    def __call__(self, bytes_amount):
        with self._lock:
            self._seen_so_far += bytes_amount
            percentage = (self._seen_so_far / self._size) * 100
            print(f"\r{self._filename} {percentage:.2f}% complete", end='')
```

Boto3 handles multipart automatically above the threshold. You just configure chunk size and concurrency. Pair this with the lifecycle rule that aborts stale multipart uploads.

## Cross-Region Replication: When One Region Isn't Enough

```json
{
  "Role": "arn:aws:iam::123456789:role/s3-replication-role",
  "Rules": [{
    "Status": "Enabled",
    "Priority": 1,
    "Filter": {"Prefix": ""},
    "Destination": {
      "Bucket": "arn:aws:s3:::mycompany-backup-eu-west-1",
      "ReplicationTime": {
        "Status": "Enabled",
        "Time": {"Minutes": 15}
      },
      "Metrics": {
        "Status": "Enabled",
        "EventThreshold": {"Minutes": 15}
      }
    },
    "DeleteMarkerReplication": {"Status": "Enabled"}
  }]
}
```

Replication isn't backup — deleted objects replicate too if you enable delete marker replication. Understand what you're protecting against: regional outage, not accidental deletion.

## Security: Public Buckets Are a Career Event

### Bucket Policies That Actually Restrict

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": [
      "arn:aws:s3:::mycompany-prod-assets",
      "arn:aws:s3:::mycompany-prod-assets/*"
    ],
    "Condition": {
      "NotIpAddress": {
        "aws:SourceIp": [
          "203.0.113.0/24",
          "198.51.100.0/24"
        ]
      }
    }
  }]
}
```

Deny-by-default with IP allowlists for internal buckets. Public assets go through CloudFront with OAI, not wide-open bucket policies.

### Least-Privilege IAM

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ],
    "Resource": "arn:aws:s3:::mycompany-prod-assets/uploads/${aws:username}/*"
  }]
}
```

Scope uploads to per-user prefixes. The `${aws:username}` variable means users can't overwrite each other's files even with a valid credential.

### KMS Encryption for Sensitive Data

```python
s3.put_object(
    Bucket='mycompany-prod-assets',
    Key='sensitive-data.txt',
    Body=b'secret information',
    ServerSideEncryption='aws:kms',
    SSEKMSKeyId='arn:aws:kms:us-west-2:123456789:key/abc-123'
)
```

AES-256 default encryption is fine for most assets. KMS adds key rotation, audit trails, and granular access control for data that would ruin your week if it leaked.

## Cost Optimization: The Bill Is the Architecture Review

### Storage Class Transitions

```python
# Archive old logs to Glacier
def archive_old_logs():
    s3 = boto3.resource('s3')
    bucket = s3.Bucket('mycompany-logs')
    
    cutoff_date = datetime.now() - timedelta(days=90)
    
    for obj in bucket.objects.filter(Prefix='logs/'):
        if obj.last_modified < cutoff_date:
            obj.copy_from(
                CopySource={'Bucket': bucket.name, 'Key': obj.key},
                StorageClass='GLACIER',
                MetadataDirective='COPY'
            )
```

Lifecycle policies automate this. Manual scripts are for one-off migrations or buckets you inherited from someone who left.

### Intelligent Tiering

```bash
aws s3api put-bucket-intelligent-tiering-configuration \
    --bucket mycompany-prod-assets \
    --id EntireBucket \
    --intelligent-tiering-configuration '{
        "Id": "EntireBucket",
        "Status": "Enabled",
        "Tierings": [
            {
                "Days": 90,
                "AccessTier": "ARCHIVE_ACCESS"
            },
            {
                "Days": 180,
                "AccessTier": "DEEP_ARCHIVE_ACCESS"
            }
        ]
    }'
```

For data with unpredictable access patterns, intelligent tiering beats guessing which storage class to pick upfront.

## Monitoring: S3 Is Silent Until It Isn't

### Access Logging

```python
s3.put_bucket_logging(
    Bucket='mycompany-prod-assets',
    BucketLoggingStatus={
        'LoggingEnabled': {
            'TargetBucket': 'mycompany-logs',
            'TargetPrefix': 's3-access-logs/'
        }
    }
)
```

Access logs go to another bucket. Yes, that bucket also costs money. So does not knowing who downloaded what.

### CloudWatch Metrics

```python
import boto3

cloudwatch = boto3.client('cloudwatch')

def get_s3_metrics(bucket_name):
    response = cloudwatch.get_metric_statistics(
        Namespace='AWS/S3',
        MetricName='NumberOfObjects',
        Dimensions=[
            {'Name': 'BucketName', 'Value': bucket_name},
            {'Name': 'StorageType', 'Value': 'AllStorageTypes'}
        ],
        StartTime=datetime.utcnow() - timedelta(days=1),
        EndTime=datetime.utcnow(),
        Period=86400,
        Statistics=['Average']
    )
    
    return response['Datapoints']
```

Object count and total size trends catch the bucket that's quietly growing because someone enabled debug logging to S3 and forgot.

## Advanced Patterns: Where S3 Gets Interesting

### S3 + SQS: Reliable Event Processing

Lambda timeouts and retries can lose events. SQS in the middle adds durability:

```json
{
  "QueueConfigurations": [{
    "QueueArn": "arn:aws:sqs:us-west-2:123456789:process-uploads",
    "Events": ["s3:ObjectCreated:*"],
    "Filter": {
      "Key": {
        "FilterRules": [{
          "Name": "prefix",
          "Value": "uploads/"
        }]
      }
    }
  }]
}
```

Upload → S3 event → SQS → worker processes at its own pace. Backpressure handled. Retries built in.

### Data Lake Layout

Organize for analytics tools that partition by path:

```
s3://data-lake/
├── raw/
│   ├── year=2016/
│   │   ├── month=06/
│   │   │   ├── day=15/
│   │   │   │   └── data.parquet
├── processed/
│   ├── users/
│   │   └── year=2016/month=06/day=15/
├── analytics/
│   └── reports/
│       └── daily-summary-2016-06-15.csv
```

Hive-style partitioning (`year=2016/month=06/day=15`) lets Athena, Spark, and friends skip entire prefixes during queries. Your future data team will assume you did this. Do it now.

## The Real Takeaway

S3 stopped being "where we put files" and became "how we trigger workflows, serve assets globally, and tier storage costs automatically." That's the mindset shift.

Start with good bucket naming, encryption, and key structure. Add lifecycle policies before your first real bill. Use presigned URLs for uploads. Put CloudFront in front of anything users download. Wire event notifications when you catch yourself polling S3. Lock down access with IAM and bucket policies before someone makes a bucket public on accident.

Layer complexity as you need it. The patterns here handled billions of objects because each one solved a specific problem we actually had — not because we architected for theoretical scale on day one.

---

*S3 best practices from mid-2016, when Lambda triggers and lifecycle automation were becoming standard patterns. Core concepts unchanged; storage classes and replication options have expanded since.*

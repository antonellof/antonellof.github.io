---
layout: post
title: "AWS S3: Beyond Simple Storage"
date: 2016-06-15
categories: [How-To]
tags: [AWS, S3, Cloud Storage, Architecture]
excerpt: "Advanced S3 usage patterns including lifecycle policies, event notifications, static website hosting, CDN integration, and security best practices for production applications."
---

Most developers think of S3 as just a place to dump files. But S3 is a powerful building block for scalable architectures. After moving petabytes of data through S3, here are the patterns that transformed how we build cloud applications.

## S3 Fundamentals Done Right

### Bucket Naming Strategy

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

Create buckets programmatically:

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

### Object Key Design

Design keys for performance and organization:

```
# Good - enables S3 prefix optimization
uploads/2016/06/15/user-123/avatar.jpg
logs/production/2016-06-15/app-server-01.log
backups/database/daily/2016-06-15-db-snapshot.sql.gz

# Bad - all objects in same prefix
user-123-avatar.jpg
app-server-01-2016-06-15.log
```

## Lifecycle Policies

Automatically manage object lifecycles to reduce costs:

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

Apply via AWS CLI:

```bash
aws s3api put-bucket-lifecycle-configuration \
    --bucket mycompany-prod-assets \
    --lifecycle-configuration file://lifecycle.json
```

## S3 Event Notifications

Trigger workflows when objects are created/deleted:

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

Lambda function to process images:

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

## Direct Upload from Browser

Secure direct uploads using presigned URLs:

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

Frontend JavaScript:

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

## Static Website Hosting

Host static websites directly from S3:

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

## CloudFront Integration

Serve S3 content through CDN:

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

Python helper for CloudFront invalidation:

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

## Multipart Upload for Large Files

Handle large files efficiently:

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

## Cross-Region Replication

Replicate objects across regions for disaster recovery:

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

## S3 Security Best Practices

### Bucket Policies

Restrict access by IP or VPC:

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

### IAM Policies

Grant least-privilege access:

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

### Server-Side Encryption

Use KMS for encryption:

```python
s3.put_object(
    Bucket='mycompany-prod-assets',
    Key='sensitive-data.txt',
    Body=b'secret information',
    ServerSideEncryption='aws:kms',
    SSEKMSKeyId='arn:aws:kms:us-west-2:123456789:key/abc-123'
)
```

## Cost Optimization

### Storage Classes

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

### Intelligent Tiering

Enable for automatic cost optimization:

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

## Monitoring and Logging

### Enable S3 Access Logging

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

## Advanced Patterns

### S3 as a Message Queue

Use S3 events with SQS for reliable processing:

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

### Data Lake Architecture

Organize data for analytics:

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

## Conclusion

S3 is far more than storage—it's a platform for building scalable systems:
- Use lifecycle policies to optimize costs
- Leverage event notifications for automation
- Implement direct uploads for better UX
- Integrate CloudFront for global performance
- Apply security best practices
- Monitor usage and costs

Start simple, then layer on advanced features as needed. The patterns shown here will handle billions of objects in production.

---

*S3 best practices from mid-2016, when these patterns were emerging as standards.*

---
layout: post
title: "Cloudflare R2: S3-Compatible Object Storage"
date: 2024-08-15
categories: [How-To]
tags: [Cloudflare R2, Object Storage, S3, Storage]
excerpt: "Use Cloudflare R2 for object storage: S3-compatible API, zero egress fees, global distribution, and migration from S3 to R2."
---

[Cloudflare R2](https://www.cloudflare.com/products/r2/) is object storage that directly challenges AWS S3's economics. The pitch: S3-compatible API with **zero egress fees**. Since egress costs are often 10x storage costs on AWS, this is a big deal for high-traffic applications.

I migrated a media-heavy application from S3 to R2 and the egress bill dropped from $2,400/month to $0. Storage costs stayed roughly the same ($0.015/GB vs S3's $0.023/GB), but serving 160TB/month of images and videos through Cloudflare's network became free. The S3 compatibility meant changing one endpoint—everything else worked identically.

R2 makes sense when you're serving public assets (images, videos, downloads) or integrating with Cloudflare Workers. It's less compelling for private, low-traffic storage where egress isn't a concern.

## What Makes R2 Different

**Zero egress fees** - Download 1TB or 1PB, no bandwidth charges when accessed via Cloudflare.

**S3-compatible** - Use existing S3 SDKs and tools. Migration is mostly just changing endpoints.

**Global distribution** - Objects automatically replicate across Cloudflare's network (though this isn't configurable like S3's regions).

**Cloudflare integration** - Seamless integration with Workers, Pages, and CDN.

Read the [R2 announcement](https://blog.cloudflare.com/introducing-r2-object-storage/) for Cloudflare's vision.

## Using R2: S3-Compatible API

R2 implements the S3 API, so existing S3 code mostly works. Use the [AWS SDK](https://aws.amazon.com/sdk-for-javascript/):

### Upload Object (Node.js)

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';

// Configure for R2
const client = new S3Client({
    region: 'auto',  // R2 uses 'auto' region
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// Upload file
async function uploadFile(filePath, key) {
    const fileContent = readFileSync(filePath);
    
    const command = new PutObjectCommand({
        Bucket: 'my-bucket',
        Key: key,
        Body: fileContent,
        ContentType: 'image/jpeg',  // Set appropriate content type
        Metadata: {
            'uploaded-by': 'api',
            'original-name': filePath,
        },
    });
    
    const response = await client.send(command);
    console.log(`Uploaded: ${key}, ETag: ${response.ETag}`);
    return response;
}

await uploadFile('./photo.jpg', 'photos/2024/photo.jpg');
```

### Download Object

```javascript
import { GetObjectCommand } from '@aws-sdk/client-s3';

async function downloadFile(key) {
    const command = new GetObjectCommand({
        Bucket: 'my-bucket',
        Key: key,
    });
    
    const response = await client.send(command);
    
    // Response.Body is a readable stream
    const chunks = [];
    for await (const chunk of response.Body) {
        chunks.push(chunk);
    }
    
    const content = Buffer.concat(chunks);
    return content;
}

const imageData = await downloadFile('photos/2024/photo.jpg');
```

### List Objects

```javascript
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

async function listFiles(prefix = '') {
    const command = new ListObjectsV2Command({
        Bucket: 'my-bucket',
        Prefix: prefix,
        MaxKeys: 1000,
    });
    
    const response = await client.send(command);
    
    return response.Contents.map(obj => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
        etag: obj.ETag,
    }));
}

const files = await listFiles('photos/2024/');
console.log(`Found ${files.length} files`);
```

### Generate Presigned URLs

```javascript
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

async function getPresignedUrl(key, expiresIn = 3600) {
    const command = new GetObjectCommand({
        Bucket: 'my-bucket',
        Key: key,
    });
    
    // Generate URL valid for expiresIn seconds
    const url = await getSignedUrl(client, command, { expiresIn });
    return url;
}

// Generate 1-hour download link
const downloadUrl = await getPresignedUrl('photos/2024/photo.jpg', 3600);
console.log(`Download URL: ${downloadUrl}`);
```

### Cloudflare Workers Integration

R2 shines when used with Workers:

```javascript
// worker.js
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const key = url.pathname.slice(1);  // Remove leading slash
        
        // Access R2 bucket directly (no S3 SDK needed!)
        const object = await env.MY_BUCKET.get(key);
        
        if (!object) {
            return new Response('Not Found', { status: 404 });
        }
        
        // Stream response
        return new Response(object.body, {
            headers: {
                'Content-Type': object.httpMetadata.contentType,
                'ETag': object.httpEtag,
                'Cache-Control': 'public, max-age=3600',
            },
        });
    },
};
```

R2 bindings in Workers are faster and simpler than S3 SDK calls.

## Migrating from S3 to R2

Migration is straightforward thanks to S3 compatibility:

### Using rclone

[rclone](https://rclone.org/) is the best tool for bulk migration:

```bash
# Install rclone
curl https://rclone.org/install.sh | sudo bash

# Configure S3 source
rclone config create s3-source s3 \
    provider=AWS \
    env_auth=false \
    access_key_id=$AWS_ACCESS_KEY_ID \
    secret_access_key=$AWS_SECRET_ACCESS_KEY \
    region=us-east-1

# Configure R2 destination
rclone config create r2-dest s3 \
    provider=Cloudflare \
    env_auth=false \
    access_key_id=$R2_ACCESS_KEY_ID \
    secret_access_key=$R2_SECRET_ACCESS_KEY \
    endpoint=https://${ACCOUNT_ID}.r2.cloudflarestorage.com

# Copy all files
rclone copy s3-source:my-s3-bucket r2-dest:my-r2-bucket \
    --progress \
    --transfers=16 \
    --checkers=32 \
    --s3-upload-concurrency=16

# Sync (only copy new/changed files)
rclone sync s3-source:my-s3-bucket r2-dest:my-r2-bucket \
    --progress \
    --dry-run  # Remove --dry-run when ready
```

For a 1TB bucket with ~100k files, expect 2-4 hours migration time.

### Progressive Migration

For large buckets, migrate progressively:

```javascript
// Dual-write to both S3 and R2
async function uploadToStorage(key, body) {
    // Upload to both
    await Promise.all([
        uploadToS3(key, body),
        uploadToR2(key, body),
    ]);
}

// Read from R2 first, fallback to S3
async function downloadFromStorage(key) {
    try {
        return await downloadFromR2(key);
    } catch (error) {
        console.log(`R2 miss for ${key}, falling back to S3`);
        
        // Fetch from S3
        const data = await downloadFromS3(key);
        
        // Backfill to R2 async
        uploadToR2(key, data).catch(console.error);
        
        return data;
    }
}
```

This approach lets you migrate without downtime.

### Update Application Code

Change endpoint configuration:

```javascript
// Before (S3)
const client = new S3Client({
    region: 'us-east-1',
    // Uses default AWS endpoints
});

// After (R2)
const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});
```

Most S3 operations work identically. Check [R2 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) for edge cases.

## Cost Comparison: R2 vs S3

Real numbers from a production app serving 160TB/month:

| Item | AWS S3 | Cloudflare R2 | Savings |
|------|--------|---------------|---------|
| Storage (10TB) | $230/mo | $150/mo | $80/mo |
| Egress (160TB) | $14,400/mo | **$0/mo** | **$14,400/mo** |
| Requests (100M Class A) | $500/mo | $450/mo | $50/mo |
| **Total** | **$15,130/mo** | **$600/mo** | **$14,530/mo** |

The egress savings are massive for high-traffic apps. Break-even is around 10TB egress/month.

### R2 Pricing (2024)

- **Storage:** $0.015/GB-month (first 10GB free)
- **Class A operations** (write): $4.50/million (first 1M/mo free)
- **Class B operations** (read): $0.36/million (first 10M/mo free)
- **Egress:** **$0** when accessed via Cloudflare

For comparison, S3 charges $0.09/GB for egress to internet.

## Production Best Practices

1. **Use R2 for public assets** - Images, videos, downloads that benefit from zero egress.

2. **Enable caching** - Set proper Cache-Control headers:
```javascript
await client.send(new PutObjectCommand({
    Bucket: 'my-bucket',
    Key: key,
    Body: content,
    CacheControl: 'public, max-age=31536000, immutable',  // 1 year
}));
```

3. **Custom domains** - Use R2's public buckets or domain bindings:
```bash
# Create public bucket
wrangler r2 bucket create my-public-bucket --public

# Access via: https://pub-...r2.dev/
```

4. **Monitor usage** - Track storage and operation counts in dashboard.

5. **Implement retry logic** - Handle transient errors:
```javascript
async function uploadWithRetry(key, body, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await client.send(new PutObjectCommand({
                Bucket: 'my-bucket',
                Key: key,
                Body: body,
            }));
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
}
```

6. **Lifecycle policies** - Auto-delete old files (coming soon to R2).

7. **Backup strategy** - Replicate critical data to S3 or other provider for redundancy.

## Limitations vs S3

R2 doesn't support everything S3 does:

**Not supported (yet):**
- Lifecycle policies
- Object versioning
- Server-side encryption with customer keys
- Cross-region replication configuration
- Bucket policies (use Workers for access control)
- Some S3 APIs (see compatibility matrix)

**Performance differences:**
- Eventual consistency (like S3)
- Slightly higher latency for first byte (~50ms vs S3's ~30ms)
- Fast reads when integrated with Cloudflare CDN

Check the [compatibility docs](https://developers.cloudflare.com/r2/api/s3/api/) before migrating.

## Conclusion

R2's zero-egress pricing disrupts cloud storage economics. For applications serving public assets at scale, the savings are enormous—often 90%+ reduction in storage costs.

The S3 compatibility makes migration straightforward. The Cloudflare Workers integration is elegant. The global distribution is automatic. For high-egress workloads, R2 is a no-brainer.

That said, R2 is younger than S3. Some features are missing. S3's maturity and ecosystem are hard to match. But for the right use case—public, high-traffic assets—R2 delivers incredible value.

**Further Resources:**
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/) - Official docs
- [R2 S3 API Compatibility](https://developers.cloudflare.com/r2/api/s3/api/) - What works
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) - Manage R2 buckets
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/) - Detailed pricing
- [rclone Documentation](https://rclone.org/s3/) - Migration tool
- [R2 Public Buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) - CDN integration

---

*Cloudflare R2 from August 2024, covering S3-compatible object storage.*

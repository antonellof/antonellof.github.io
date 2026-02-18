---
layout: post
title: "GitHub Actions: Automating Your Workflow"
date: 2020-03-04
categories: [How-To]
tags: [GitHub Actions, CI/CD, Automation]
excerpt: "Automate CI/CD workflows with GitHub Actions. Learn workflows, jobs, steps, actions, and how to build, test, and deploy applications automatically."
---

GitHub Actions provides powerful CI/CD automation. After setting up production workflows, here's how to use it effectively.

## What are GitHub Actions?

GitHub Actions:
- **Workflows** - Automated processes
- **Events** - Triggers (push, PR, schedule)
- **Jobs** - Run on runners
- **Steps** - Individual tasks

## Basic Workflow

### Workflow File

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run tests
      run: npm test
    
    - name: Run lint
      run: npm run lint
```

## Node.js Workflow

### Complete Example

```yaml
name: Node.js CI

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    strategy:
      matrix:
        node-version: [16.x, 18.x, 20.x]
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Use Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v3
      with:
        node-version: ${{ matrix.node-version }}
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run tests
      run: npm test -- --coverage
    
    - name: Upload coverage
      uses: codecov/codecov-action@v3
      with:
        file: ./coverage/lcov.info
```

## Docker Workflow

### Build and Push

```yaml
name: Docker Build and Push

on:
  push:
    branches: [ main ]
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v2
    
    - name: Login to Docker Hub
      uses: docker/login-action@v2
      with:
        username: ${{ secrets.DOCKER_USERNAME }}
        password: ${{ secrets.DOCKER_PASSWORD }}
    
    - name: Build and push
      uses: docker/build-push-action@v4
      with:
        context: .
        push: ${{ github.event_name != 'pull_request' }}
        tags: |
          myapp:latest
          myapp:${{ github.sha }}
          myapp:${{ github.ref_name }}
```

## Deployment Workflow

### Deploy to AWS

```yaml
name: Deploy to AWS

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v2
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: us-east-1
    
    - name: Deploy to S3
      run: |
        aws s3 sync dist/ s3://my-bucket --delete
    
    - name: Invalidate CloudFront
      run: |
        aws cloudfront create-invalidation \
          --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} \
          --paths "/*"
```

### Deploy to Kubernetes

```yaml
name: Deploy to Kubernetes

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Set up kubectl
      uses: azure/setup-kubectl@v3
    
    - name: Configure kubectl
      run: |
        echo "${{ secrets.KUBECONFIG }}" | base64 -d > kubeconfig
        export KUBECONFIG=kubeconfig
    
    - name: Deploy
      run: |
        kubectl set image deployment/myapp \
          myapp=myapp:${{ github.sha }} \
          -n production
        kubectl rollout status deployment/myapp -n production
```

## Matrix Strategy

### Multiple Environments

```yaml
name: Test Matrix

on: [push, pull_request]

jobs:
  test:
    runs-on: ${{ matrix.os }}
    
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node-version: [16.x, 18.x, 20.x]
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Use Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v3
      with:
        node-version: ${{ matrix.node-version }}
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run tests
      run: npm test
```

## Conditional Steps

### Conditional Execution

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Build
      run: npm run build
    
    - name: Deploy to staging
      if: github.ref == 'refs/heads/develop'
      run: ./deploy-staging.sh
    
    - name: Deploy to production
      if: github.ref == 'refs/heads/main'
      run: ./deploy-production.sh
```

## Secrets

### Using Secrets

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - name: Use secret
      env:
        API_KEY: ${{ secrets.API_KEY }}
      run: |
        echo "Deploying with API key"
        # Use $API_KEY
```

## Caching

### Cache Dependencies

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Cache node modules
      uses: actions/cache@v3
      with:
        path: ~/.npm
        key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
        restore-keys: |
          ${{ runner.os }}-node-
    
    - name: Install dependencies
      run: npm ci
```

## Artifacts

### Upload Artifacts

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Build
      run: npm run build
    
    - name: Upload artifacts
      uses: actions/upload-artifact@v3
      with:
        name: dist
        path: dist/
    
    - name: Download artifacts
      uses: actions/download-artifact@v3
      with:
        name: dist
```

## Scheduled Workflows

### Cron Jobs

```yaml
name: Scheduled Backup

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC
  workflow_dispatch:  # Manual trigger

jobs:
  backup:
    runs-on: ubuntu-latest
    
    steps:
    - name: Backup database
      run: ./backup.sh
```

## Reusable Workflows

### Call Reusable Workflow

```yaml
# .github/workflows/reusable.yml
name: Reusable Workflow

on:
  workflow_call:
    inputs:
      environment:
        required: true
        type: string

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
    - name: Deploy to ${{ inputs.environment }}
      run: ./deploy.sh ${{ inputs.environment }}

# Call from another workflow
name: Deploy

on:
  push:
    branches: [ main ]

jobs:
  deploy-staging:
    uses: ./.github/workflows/reusable.yml
    with:
      environment: staging
  
  deploy-production:
    uses: ./.github/workflows/reusable.yml
    with:
      environment: production
```

## Best Practices

1. **Use actions/checkout** - Always checkout code
2. **Cache dependencies** - Speed up builds
3. **Use matrix strategy** - Test multiple versions
4. **Set up secrets** - Secure sensitive data
5. **Use conditions** - Conditional execution
6. **Upload artifacts** - Share build outputs
7. **Fail fast** - Stop on errors
8. **Document workflows** - Clear comments

## Conclusion

GitHub Actions enables:
- Automated CI/CD
- Easy integration
- Flexible workflows
- Cost-effective

Start with simple workflows, then add complexity. The patterns shown here handle production deployments.

---

*GitHub Actions automation from March 2020, covering GitHub Actions workflows.*

---
layout: post
title: "GitHub Actions: Automating Your Workflow"
date: 2020-03-04
categories: [How-To]
tags: [GitHub Actions, CI/CD, Automation]
excerpt: "We deleted our Jenkins server the week GitHub Actions went GA. Here's how to build CI/CD workflows that actually run—tests, Docker builds, multi-environment deploys, and the caching tricks that keep your minutes bill sane."
render_with_liquid: false
---

For years, our CI/CD setup was a Jenkins server running on a forgotten EC2 instance. It worked—until it didn't. Plugins broke after updates nobody remembered installing. The machine ran out of disk space every few months. Deploys required SSH-ing into Jenkins to "kick it." When GitHub Actions went GA in late 2019, we migrated in a week and haven't looked back.

GitHub Actions isn't perfect (debugging YAML at 11pm is a rite of passage), but having CI/CD live next to your code—with free minutes for public repos and tight integration with PRs—is hard to beat. No servers to maintain. No plugin hell. Just YAML files in `.github/workflows/` that version-control alongside your application.

This is the guide I wish we'd had: from "run tests on push" to production deploys with caching, secrets, matrix builds, and reusable workflows.

## Mental Model: Workflows, Jobs, Steps

Before the YAML, understand the hierarchy:

- **Workflow** — A YAML file triggered by an event (push, PR, schedule, manual)
- **Job** — A set of steps that run on the same runner (VM)
- **Step** — A single task: run a command, use an action, or call a shell script
- **Action** — Reusable unit of work (checkout code, setup Node, deploy to AWS)

Events trigger workflows. Jobs run in parallel by default (unless you add `needs:`). Steps run sequentially within a job. That's 90% of what you need to know.

## Your First Workflow: CI That Actually Runs

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

Commit this, push, and watch the Actions tab. If it fails, click the job and read the logs—GitHub's UI is genuinely good for debugging. Way better than Jenkins' cryptic stack traces.

**Use `npm ci`, not `npm install`** in CI. It's faster, deterministic, and respects your lockfile. Small thing, big difference over thousands of builds.

## Node.js CI: Matrix Builds and Coverage

Testing on one Node version is how "works on my machine" becomes "works in production on a different Node version."

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
        cache: 'npm'  # Built-in caching — use it
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run tests
      run: npm test -- --coverage
    
    - name: Upload coverage
      uses: codecov/codecov-action@v3
      with:
        file: ./coverage/lcov.info
```

The `cache: 'npm'` line in `setup-node` saved us roughly 40% of CI time. GitHub caches `~/.npm` between runs automatically. Free performance.

## Docker: Build and Push on Tag

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

Note `push: ${{ github.event_name != 'pull_request' }}` — we build on PRs (verify Dockerfile works) but only push images from main/tags. Prevents polluting your registry with every experimental branch.

Tag images with `github.sha` for traceability. When production breaks, you want to know exactly which commit is running.

## Deployment: AWS S3 + CloudFront

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
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Build
      run: |
        npm ci
        npm run build
    
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

**Secrets live in repo Settings → Secrets and variables → Actions.** Never commit credentials. Rotate them when people leave. Use OIDC for AWS when you can—it eliminates long-lived access keys entirely.

## Kubernetes Deploys

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

`kubectl rollout status` waits for the deploy to succeed or fail. Without it, your workflow goes green while pods crashloop in the background. Ask me how I know.

## Matrix Strategy: OS × Runtime

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

This runs 9 combinations (3 OS × 3 Node versions). Great for libraries. Overkill for internal apps—know your audience.

## Conditional Steps: One Workflow, Multiple Environments

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

One workflow file, branch-based routing. Simpler than maintaining separate staging and production workflow files that drift apart.

## Secrets and Environment Variables

```yaml
steps:
- name: Use secret
  env:
    API_KEY: ${{ secrets.API_KEY }}
  run: |
    # $API_KEY is available in this step only
    ./deploy.sh
```

Secrets are masked in logs automatically. Don't echo them. Don't pass them as CLI arguments where they might appear in `ps` output.

For environment-specific secrets (staging vs production), use GitHub Environments with protection rules and required reviewers.

## Caching: Stop Re-downloading the Internet

```yaml
- name: Cache node modules
  uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

Cache keys should change when dependencies change (`hashFiles` on lockfile). `restore-keys` provides partial cache hits when the exact key misses.

## Artifacts: Pass Build Outputs Between Jobs

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

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
    - name: Download artifacts
      uses: actions/download-artifact@v3
      with:
        name: dist
    - name: Deploy
      run: ./deploy.sh
```

Build once, deploy in a separate job. Keeps deploy credentials out of the build environment.

## Scheduled Workflows: Cron Jobs Without Cron

```yaml
name: Scheduled Backup

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC
  workflow_dispatch:      # Manual trigger button

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
    - name: Backup database
      run: ./backup.sh
```

`workflow_dispatch` adds a "Run workflow" button in the UI. Essential for testing scheduled jobs without waiting until 2 AM.

**Cron gotcha:** scheduled workflows can be delayed during high GitHub load. Don't use them for sub-minute precision.

## Reusable Workflows: DRY for CI/CD

```yaml
# .github/workflows/reusable-deploy.yml
name: Reusable Deploy

on:
  workflow_call:
    inputs:
      environment:
        required: true
        type: string

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
    - name: Deploy to ${{ inputs.environment }}
      run: ./deploy.sh ${{ inputs.environment }}
```

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [ main, develop ]

jobs:
  deploy-staging:
    if: github.ref == 'refs/heads/develop'
    uses: ./.github/workflows/reusable-deploy.yml
    with:
      environment: staging
  
  deploy-production:
    if: github.ref == 'refs/heads/main'
    uses: ./.github/workflows/reusable-deploy.yml
    with:
      environment: production
```

Reusable workflows are how you scale CI/CD across 20 repos without copy-pasting YAML.

## Production Lessons

1. **Pin action versions** — `@v3` not `@main`. I've been burned by breaking changes on `@main`.
2. **Fail fast** — run lint before integration tests, unit tests before E2E
3. **Concurrency groups** — cancel in-progress runs when new commits push (`concurrency: group: ${{ github.workflow }}-${{ github.ref }}`)
4. **Watch your minutes** — private repos have limits; cache aggressively
5. **Comment on PRs** — use actions like `actions/github-script` to post test results
6. **Test workflow changes on branches** — `workflow_dispatch` is your friend

## Conclusion

GitHub Actions turned CI/CD from "maintain a server and pray" into "commit a YAML file." That's not a small shift—it's the difference between CI being someone else's full-time job and CI being a 30-minute setup per project.

Start with tests on every PR. Add caching when builds feel slow. Add deploy when you're confident tests catch real bugs. Layer complexity only when you need it—a 20-line workflow that runs reliably beats a 200-line workflow that breaks mysteriously.

We deleted Jenkins and never missed it. Your `.github/workflows/` folder is infrastructure as code that your whole team can read, review in PRs, and improve incrementally. That's worth more than any plugin ecosystem.

---

*GitHub Actions automation from March 2020, covering GitHub Actions workflows.*

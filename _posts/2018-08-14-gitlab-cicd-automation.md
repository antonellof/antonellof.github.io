---
layout: post
title: "GitLab CI/CD: Automating Your Deployment Pipeline"
date: 2018-08-14
categories: [How-To]
tags: [GitLab, CI/CD, DevOps, Automation]
excerpt: "We used to deploy by SSH-ing into a server and hoping. GitLab CI/CD turned that ritual into a pipeline — here's the .gitlab-ci.yml setup that actually survived production."
---

There was a time when "deployment" meant someone ran `./deploy.sh` on a server while everyone else held their breath in Slack. Tests? Sometimes. Rollback plan? "Revert the commit and pray."

Then we moved to GitLab CI/CD, and the bar shifted from "did it deploy?" to "did the pipeline go green?" That single `.gitlab-ci.yml` file in the repo became the contract: every merge request gets validated, every main-branch build is reproducible, and production deploys require a human click — not a human typing credentials into a terminal at midnight.

This is the setup we evolved over several projects in 2018. Nothing exotic — just pipelines that teams actually maintain six months later.

## The Minimum Viable Pipeline

Before you add canary deployments and parallel matrix builds across three Node versions, start here. Build, test, deploy — three stages, one YAML file, zero mystery.

```yaml
# .gitlab-ci.yml
stages:
  - build
  - test
  - deploy

variables:
  DOCKER_DRIVER: overlay2
  DOCKER_TLS_CERTDIR: "/certs"

build:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  script:
    - docker build -t myapp:$CI_COMMIT_SHA .
    - docker tag myapp:$CI_COMMIT_SHA myapp:latest
  only:
    - main
    - develop

test:
  stage: test
  image: node:14
  script:
    - npm install
    - npm run lint
    - npm run test
    - npm run test:e2e
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'

deploy:
  stage: deploy
  image: alpine:latest
  script:
    - echo "Deploying to production"
    - ./deploy.sh
  only:
    - main
  when: manual
```

Notice `when: manual` on production deploy. Automation is great; **automatic production deploys on every green build** is how you learn what "rollback" really means at 4 PM on a Friday.

## Growing Up: A Pipeline That Matches Real Teams

Once the basics work, you'll want validation before build, security scanning before deploy, and separate staging from production environments. This is the shape we settled on:

```yaml
stages:
  - validate
  - build
  - test
  - security
  - deploy
  - cleanup

variables:
  NODE_VERSION: "14"
  DOCKER_IMAGE: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA

# Validate code quality
validate:
  stage: validate
  image: node:$NODE_VERSION
  script:
    - npm ci
    - npm run lint
    - npm run type-check
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/

# Build application
build:
  stage: build
  image: node:$NODE_VERSION
  script:
    - npm ci
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 hour
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/

# Run tests
test:
  stage: test
  image: node:$NODE_VERSION
  services:
    - postgres:13
    - redis:6
  variables:
    POSTGRES_DB: test_db
    POSTGRES_USER: test_user
    POSTGRES_PASSWORD: test_password
  script:
    - npm ci
    - npm run test:unit
    - npm run test:integration
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'
  artifacts:
    reports:
      junit: junit.xml
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml

# Security scanning
security:
  stage: security
  image: node:$NODE_VERSION
  script:
    - npm audit --audit-level=high
    - npm run security:scan
  allow_failure: true

# Deploy to staging
deploy:staging:
  stage: deploy
  image: alpine:latest
  environment:
    name: staging
    url: https://staging.example.com
  script:
    - apk add --no-cache curl
    - curl -X POST https://staging.example.com/deploy \
        -H "Authorization: Bearer $STAGING_TOKEN" \
        -d "image=$DOCKER_IMAGE"
  only:
    - develop

# Deploy to production
deploy:production:
  stage: deploy
  image: alpine:latest
  environment:
    name: production
    url: https://example.com
  script:
    - apk add --no-cache curl
    - curl -X POST https://example.com/deploy \
        -H "Authorization: Bearer $PRODUCTION_TOKEN" \
        -d "image=$DOCKER_IMAGE"
  only:
    - main
  when: manual
  dependencies:
    - build
    - test
```

The `environment` blocks aren't just labels — they give you deployment history in GitLab's UI, which becomes invaluable when someone asks "what's running in prod right now?" (It happens more than you'd think.)

## Docker: Build Once, Tag Twice, Push to Registry

If you're containerized, the build stage should produce an image tagged with `$CI_COMMIT_SHA` (immutable, traceable) and `:latest` (convenient, slightly dangerous). Push both to GitLab's container registry so deploy jobs reference a known artifact, not "whatever was on the runner."

```yaml
build:docker:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker build -t $CI_REGISTRY_IMAGE:latest .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
    - docker push $CI_REGISTRY_IMAGE:latest
  only:
    - main
    - develop
```

**Pro tip:** `$CI_COMMIT_SHA` in the image tag means you can always trace a running container back to an exact commit. When prod breaks, "what changed?" becomes a git log, not archaeology.

## Testing: Split by Speed and Confidence

One giant `npm test` job feels simple until it takes 20 minutes and developers start pushing with `[skip ci]`. Split tests by what they're proving:

### Unit Tests — Fast Feedback

```yaml
test:unit:
  stage: test
  image: node:14
  script:
    - npm ci
    - npm run test:unit -- --coverage
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'
  artifacts:
    reports:
      junit: junit.xml
    paths:
      - coverage/
    expire_in: 30 days
```

### Integration Tests — Real Dependencies

```yaml
test:integration:
  stage: test
  image: node:14
  services:
    - postgres:13
    - redis:6
  variables:
    POSTGRES_DB: test_db
    POSTGRES_USER: test_user
    POSTGRES_PASSWORD: test_password
    DATABASE_URL: postgresql://test_user:test_password@postgres:5432/test_db
  script:
    - npm ci
    - npm run test:integration
  dependencies:
    - build
```

GitLab's `services` spin up sidecar containers — Postgres and Redis on the same network as your test job. No shared staging database getting corrupted by parallel pipelines.

### E2E Tests — Slow, Valuable, Screenshot Evidence

```yaml
test:e2e:
  stage: test
  image: cypress/browsers:node-14.16.0-chrome-90-ff-88
  script:
    - npm ci
    - npm run test:e2e
  artifacts:
    when: always
    paths:
      - cypress/screenshots/
      - cypress/videos/
    expire_in: 1 week
```

`when: always` on artifacts is crucial. When E2E fails, you want screenshots — not a job log that says "element not found" with zero context.

## Conditional Execution: Run Less, Merge Faster

Not every commit needs the full pipeline. Docs-only changes shouldn't trigger a 15-minute E2E suite.

```yaml
# Run only on merge requests
test:mr:
  stage: test
  script:
    - npm test
  only:
    - merge_requests

# Run on specific branches
deploy:feature:
  stage: deploy
  script:
    - echo "Deploying feature branch"
  only:
    - /^feature\/.*$/

# Skip on specific paths
test:
  stage: test
  script:
    - npm test
  except:
    changes:
      - "docs/**/*"
      - "*.md"

# Run only when files change
build:
  stage: build
  script:
    - npm run build
  only:
    changes:
      - "src/**/*"
      - "package.json"
```

We learned the hard way that overly aggressive `only/except` rules cause "works on my branch, broke on main" surprises. Use path filters for obvious wins (markdown, assets); keep core test stages on main protected.

## Parallel Jobs: Matrix Builds Without the Headache

Need to verify Node 12, 14, and 16 compatibility? GitLab's parallel matrix runs the same job with different variables:

```yaml
test:parallel:
  stage: test
  image: node:14
  parallel:
    matrix:
      - NODE_VERSION: ["12", "14", "16"]
  script:
    - nvm use $NODE_VERSION
    - npm ci
    - npm test
```

Fair warning: matrix builds multiply runner minutes. Use them where version compatibility actually matters, not "because we can."

## Deployment Strategies That Don't Bet the Company

### Blue-Green: Two Environments, One Switch

Deploy to the inactive environment, verify health, flip traffic. If green is sick, blue is still serving.

```yaml
deploy:blue-green:
  stage: deploy
  image: alpine:latest
  script:
    - apk add --no-cache curl jq
    - |
      # Deploy to green environment
      GREEN_URL="https://green.example.com"
      curl -X POST "$GREEN_URL/deploy" \
        -H "Authorization: Bearer $DEPLOY_TOKEN" \
        -d "image=$DOCKER_IMAGE"
      
      # Wait for health check
      sleep 30
      HEALTH=$(curl -s "$GREEN_URL/health")
      
      if [ "$(echo $HEALTH | jq -r '.status')" = "healthy" ]; then
        # Switch traffic to green
        curl -X POST "https://lb.example.com/switch" \
          -H "Authorization: Bearer $LB_TOKEN" \
          -d "target=green"
      else
        echo "Health check failed"
        exit 1
      fi
  only:
    - main
```

### Canary: Trust, But Verify With Metrics

Roll out to 10% of traffic, watch error rates, expand or abort. This is the "we're reasonably confident but not suicidal" strategy.

```yaml
deploy:canary:
  stage: deploy
  image: alpine:latest
  script:
    - |
      # Deploy canary (10% traffic)
      curl -X POST "https://api.example.com/deploy" \
        -H "Authorization: Bearer $DEPLOY_TOKEN" \
        -d "image=$DOCKER_IMAGE&traffic=10"
      
      # Monitor metrics
      sleep 300
      
      # Check error rate
      ERROR_RATE=$(curl -s "https://metrics.example.com/error-rate")
      
      if [ "$ERROR_RATE" -lt "1" ]; then
        # Increase to 50%
        curl -X POST "https://api.example.com/traffic" \
          -d "traffic=50"
        
        sleep 300
        
        # Full rollout
        curl -X POST "https://api.example.com/traffic" \
          -d "traffic=100"
      else
        echo "Canary deployment failed"
        exit 1
      fi
```

The `sleep 300` blocks are simplified — in production you'd poll metrics with a timeout and clear abort criteria. But the shape is right: deploy small, measure, then commit.

## Kubernetes Deploys From CI

If you're on K8s, the deploy job is often just "update the image and wait for rollout":

```yaml
deploy:k8s:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - kubectl config use-context $KUBE_CONTEXT
    - kubectl set image deployment/myapp \
        myapp=$DOCKER_IMAGE \
        -n production
    - kubectl rollout status deployment/myapp -n production
  only:
    - main
```

Store `KUBE_CONTEXT` and kubeconfig as protected CI variables. Never commit credentials — GitLab's variable masking exists for a reason.

## Secrets, Caching, and Artifacts: The Plumbing That Matters

**Environment variables** belong in GitLab CI/CD Settings → Variables, marked protected and masked for anything sensitive:

```yaml
# Set in GitLab CI/CD Settings > Variables
variables:
  NODE_ENV: production
  AWS_REGION: us-east-1

deploy:
  stage: deploy
  script:
    - echo "Deploying with $NODE_ENV"
    - aws s3 sync dist/ s3://$S3_BUCKET
  environment:
    name: production
    url: https://example.com
```

**Caching** turns 8-minute `npm ci` runs into 2-minute ones. Cache per branch slug so feature branches don't pollute each other:

```yaml
cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - node_modules/
    - .npm/

build:
  stage: build
  script:
    - npm ci --cache .npm --prefer-offline
    - npm run build
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
      - .npm/
    policy: pull-push
```

**Artifacts** pass build output between stages without rebuilding:

```yaml
build:
  stage: build
  script:
    - npm run build
  artifacts:
    paths:
      - dist/
      - build/
    expire_in: 1 week
    reports:
      dotenv: build.env

deploy:
  stage: deploy
  script:
    - ls -la dist/
  dependencies:
    - build
```

Set job timeouts on anything that touches Docker or E2E — a hung `docker:dind` job will consume a runner until someone notices.

## What Actually Makes Pipelines Survive

The teams whose pipelines still work a year later share a few habits. Stages mirror the development flow — validate before build, test before deploy — not arbitrary alphabet soup. Dependencies get cached aggressively; secrets never touch the repo. Production deploys stay manual or gated until you're confident in rollback. Pipeline failures get the same respect as production incidents — a red main branch is a blocked team.

Start with build → test → deploy. Add complexity when pain demands it, not when a blog post (even this one) suggests it.

## The Bottom Line

GitLab CI/CD turned deployment from a ritual into a repeatable process. Your `.gitlab-ci.yml` is documentation that actually runs — every merge request proves the code works, every production deploy traces to a commit SHA, and nobody SSHs into servers at midnight unless something has gone very wrong.

That's the goal: boring deploys. The exciting ones are the ones you read about on Hacker News, not the ones you live through.

---

*Written August 2018, covering GitLab 11.0+ CI/CD features. GitLab's syntax and runner images have evolved since — check the current docs for `rules` vs `only/except` and updated Node LTS versions.*

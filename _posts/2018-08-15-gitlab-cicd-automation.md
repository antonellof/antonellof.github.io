---
layout: post
title: "GitLab CI/CD: Automating Your Deployment Pipeline"
date: 2018-08-15
categories: [How-To]
tags: [GitLab, CI/CD, DevOps, Automation]
excerpt: "Set up GitLab CI/CD pipelines for automated testing, building, and deployment. Learn pipeline configuration, stages, jobs, and deployment strategies."
---

GitLab CI/CD provides powerful automation for testing, building, and deploying applications. After setting up production pipelines, here's how to configure effective CI/CD workflows.

## GitLab CI/CD Basics

### `.gitlab-ci.yml` Configuration

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

## Pipeline Stages

### Multi-Stage Pipeline

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

## Docker Build and Push

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

## Testing Jobs

### Unit Tests

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

### Integration Tests

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

### E2E Tests

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

## Conditional Execution

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

## Parallel Jobs

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

## Deployment Strategies

### Blue-Green Deployment

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

### Canary Deployment

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

## Kubernetes Deployment

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

## Environment Variables

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

## Caching

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

## Artifacts

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

## Best Practices

1. **Use stages** - Organize pipeline logically
2. **Cache dependencies** - Speed up builds
3. **Run tests in parallel** - Faster feedback
4. **Use artifacts** - Pass data between jobs
5. **Set timeouts** - Prevent hanging jobs
6. **Use manual deployments** - Control production
7. **Monitor pipelines** - Track success rates
8. **Keep secrets secure** - Use CI/CD variables

## Conclusion

GitLab CI/CD enables:
- Automated testing
- Consistent deployments
- Faster feedback
- Reliable releases

Start with simple pipelines, then add complexity. The patterns shown here handle production deployments.

---

*GitLab CI/CD automation from August 2018, covering GitLab 11.0+ features.*

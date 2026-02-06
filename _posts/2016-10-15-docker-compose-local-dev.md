---
layout: post
title: "Docker Compose for Local Development Environments"
date: 2016-10-15
categories: [How-To]
tags: [Docker, Docker Compose, DevOps, Development]
excerpt: "Set up complete local development environments with Docker Compose, including multi-service applications, database seeding, hot reloading, and team collaboration workflows."
---

Docker Compose revolutionized how we set up local development environments. No more "works on my machine" issues or spending hours configuring databases, Redis, and other services. Here's how we use Docker Compose to create reproducible, isolated development environments that work identically for every team member.

## Why Docker Compose for Development?

Before Docker Compose, setting up a local environment meant:
- Installing MySQL, PostgreSQL, Redis manually
- Configuring each service separately
- Dealing with version conflicts
- Different setups across team members

Docker Compose solves this with:
- One command to start everything
- Consistent environments across team
- Easy service isolation
- Simple cleanup

## Basic Docker Compose Setup

### Simple Multi-Service Application

```yaml
# docker-compose.yml
version: '3.8'

services:
  web:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - .:/app
    depends_on:
      - db
      - redis

  db:
    image: postgres:9.6
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp
      POSTGRES_PASSWORD: secret
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:3-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

Start everything:

```bash
docker-compose up -d
```

## Development vs Production Configs

### Development Configuration

```yaml
# docker-compose.dev.yml
version: '3.8'

services:
  web:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app
      - /app/node_modules  # Prevent overwrite
    environment:
      - NODE_ENV=development
      - DEBUG=true
    command: npm run dev  # Hot reload

  db:
    ports:
      - "5432:5432"  # Expose for local tools
    environment:
      - POSTGRES_LOG_STATEMENT=all  # Debug queries

  redis:
    ports:
      - "6379:6379"
```

### Production Configuration

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  web:
    build:
      context: .
      dockerfile: Dockerfile.prod
    environment:
      - NODE_ENV=production
    restart: always

  db:
    environment:
      - POSTGRES_PASSWORD_FILE=/run/secrets/db_password
    secrets:
      - db_password
    restart: always

secrets:
  db_password:
    file: ./secrets/db_password.txt
```

Usage:

```bash
# Development
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up
```

## Full-Stack Application Example

### Laravel + Vue.js + PostgreSQL

```yaml
# docker-compose.yml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./docker/nginx/default.conf:/etc/nginx/conf.d/default.conf
      - ./public:/var/www/public
    depends_on:
      - php
      - frontend

  php:
    build:
      context: .
      dockerfile: docker/php/Dockerfile
    volumes:
      - ./:/var/www
      - ./docker/php/local.ini:/usr/local/etc/php/conf.d/local.ini
    environment:
      - DB_HOST=db
      - DB_DATABASE=laravel
      - DB_USERNAME=laravel
      - DB_PASSWORD=secret
      - REDIS_HOST=redis
    depends_on:
      - db
      - redis

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile.dev
    volumes:
      - ./frontend:/app
      - /app/node_modules
    ports:
      - "3000:3000"
    command: npm run dev

  db:
    image: postgres:9.6
    environment:
      POSTGRES_DB: laravel
      POSTGRES_USER: laravel
      POSTGRES_PASSWORD: secret
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql

  redis:
    image: redis:3-alpine
    volumes:
      - redis_data:/data

  queue:
    build:
      context: .
      dockerfile: docker/php/Dockerfile
    command: php artisan queue:work --tries=3
    volumes:
      - ./:/var/www
    depends_on:
      - db
      - redis

volumes:
  postgres_data:
  redis_data:
```

## Database Seeding and Migrations

### Automatic Setup

```yaml
services:
  db:
    image: postgres:9.6
    environment:
      POSTGRES_DB: myapp
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql

  migrate:
    build: .
    command: php artisan migrate --force
    volumes:
      - .:/app
    depends_on:
      - db
    profiles:
      - tools  # Only run when explicitly requested

  seed:
    build: .
    command: php artisan db:seed
    volumes:
      - .:/app
    depends_on:
      - db
      - migrate
    profiles:
      - tools
```

Run migrations:

```bash
docker-compose --profile tools up migrate
docker-compose --profile tools up seed
```

## Hot Reloading Setup

### Node.js with Nodemon

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app
      - /app/node_modules
    command: nodemon --watch /app --exec "node /app/index.js"
    environment:
      - NODE_ENV=development
```

### Python with Watchdog

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app
    command: watchmedo auto-restart --directory=/app --pattern="*.py" --recursive -- python /app/main.py
```

### PHP with Polling

```yaml
services:
  php:
    volumes:
      - .:/var/www
    environment:
      - PHP_OPCACHE_VALIDATE_TIMESTAMPS=1  # Check for changes
```

## Networking Between Services

### Custom Networks

```yaml
version: '3.8'

services:
  web:
    networks:
      - frontend
      - backend

  api:
    networks:
      - backend

  db:
    networks:
      - backend

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true  # No external access
```

### Service Discovery

Services can communicate using service names:

```python
# In your application
import os

db_host = os.getenv('DB_HOST', 'db')  # 'db' is service name
db_port = 5432

# Docker Compose resolves 'db' to the db service IP
```

## Environment Variables

### Using .env File

```bash
# .env
DB_PASSWORD=secret
REDIS_PASSWORD=redis_secret
APP_ENV=local
```

```yaml
services:
  web:
    env_file:
      - .env
    environment:
      - DB_HOST=db
      - DB_PASSWORD=${DB_PASSWORD}
```

### Environment-Specific Files

```bash
# .env.development
DB_PASSWORD=dev_secret

# .env.production
DB_PASSWORD=prod_secret
```

```yaml
services:
  web:
    env_file:
      - .env.${ENV:-development}
```

## Health Checks

```yaml
services:
  web:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  db:
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
```

Use health checks in dependencies:

```yaml
services:
  web:
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
```

## Volume Management

### Named Volumes

```yaml
volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
```

### Bind Mounts for Development

```yaml
services:
  web:
    volumes:
      - ./src:/app/src  # Sync source code
      - ./config:/app/config
      - /app/node_modules  # Exclude node_modules
```

### Volume Drivers

```yaml
volumes:
  db_data:
    driver: local
    driver_opts:
      type: nfs
      o: addr=192.168.1.100,rw
      device: ":/path/to/nfs/share"
```

## Useful Docker Compose Commands

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f web
docker-compose logs -f --tail=100

# Execute commands
docker-compose exec web php artisan migrate
docker-compose exec db psql -U postgres -d myapp

# Scale services
docker-compose up -d --scale worker=5

# Rebuild after Dockerfile changes
docker-compose up -d --build

# Stop and remove volumes
docker-compose down -v

# View service status
docker-compose ps

# Execute one-off commands
docker-compose run --rm web php artisan tinker
```

## Development Workflow

### Initial Setup Script

```bash
#!/bin/bash
# setup.sh

echo "Setting up development environment..."

# Start services
docker-compose up -d

# Wait for database
echo "Waiting for database..."
sleep 10

# Run migrations
docker-compose exec web php artisan migrate

# Seed database
docker-compose exec web php artisan db:seed

# Install frontend dependencies
docker-compose exec frontend npm install

echo "Setup complete! Visit http://localhost"
```

### Daily Workflow

```bash
# Start everything
docker-compose up -d

# Work on code (hot reload enabled)

# Run tests
docker-compose exec web php artisan test

# Check logs
docker-compose logs -f

# Stop everything
docker-compose down
```

## Troubleshooting

### View Service Logs

```bash
# All services
docker-compose logs

# Specific service
docker-compose logs web

# Follow logs
docker-compose logs -f web db
```

### Access Running Containers

```bash
# Shell into container
docker-compose exec web bash

# Run commands
docker-compose exec web php artisan migrate
```

### Reset Everything

```bash
# Stop and remove containers, networks, volumes
docker-compose down -v

# Remove images
docker-compose down --rmi all

# Clean start
docker-compose up -d --build
```

## Best Practices

1. **Use .env files** - Don't hardcode secrets
2. **Separate dev/prod configs** - Use override files
3. **Use health checks** - Ensure services are ready
4. **Volume node_modules** - Prevent overwrites
5. **Use named volumes** - For persistent data
6. **Document services** - Add comments in compose file
7. **Use profiles** - For optional services
8. **Keep images updated** - Regular security updates

## Conclusion

Docker Compose transforms local development:
- Consistent environments across team
- Easy service management
- Simple cleanup and reset
- Production-like setup locally

Start with a simple compose file, then add services as needed. The patterns shown here work for applications of any size.

---

*Docker Compose best practices from October 2016, using Compose file format 3.8.*

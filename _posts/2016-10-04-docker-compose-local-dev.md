---
layout: post
title: "Docker Compose for Local Development Environments"
date: 2016-10-04
categories: [How-To]
tags: [Docker, Docker Compose, DevOps, Development]
excerpt: "New hire on day one: four hours installing MySQL, Redis, and the right Postgres version. After Docker Compose: git clone, docker-compose up, start coding. Here's how we killed 'works on my machine.'"
---

New engineer. Day one. Enthusiastic. Ready to ship.

Four hours later, they're still installing PostgreSQL 9.6 because the app doesn't work on 9.5, configuring Redis, debugging a Node version mismatch, and quietly wondering if they chose the wrong company.

Meanwhile, the senior dev's machine "just works" because they set it up in 2014 and haven't thought about it since. Different patch versions. Different env vars. Different `/etc/hosts` hacks. The classic "works on my machine" trap — except now it's institutionalized across the team.

Docker Compose fixed this for us. One `docker-compose up` and everyone runs the same Postgres, same Redis, same service topology. Onboarding dropped from half a day to twenty minutes. "Works on my machine" became "works on everyone's machine, because it's the same machine, virtually."

Here's how we built local dev environments that actually reproduce production — without reproducing production's complexity on day one.

## What Compose Gives You

Before Compose, local setup was artisanal:

- Install databases manually, hope versions match
- Configure each service in isolation
- Fight port conflicts with whatever else is running
- Document the setup in a wiki that was wrong by Tuesday

Compose replaces that with a YAML file that *is* the documentation:

- One command starts the full stack
- Every developer gets identical services
- Cleanup is `docker-compose down -v`, not "reinstall Postgres"
- Production-like topology without production-like AWS bills

## The Starter Stack

A web app, a database, a cache. The holy trinity:

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

```bash
docker-compose up -d
```

That's it. Web on 8000, Postgres on 5432, Redis on 6379. New hire runs two commands: `git clone`, `docker-compose up -d`. They're coding before lunch.

## Dev vs. Prod: Same Services, Different Hats

Don't maintain two completely separate compose files. Use a base file and overrides:

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

```bash
# Development
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up
```

Dev exposes ports for local DB clients and enables hot reload. Prod uses secrets and restart policies. Same service names, different behavior. The `/app/node_modules` anonymous volume is critical — without it, your bind mount overwrites `node_modules` with your host's (possibly empty, possibly wrong-architecture) directory.

## Full-Stack Reality: Laravel + Vue + Workers

Real apps aren't one container. Here's a stack that mirrors production:

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

Including the queue worker locally catches job serialization bugs before they hit staging. "It worked in tinker" is not the same as "it worked when dispatched to a worker."

## Database Seeding Without Manual Steps

Init scripts run on first container start. Migrations and seeds run on demand:

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

```bash
docker-compose --profile tools up migrate
docker-compose --profile tools up seed
```

Profiles keep one-off tasks out of the default `docker-compose up`. You don't want migrations running every time someone starts their laptop.

## Hot Reload: Edit Code, See Changes

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

### PHP: Opcache Timestamps

```yaml
services:
  php:
    volumes:
      - .:/var/www
    environment:
      - PHP_OPCACHE_VALIDATE_TIMESTAMPS=1  # Check for changes
```

Bind mounts sync source instantly. The reload mechanism depends on your runtime. PHP needs opcache configured to check timestamps in dev — otherwise you're restarting containers to see a semicolon change.

## Networking: Services Find Each Other by Name

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

```python
# In your application
import os

db_host = os.getenv('DB_HOST', 'db')  # 'db' is service name
db_port = 5432

# Docker Compose resolves 'db' to the db service IP
```

Use service names as hostnames. `DB_HOST=db`, not `DB_HOST=localhost`. `localhost` inside a container is the container itself, not your machine, not the database. This confuses everyone exactly once.

## Environment Variables: .env Files Save Marriages

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

```yaml
services:
  web:
    env_file:
      - .env.${ENV:-development}
```

Commit `.env.example`. Gitignore `.env`. Every new hire copies one file instead of interrogating Slack for secrets.

## Health Checks: Don't Start Web Before DB Is Ready

`depends_on` waits for the container to *start*, not for the service to be *ready*. Postgres takes a few seconds to accept connections. Your app crashes immediately. You blame Docker. Docker is innocent.

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

```yaml
services:
  web:
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
```

`condition: service_healthy` is the difference between "web container restarted 47 times" and "web container started once, successfully."

## Volumes: Persistence vs. Live Editing

Named volumes persist data across `docker-compose down`. Bind mounts sync source code. Both matter:

```yaml
services:
  web:
    volumes:
      - ./src:/app/src  # Sync source code
      - ./config:/app/config
      - /app/node_modules  # Exclude node_modules
```

```yaml
volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
```

`docker-compose down -v` wipes named volumes. Document that prominently before someone loses a week of local test data.

## Commands You'll Actually Use

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

`docker-compose exec` runs in a running container. `docker-compose run` creates a new one. Use `run --rm` for one-off tasks that shouldn't stick around.

## Team Workflow: From Clone to Shipping

### Onboarding Script

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

The `sleep 10` is crude. Health checks are better. We kept the sleep in onboarding scripts because it's obvious and works; health checks are for the compose file itself.

### Daily Rhythm

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

## When Things Break (They Will)

```bash
# All services
docker-compose logs

# Specific service
docker-compose logs web

# Follow logs
docker-compose logs -f web db
```

```bash
# Shell into container
docker-compose exec web bash

# Run commands
docker-compose exec web php artisan migrate
```

```bash
# Nuclear option
docker-compose down -v
docker-compose down --rmi all
docker-compose up -d --build
```

The nuclear option fixes 80% of "something weird is happening" reports. It's slow, but so is debugging phantom state from a container that was built three months ago.

## What We Learned

Use `.env` files and never commit secrets. Split dev and prod with override files, not duplicate stacks. Health checks with `service_healthy` dependencies prevent startup race conditions. Anonymous volumes for `node_modules` prevent bind mount disasters. Named volumes for database persistence. Profiles for migrations and seeds.

Keep images reasonably current — that `postgres:9.6` made sense in 2016; update deliberately, not never. Document the two commands every new hire needs. Put `setup.sh` in the repo.

Docker Compose doesn't replace production orchestration. It replaces the afternoon lost to "can you help me configure Postgres." That's worth more than it sounds.

Start with web + db + redis. Add nginx, workers, and frontend when the app needs them. The patterns here scaled from solo side projects to teams of twenty — because the compose file is version-controlled truth, not tribal knowledge in someone's `.bashrc`.

---

*Docker Compose best practices from October 2016, using Compose file format 3.8. Compose V2 (`docker compose` without hyphen) is now standard; concepts and override patterns are unchanged.*

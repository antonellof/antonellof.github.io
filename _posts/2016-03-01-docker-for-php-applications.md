---
layout: post
title: "Docker for PHP Applications: A Complete Guide"
date: 2016-03-01
categories: [How-To]
tags: [Docker, PHP, DevOps, Containers]
excerpt: "Learn how to containerize PHP applications with Docker, including nginx, PHP-FPM, MySQL setup, and development workflows for modern PHP projects."
---

Docker has revolutionized how we develop and deploy applications. As a PHP developer, I initially resisted containers, thinking they added unnecessary complexity. I was wrong. Docker solved my "works on my machine" problems and made deployments predictable. Here's everything I learned about Dockerizing PHP applications.

## Why Docker for PHP?

Traditional PHP development had pain points:
- Different PHP versions across environments
- Missing extensions causing production bugs
- Complex LAMP/LEMP stack setup
- Inconsistent development environments across team

Docker solves all of this with reproducible containers.

## Basic PHP Docker Setup

Let's start with a simple PHP application structure:

```
my-php-app/
├── docker-compose.yml
├── docker/
│   ├── nginx/
│   │   └── default.conf
│   └── php/
│       └── Dockerfile
├── public/
│   └── index.php
└── src/
```

### PHP Dockerfile

```dockerfile
# docker/php/Dockerfile
FROM php:7.0-fpm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    libpng-dev \
    libonig-dev \
    libxml2-dev \
    zip \
    unzip

# Clear cache
RUN apt-get clean && rm -rf /var/lib/apt/lists/*

# Install PHP extensions
RUN docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd

# Get latest Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# Set working directory
WORKDIR /var/www

# Copy application files
COPY . /var/www

# Install dependencies
RUN composer install --no-interaction --optimize-autoloader

# Set permissions
RUN chown -R www-data:www-data /var/www

EXPOSE 9000
CMD ["php-fpm"]
```

### Nginx Configuration

```nginx
# docker/nginx/default.conf
server {
    listen 80;
    index index.php index.html;
    error_log  /var/log/nginx/error.log;
    access_log /var/log/nginx/access.log;
    root /var/www/public;

    location ~ \.php$ {
        try_files $uri =404;
        fastcgi_split_path_info ^(.+\.php)(/.+)$;
        fastcgi_pass php:9000;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param PATH_INFO $fastcgi_path_info;
    }

    location / {
        try_files $uri $uri/ /index.php?$query_string;
        gzip_static on;
    }
}
```

### Docker Compose Configuration

```yaml
# docker-compose.yml
version: '3'

services:
  nginx:
    image: nginx:alpine
    container_name: my-app-nginx
    restart: unless-stopped
    ports:
      - "8000:80"
    volumes:
      - ./:/var/www
      - ./docker/nginx:/etc/nginx/conf.d
    networks:
      - app-network
    depends_on:
      - php

  php:
    build:
      context: .
      dockerfile: docker/php/Dockerfile
    container_name: my-app-php
    restart: unless-stopped
    volumes:
      - ./:/var/www
    networks:
      - app-network
    depends_on:
      - mysql

  mysql:
    image: mysql:5.7
    container_name: my-app-mysql
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: myapp
      MYSQL_ROOT_PASSWORD: secret
      MYSQL_PASSWORD: secret
      MYSQL_USER: myapp
    volumes:
      - mysql-data:/var/lib/mysql
    ports:
      - "3306:3306"
    networks:
      - app-network

networks:
  app-network:
    driver: bridge

volumes:
  mysql-data:
    driver: local
```

## Laravel Docker Setup

For Laravel applications, we need additional services and configuration:

```dockerfile
# docker/php/Dockerfile for Laravel
FROM php:7.0-fpm

# Install dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    libpng-dev \
    libjpeg62-turbo-dev \
    libfreetype6-dev \
    locales \
    zip \
    jpegoptim optipng pngquant gifsicle \
    vim \
    unzip \
    git \
    curl

# Install extensions
RUN docker-php-ext-install pdo_mysql mbstring zip exif pcntl
RUN docker-php-ext-configure gd --with-gd --with-freetype-dir=/usr/include/ --with-jpeg-dir=/usr/include/ --with-png-dir=/usr/include/
RUN docker-php-ext-install gd

# Install composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Add user for laravel application
RUN groupadd -g 1000 www
RUN useradd -u 1000 -ms /bin/bash -g www www

# Copy existing application directory
COPY . /var/www
COPY --chown=www:www . /var/www

# Change current user to www
USER www

# Expose port 9000 and start php-fpm server
EXPOSE 9000
CMD ["php-fpm"]
```

Complete Laravel docker-compose:

```yaml
# docker-compose.yml for Laravel
version: '3'

services:
  app:
    build:
      context: .
      dockerfile: docker/php/Dockerfile
    image: laravel-app
    container_name: laravel-app
    restart: unless-stopped
    tty: true
    environment:
      SERVICE_NAME: app
      SERVICE_TAGS: dev
    working_dir: /var/www
    volumes:
      - ./:/var/www
      - ./docker/php/local.ini:/usr/local/etc/php/conf.d/local.ini
    networks:
      - app-network

  webserver:
    image: nginx:alpine
    container_name: laravel-webserver
    restart: unless-stopped
    tty: true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./:/var/www
      - ./docker/nginx/conf.d/:/etc/nginx/conf.d/
    networks:
      - app-network

  db:
    image: mysql:5.7.22
    container_name: laravel-db
    restart: unless-stopped
    tty: true
    ports:
      - "3306:3306"
    environment:
      MYSQL_DATABASE: laravel
      MYSQL_ROOT_PASSWORD: secret
      SERVICE_TAGS: dev
      SERVICE_NAME: mysql
    volumes:
      - dbdata:/var/lib/mysql
      - ./docker/mysql/my.cnf:/etc/mysql/my.cnf
    networks:
      - app-network

  redis:
    image: redis:alpine
    container_name: laravel-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    networks:
      - app-network

networks:
  app-network:
    driver: bridge

volumes:
  dbdata:
    driver: local
```

## Development Workflow

### Starting the Application

```bash
# Build and start containers
docker-compose up -d --build

# View logs
docker-compose logs -f

# Stop containers
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

### Running Commands

```bash
# Execute PHP commands
docker-compose exec php php artisan migrate

# Install Composer dependencies
docker-compose exec php composer install

# Run tests
docker-compose exec php vendor/bin/phpunit

# Access PHP container
docker-compose exec php bash

# MySQL commands
docker-compose exec mysql mysql -u root -p
```

## Multi-Stage Builds for Production

Optimize your production images with multi-stage builds:

```dockerfile
# Build stage
FROM composer:latest AS build
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --optimize-autoloader --no-scripts

# Production stage
FROM php:7.0-fpm-alpine

# Install runtime dependencies only
RUN apk add --no-cache \
    mysql-client \
    && docker-php-ext-install pdo_mysql opcache

# Copy built dependencies
COPY --from=build /app/vendor /var/www/vendor

# Copy application
COPY . /var/www

# Optimize for production
RUN chown -R www-data:www-data /var/www
RUN php artisan config:cache
RUN php artisan route:cache

WORKDIR /var/www
EXPOSE 9000
CMD ["php-fpm"]
```

## Performance Optimization

### PHP-FPM Configuration

```ini
; docker/php/www.conf
[www]
user = www-data
group = www-data

listen = 9000

pm = dynamic
pm.max_children = 50
pm.start_servers = 10
pm.min_spare_servers = 5
pm.max_spare_servers = 35
pm.max_requests = 500

; Performance
request_terminate_timeout = 30s
catch_workers_output = yes
```

### PHP Configuration

```ini
; docker/php/local.ini
upload_max_filesize = 40M
post_max_size = 40M
memory_limit = 256M
max_execution_time = 600
max_input_time = 600

; OPcache
opcache.enable = 1
opcache.memory_consumption = 128
opcache.interned_strings_buffer = 8
opcache.max_accelerated_files = 4000
opcache.revalidate_freq = 60
opcache.fast_shutdown = 1
```

## Docker Compose for Different Environments

### Development

```yaml
# docker-compose.dev.yml
version: '3'

services:
  php:
    environment:
      APP_ENV: local
      APP_DEBUG: "true"
    volumes:
      - ./:/var/www:cached  # Faster on macOS
```

### Production

```yaml
# docker-compose.prod.yml
version: '3'

services:
  php:
    environment:
      APP_ENV: production
      APP_DEBUG: "false"
    # No volumes - use built-in code
```

Usage:

```bash
# Development
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up
```

## Debugging with Xdebug

Add Xdebug to your development Dockerfile:

```dockerfile
# Install Xdebug
RUN pecl install xdebug-2.4.0 \
    && docker-php-ext-enable xdebug

# Xdebug config
RUN echo "xdebug.remote_enable=1" >> /usr/local/etc/php/conf.d/docker-php-ext-xdebug.ini \
    && echo "xdebug.remote_host=host.docker.internal" >> /usr/local/etc/php/conf.d/docker-php-ext-xdebug.ini \
    && echo "xdebug.remote_port=9001" >> /usr/local/etc/php/conf.d/docker-php-ext-xdebug.ini
```

## Common Issues and Solutions

### Permission Issues

```bash
# Fix permission issues on Linux
docker-compose exec php chown -R www-data:www-data /var/www/storage
docker-compose exec php chmod -R 775 /var/www/storage
```

### Slow Performance on macOS

Use cached or delegated volumes:

```yaml
volumes:
  - ./:/var/www:cached
```

### Container Can't Connect to MySQL

Wait for MySQL to be ready:

```bash
# Install wait-for-it script
COPY wait-for-it.sh /usr/local/bin/

# Use it in entrypoint
CMD ["wait-for-it", "mysql:3306", "--", "php-fpm"]
```

## Best Practices

1. **Use .dockerignore**
   ```
   .git
   .env
   vendor/
   node_modules/
   storage/
   *.md
   ```

2. **Keep containers single-purpose**
   - One service per container
   - Nginx in one, PHP in another

3. **Use specific image tags**
   ```dockerfile
   FROM php:7.0.33-fpm-alpine  # Not just php:7.0
   ```

4. **Don't run as root**
   ```dockerfile
   USER www-data
   ```

5. **Use health checks**
   ```yaml
   healthcheck:
     test: ["CMD", "php-fpm-healthcheck"]
     interval: 30s
     timeout: 3s
     retries: 3
   ```

## Conclusion

Docker transforms PHP development by providing:
- Consistent environments across team
- Easy onboarding for new developers
- Predictable deployments
- Better resource utilization

Start simple with docker-compose, then evolve your setup as you learn. The initial time investment pays off quickly in reduced "environment issues" and faster deployments.

---

*This guide uses Docker 1.13 and PHP 7.0, reflecting the ecosystem in early 2016.*

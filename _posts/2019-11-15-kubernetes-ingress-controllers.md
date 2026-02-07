---
layout: post
title: "Kubernetes Ingress Controllers: NGINX vs Traefik"
date: 2019-11-15
categories: [Deep Dive]
tags: [Kubernetes, Ingress, NGINX, Traefik]
excerpt: "Compare Kubernetes ingress controllers: NGINX Ingress vs Traefik. Learn configuration, SSL/TLS, load balancing, and when to use each controller."
---

Ingress controllers route external traffic to Kubernetes services. After using both NGINX and Traefik in production, here's a comparison.

## What is an Ingress Controller?

An Ingress controller:
- Routes external HTTP/HTTPS traffic
- Provides SSL/TLS termination
- Load balances across pods
- Supports path-based routing

## NGINX Ingress Controller

### Installation

```bash
# Install NGINX Ingress
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.1/deploy/static/provider/cloud/deploy.yaml

# Verify installation
kubectl get pods -n ingress-nginx
```

### Basic Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

### SSL/TLS

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts:
    - api.example.com
    secretName: api-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

### Path-Based Routing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: path-based-ingress
spec:
  rules:
  - host: example.com
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
      - path: /admin
        pathType: Prefix
        backend:
          service:
            name: admin-service
            port:
              number: 80
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web-service
            port:
              number: 80
```

### Custom Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-configuration
  namespace: ingress-nginx
data:
  proxy-connect-timeout: "60"
  proxy-send-timeout: "60"
  proxy-read-timeout: "60"
  proxy-body-size: "10m"
  ssl-protocols: "TLSv1.2 TLSv1.3"
```

## Traefik Ingress Controller

### Installation

```bash
# Install Traefik via Helm
helm repo add traefik https://traefik.github.io/charts
helm install traefik traefik/traefik

# Or via YAML
kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v2.10/examples/k8s/traefik-deployment.yaml
```

### Basic Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web,websecure
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

### SSL/TLS

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    traefik.ingress.kubernetes.io/router.tls: "true"
    traefik.ingress.kubernetes.io/router.tls.certresolver: letsencrypt
spec:
  tls:
  - hosts:
    - api.example.com
    secretName: api-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

### Middleware

```yaml
apiVersion: traefik.containo.us/v1alpha1
kind: Middleware
metadata:
  name: auth-middleware
spec:
  forwardAuth:
    address: "http://auth-service:8080"
    authResponseHeaders:
      - "X-User-Id"
      - "X-User-Email"

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: protected-ingress
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: default-auth-middleware@kubernetescrd
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

## Comparison

### Performance

**NGINX:**
- Higher throughput
- Lower latency
- Better for high traffic

**Traefik:**
- Good performance
- Lower memory usage
- Better for dynamic configs

### Configuration

**NGINX:**
- ConfigMap-based
- Requires reload for changes
- More verbose configuration

**Traefik:**
- Dynamic configuration
- Hot reload
- Simpler annotations

### Features

**NGINX:**
- Mature and stable
- Extensive documentation
- Large community

**Traefik:**
- Modern design
- Built-in Let's Encrypt
- Dashboard included
- Service discovery

### Use Cases

**Choose NGINX when:**
- Maximum performance needed
- Complex routing rules
- Existing NGINX expertise
- High traffic loads

**Choose Traefik when:**
- Dynamic configuration needed
- Built-in Let's Encrypt
- Modern microservices
- Dashboard required

## Load Balancing

### NGINX Load Balancing

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  upstream-hash-by: "$request_uri"
  # Or use consistent hashing
```

### Traefik Load Balancing

```yaml
apiVersion: traefik.containo.us/v1alpha1
kind: Service
metadata:
  name: load-balancer
spec:
  weighted:
    services:
    - name: api-service-v1
      weight: 70
    - name: api-service-v2
      weight: 30
```

## Monitoring

### NGINX Metrics

```yaml
# Enable metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  enable-prometheus-metrics: "true"
```

### Traefik Metrics

```yaml
# Traefik has built-in Prometheus metrics
# Access at /metrics endpoint
```

## Best Practices

1. **Use SSL/TLS** - Secure all traffic
2. **Set timeouts** - Prevent hanging connections
3. **Configure rate limiting** - Prevent abuse
4. **Monitor metrics** - Track performance
5. **Use health checks** - Route to healthy pods
6. **Set resource limits** - Prevent resource exhaustion
7. **Use annotations** - For custom configuration
8. **Test failover** - Ensure high availability

## Conclusion

Both NGINX and Traefik are excellent choices:

**NGINX** for:
- Maximum performance
- Complex configurations
- High traffic

**Traefik** for:
- Dynamic configurations
- Modern features
- Simpler setup

Choose based on your specific needs and requirements.

---

*Kubernetes Ingress Controllers comparison from November 2019, covering NGINX and Traefik.*

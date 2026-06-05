---
layout: post
title: "Kubernetes Ingress Controllers: NGINX vs Traefik"
date: 2019-11-05
categories: [Deep Dive]
tags: [Kubernetes, Ingress, NGINX, Traefik]
excerpt: "Your pods are running. Nobody can reach them. Ingress controllers are the bouncer at the cluster door — and picking NGINX vs Traefik is a bigger commitment than it looks."
---

You deployed your app to Kubernetes. Pods are healthy. Services are configured. You run `kubectl get ingress` and see your rules listed. You curl the hostname and get... connection refused.

Welcome to the ingress controller gap — the most common "my Kubernetes deployment works but nothing is reachable" problem in 2019. An Ingress *resource* is just a wish list. An ingress *controller* is the thing that actually reads that wish list and configures a reverse proxy to make it real. No controller, no traffic. Kubernetes does not include one by default.

I've run both NGINX Ingress and Traefik in production clusters. Both work. Both frustrated me in different ways. Here's the honest comparison — not "which is better," but which fits your team's constraints, traffic profile, and tolerance for YAML.

## What Ingress Controllers Actually Do

An ingress controller sits at the edge of your cluster and handles:

- Routing external HTTP/HTTPS traffic to internal services
- SSL/TLS termination (so your app pods don't manage certificates)
- Load balancing across pod replicas
- Path-based and host-based routing
- Request rewriting, rate limiting, and authentication (depending on controller)

Think of it as the front door of your cluster. Everything external passes through it. Choose poorly and you're debugging routing issues instead of shipping features.

## NGINX Ingress Controller: The Battle-Tested Default

NGINX Ingress is the de facto standard in 2019. It's built on the NGINX reverse proxy that half the internet already runs. Massive community, extensive documentation, and performance numbers that make load test engineers nod approvingly.

### Installation

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.1/deploy/static/provider/cloud/deploy.yaml

kubectl get pods -n ingress-nginx
```

The cloud provider manifest handles most AWS/GCP/Azure setups. Bare metal or custom environments need the bare-metal manifest. Either way, verify the controller pod is running before creating Ingress resources — otherwise you're writing wishes into the void.

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

Host `api.example.com`, all paths, route to `api-service` on port 80. The `ingress.class: nginx` annotation tells the NGINX controller to pick this up. If you have multiple controllers installed, this annotation is how you avoid routing conflicts.

### SSL/TLS with cert-manager

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

cert-manager + Let's Encrypt was the standard TLS setup in 2019. Annotate the Ingress, cert-manager provisions the certificate, NGINX terminates TLS. Your app pods never see HTTPS — they handle plain HTTP internally, which is fine inside the cluster network.

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

One hostname, three backends. `/api` goes to the API service, `/admin` to admin, everything else to the web frontend. Path order matters — NGINX matches the most specific path first.

This is where NGINX shines. Complex routing rules, regex paths, rewrite annotations — the NGINX annotation catalog in 2019 was enormous. Almost anything you could configure in nginx.conf had an annotation equivalent.

### Global Configuration via ConfigMap

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

NGINX Ingress configures the underlying NGINX instance via ConfigMap. Change a value, controller reloads NGINX. This is powerful but means configuration changes require understanding NGINX semantics — your Kubernetes YAML skills don't fully translate.

## Traefik: The Cloud-Native Challenger

Traefik was built for dynamic environments. It watches Kubernetes (and Docker, Consul, Marathon) for changes and reconfigures automatically — no reload step, no ConfigMap edits for basic routing.

### Installation

```bash
helm repo add traefik https://traefik.github.io/charts
helm install traefik traefik/traefik
```

Helm was the cleanest install path. Traefik also ships raw YAML manifests for those avoiding Helm.

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

Functionally similar to NGINX — host and path routing to a backend service. The annotations differ, which is the recurring theme with Traefik: same capabilities, different vocabulary.

### SSL/TLS with Built-in Let's Encrypt

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

Traefik has built-in ACME (Let's Encrypt) support without cert-manager. For small clusters, this is genuinely simpler — one less component to install and debug. For larger setups, cert-manager's centralized certificate management often wins.

### Middleware: Traefik's Secret Weapon

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

Middleware is composable request processing — auth, rate limiting, headers, compression, circuit breaking — defined as Kubernetes CRDs and attached to routes via annotations. This was Traefik's killer feature in 2019. NGINX could do all of this too, but via annotations that felt increasingly like writing nginx.conf in YAML disguise.

## Head-to-Head: The Comparison That Matters

### Performance

**NGINX** delivers higher throughput and lower latency under heavy load. If you're terminating TLS for 50,000 requests per second, NGINX's C-based core has a real advantage.

**Traefik** performs well for typical workloads — microservices with moderate traffic, internal APIs, staging environments. It's written in Go, uses less memory per connection, and the performance difference only matters at scales most teams never reach.

Honest take: unless you're running a high-traffic public API, both are fast enough. Don't choose NGINX purely for benchmark numbers you'll never need.

### Configuration Experience

**NGINX** uses ConfigMaps for global settings and annotations for per-Ingress rules. Changes to global config trigger NGINX reloads. The annotation catalog is vast but inconsistently documented. You'll Google `nginx.ingress.kubernetes.io/` at least once a week.

**Traefik** uses CRDs (IngressRoute, Middleware) for configuration. Changes are picked up dynamically — no reload. The dashboard (built into Traefik) shows your active routes, which is genuinely helpful when debugging "why isn't my route working."

If your team lives in Kubernetes YAML and prefers CRDs over ConfigMaps, Traefik feels more native. If your team already knows NGINX configuration semantics, NGINX Ingress feels like home.

### Ecosystem and Maturity

**NGINX** has the larger community, more Stack Overflow answers, more blog posts, and wider cloud provider integration. When something breaks at 2 AM, someone has already written about it.

**Traefik** has a passionate community, excellent documentation, and a development velocity that NGINX (post-acquisition by F5) sometimes lacked. The built-in dashboard and Let's Encrypt integration reduce the "install cert-manager, configure ClusterIssuer, debug certificate challenges" onboarding tax.

## Load Balancing Strategies

### NGINX: Consistent Hashing

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  upstream-hash-by: "$request_uri"
```

Route the same URI to the same backend pod — useful for caching or session affinity without sticky cookies.

### Traefik: Weighted Round Robin

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

Canary deployments made declarative. Send 30% of traffic to v2, keep 70% on v1, adjust weights as confidence grows. Traefik's weighted routing was more ergonomic than NGINX's equivalent annotation soup.

## Monitoring

### NGINX Metrics

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  enable-prometheus-metrics: "true"
```

Enable Prometheus metrics via ConfigMap. Standard request count, latency histograms, and upstream health — integrate with Grafana for dashboards.

### Traefik Metrics

Traefik exposes Prometheus metrics at `/metrics` out of the box. No ConfigMap toggle needed. The built-in dashboard also shows real-time request rates and backend health, which is nice for quick debugging without opening Grafana.

## Making the Choice

**Choose NGINX Ingress when:**

- You're handling high traffic and need maximum throughput
- Your team has existing NGINX expertise
- You need complex routing rules (regex paths, intricate rewrites)
- You want the largest community and most third-party resources
- You're on a cloud provider with well-tested NGINX integration

**Choose Traefik when:**

- You want dynamic configuration without reloads
- Built-in Let's Encrypt saves you from cert-manager setup
- Middleware as CRDs fits your GitOps workflow
- You want a dashboard for route debugging
- You're running a microservices cluster with moderate traffic
- Weighted routing for canary deployments is important

**Choose neither when:**

- You're on a cloud provider with a managed load balancer (ALB Ingress Controller on AWS, GCE Ingress on GCP) and don't need advanced routing features
- You need L4 (TCP/UDP) load balancing — Ingress is HTTP/S only; use a Service of type LoadBalancer or a dedicated L4 controller

## Operating Ingress Controllers Without Pain

Terminate TLS at the ingress controller, not at every pod. Centralized certificate management is simpler, and your app code doesn't need to know about HTTPS.

Set proxy timeouts explicitly. The defaults will hang connections when your slowest endpoint takes longer than expected. We debugged "random 504 errors" for a week before discovering the proxy-read-timeout was 60 seconds and our report endpoint averaged 75.

Configure rate limiting at the ingress layer for public-facing APIs. It's cheaper to reject abuse before it reaches your application pods.

Monitor request latency, error rates, and backend health at the ingress level — not just at the application level. Ingress metrics tell you about problems your app metrics can't see (upstream unreachable, TLS handshake failures, routing misconfigurations).

Set resource requests and limits on the controller pods. An ingress controller under memory pressure drops connections. Ask me how I learned this during a traffic spike.

Test failover. Kill backend pods, scale to zero, change service selectors — verify the ingress controller routes around failures correctly. The controller config looks fine until a pod dies and traffic goes nowhere.

Use health check endpoints on your backends. Ingress controllers route to pods that Kubernetes considers "ready." If your readiness probe is too permissive, you'll route traffic to pods that aren't actually serving requests.

## The Practical Conclusion

There's no wrong choice between NGINX and Traefik for most teams in 2019. Both are production-proven. Both handle SSL, path routing, and load balancing reliably.

NGINX is the safe default — maximum performance, maximum community, maximum annotation catalog. Traefik is the modern alternative — dynamic config, built-in dashboard, middleware CRDs, and a gentler onboarding curve for teams new to ingress.

What actually matters more than the controller choice:

1. **Install one and configure it correctly** — the controller gap kills more deployments than controller selection
2. **Automate TLS** — cert-manager or Traefik's built-in ACME
3. **Set timeouts and limits** — before production traffic finds the defaults
4. **Monitor ingress-level metrics** — not just application metrics
5. **Document your routing rules** — future you will forget why `/api/v2` goes to a different service

Your pods are running. Now make sure the world can reach them.

---

*Written November 2019, comparing NGINX Ingress Controller and Traefik v2. Kubernetes ingress has evolved significantly since — the Gateway API is emerging as a successor to the Ingress resource, and both controllers have added substantial features — but the core trade-offs between NGINX's maturity and Traefik's cloud-native ergonomics remain relevant.*

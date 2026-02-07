---
layout: post
title: "Kubernetes Network Policies: Security Best Practices"
date: 2021-07-15
categories: [How-To]
tags: [Kubernetes, Security, Network Policies]
excerpt: "Secure Kubernetes clusters with network policies. Learn how to restrict pod-to-pod communication, implement default deny policies, and enforce network segmentation."
---

Network policies control pod-to-pod communication. After securing production clusters, here's how to use them effectively.

## What are Network Policies?

Network policies:
- **Control traffic** - Allow/deny pod communication
- **Namespace isolation** - Segment by namespace
- **Pod selectors** - Target specific pods
- **Ingress/Egress** - Control both directions

## Basic Network Policy

### Default Deny

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

### Allow Specific Traffic

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-access
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    ports:
    - protocol: TCP
      port: 8080
```

## Common Patterns

### Frontend to Backend

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow-frontend
spec:
  podSelector:
    matchLabels:
      app: backend
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    ports:
    - protocol: TCP
      port: 8080
```

### Database Access

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-allow-backend
spec:
  podSelector:
    matchLabels:
      app: database
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: backend
    ports:
    - protocol: TCP
      port: 5432
```

### Cross-Namespace

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring
spec:
  podSelector:
    matchLabels:
      app: api
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
    - podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9090
```

## Egress Policies

### Allow DNS

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

### Allow External API

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-external-api
spec:
  podSelector:
    matchLabels:
      app: api
  egress:
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8
    ports:
    - protocol: TCP
      port: 443
```

## Best Practices

1. **Default deny** - Start restrictive
2. **Label pods** - Consistent labels
3. **Test policies** - Verify connectivity
4. **Document policies** - Clear purpose
5. **Monitor violations** - Track blocked traffic
6. **Use namespaces** - Logical grouping
7. **Least privilege** - Minimal access
8. **Review regularly** - Update as needed

## Conclusion

Network policies provide:
- Pod isolation
- Security boundaries
- Traffic control
- Defense in depth

Start with default deny, then allow specific traffic. The patterns shown here secure production clusters.

---

*Kubernetes Network Policies from July 2021, covering security best practices.*

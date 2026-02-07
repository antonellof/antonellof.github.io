---
layout: post
title: "Getting Started with Kubernetes: Pods, Services, and Deployments"
date: 2018-01-15
categories: [How-To]
tags: [Kubernetes, Containers, Orchestration, DevOps]
excerpt: "Introduction to Kubernetes fundamentals: pods, services, deployments, and basic operations. Learn how to deploy and manage containerized applications in Kubernetes."
---

Kubernetes has become the standard for container orchestration. After deploying applications to Kubernetes in production, I've learned that understanding the core concepts is essential. Here's a practical guide to getting started.

## What is Kubernetes?

Kubernetes (K8s) is an open-source container orchestration platform that:
- Manages containerized applications
- Provides service discovery and load balancing
- Handles scaling and self-healing
- Manages storage and secrets

## Core Concepts

### Pods

A Pod is the smallest deployable unit in Kubernetes—one or more containers sharing storage and network.

```yaml
# pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-pod
  labels:
    app: nginx
spec:
  containers:
  - name: nginx
    image: nginx:1.15
    ports:
    - containerPort: 80
```

Create and manage pods:

```bash
# Create pod
kubectl apply -f pod.yaml

# Get pods
kubectl get pods

# Describe pod
kubectl describe pod nginx-pod

# View logs
kubectl logs nginx-pod

# Delete pod
kubectl delete pod nginx-pod
```

### Deployments

Deployments manage Pod replicas and provide rolling updates:

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.15
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "64Mi"
            cpu: "250m"
          limits:
            memory: "128Mi"
            cpu: "500m"
```

Deployment operations:

```bash
# Create deployment
kubectl apply -f deployment.yaml

# Scale deployment
kubectl scale deployment nginx-deployment --replicas=5

# Update image
kubectl set image deployment/nginx-deployment nginx=nginx:1.16

# Rollout status
kubectl rollout status deployment/nginx-deployment

# Rollback
kubectl rollout undo deployment/nginx-deployment
```

### Services

Services provide stable networking for Pods:

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-service
spec:
  selector:
    app: nginx
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
  type: LoadBalancer
```

Service types:

```yaml
# ClusterIP (default) - Internal only
type: ClusterIP

# NodePort - Expose on node IP
type: NodePort
nodePort: 30080

# LoadBalancer - Cloud provider LB
type: LoadBalancer

# ExternalName - CNAME record
type: ExternalName
externalName: external-service.example.com
```

## Basic Application Deployment

### Multi-Container Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-pod
spec:
  containers:
  - name: app
    image: myapp:1.0
    ports:
    - containerPort: 8080
    env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: db-secret
          key: url
  - name: sidecar
    image: logger:1.0
    volumeMounts:
    - name: shared-logs
      mountPath: /var/log
  volumes:
  - name: shared-logs
    emptyDir: {}
```

### Complete Application Stack

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-app
  template:
    metadata:
      labels:
        app: web-app
    spec:
      containers:
      - name: app
        image: web-app:1.0
        ports:
        - containerPort: 8080
        env:
        - name: DB_HOST
          value: "postgres-service"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5

---
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web-app-service
spec:
  selector:
    app: web-app
  ports:
  - port: 80
    targetPort: 8080
  type: LoadBalancer
```

## ConfigMaps and Secrets

### ConfigMap

```yaml
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  database_url: "postgresql://localhost/mydb"
  log_level: "info"
  app.properties: |
    server.port=8080
    server.host=0.0.0.0
```

Use in Pod:

```yaml
spec:
  containers:
  - name: app
    envFrom:
    - configMapRef:
        name: app-config
    volumeMounts:
    - name: config
      mountPath: /etc/config
  volumes:
  - name: config
    configMap:
      name: app-config
```

### Secrets

```bash
# Create secret
kubectl create secret generic db-secret \
  --from-literal=username=admin \
  --from-literal=password=secret123

# Or from file
kubectl create secret generic db-secret \
  --from-file=username=./username.txt \
  --from-file=password=./password.txt
```

```yaml
# secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
data:
  username: YWRtaW4=  # base64 encoded
  password: c2VjcmV0MTIz
```

Use in Pod:

```yaml
spec:
  containers:
  - name: app
    env:
    - name: DB_USERNAME
      valueFrom:
        secretKeyRef:
          name: db-secret
          key: username
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef:
          name: db-secret
          key: password
```

## Health Checks

### Liveness Probe

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

### Readiness Probe

```yaml
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  successThreshold: 1
  failureThreshold: 3
```

### Startup Probe

```yaml
startupProbe:
  httpGet:
    path: /startup
    port: 8080
  initialDelaySeconds: 0
  periodSeconds: 10
  failureThreshold: 30
```

## Resource Management

### Requests and Limits

```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "250m"  # 0.25 CPU
  limits:
    memory: "512Mi"
    cpu: "500m"  # 0.5 CPU
```

### Namespace Resource Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: production
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
```

## Common Operations

### Port Forwarding

```bash
# Forward local port to pod
kubectl port-forward pod/nginx-pod 8080:80

# Forward to service
kubectl port-forward service/nginx-service 8080:80
```

### Exec into Pod

```bash
# Execute command in pod
kubectl exec -it nginx-pod -- /bin/bash

# Execute command
kubectl exec nginx-pod -- ls /var/log
```

### Copy Files

```bash
# Copy from pod
kubectl cp nginx-pod:/etc/nginx/nginx.conf ./nginx.conf

# Copy to pod
kubectl cp ./file.txt nginx-pod:/tmp/file.txt
```

## Best Practices

1. **Use Deployments** - Not Pods directly
2. **Set resource limits** - Prevent resource exhaustion
3. **Use health checks** - Ensure pod health
4. **Use ConfigMaps/Secrets** - Don't hardcode config
5. **Label everything** - For better organization
6. **Use namespaces** - Organize resources
7. **Monitor resources** - Track usage
8. **Version your manifests** - Use Git

## Conclusion

Kubernetes provides powerful container orchestration:
- Pods for containers
- Deployments for replicas
- Services for networking
- ConfigMaps/Secrets for configuration

Start with simple deployments, then add complexity. The patterns shown here handle production workloads.

---

*Kubernetes basics from January 2018, covering Kubernetes 1.9+ features.*

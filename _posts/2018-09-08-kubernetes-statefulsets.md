---
layout: post
title: "Kubernetes StatefulSets: Managing Stateful Applications"
date: 2018-09-08
categories: [Deep Dive]
tags: [Kubernetes, StatefulSets, State Management]
excerpt: "Deploy stateful applications in Kubernetes using StatefulSets. Learn about ordered deployment, stable network identities, persistent storage, and managing databases in Kubernetes."
---

StatefulSets enable running stateful applications in Kubernetes. After deploying databases and stateful services, here's how to use StatefulSets effectively.

## StatefulSets vs Deployments

### Deployments
- Stateless pods
- Random names
- No stable storage
- No ordering guarantees

### StatefulSets
- Stateful pods
- Stable names
- Persistent storage
- Ordered deployment

## Basic StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: "web"
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.15
        ports:
        - containerPort: 80
          name: web
        volumeMounts:
        - name: www
          mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
  - metadata:
      name: www
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: "fast-ssd"
      resources:
        requests:
          storage: 10Gi
```

## Headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  clusterIP: None  # Headless service
  selector:
    app: web
  ports:
  - port: 80
    name: web
```

## Stable Network Identity

Each pod gets:
- Stable hostname: `web-0`, `web-1`, `web-2`
- Stable DNS: `web-0.web.default.svc.cluster.local`

```bash
# Pods are accessible by name
ping web-0.web
ping web-1.web
ping web-2.web
```

## Ordered Deployment

```yaml
spec:
  podManagementPolicy: OrderedReady  # Default
  # Pods created sequentially: 0, then 1, then 2
```

### Parallel Pod Management

```yaml
spec:
  podManagementPolicy: Parallel
  # All pods created simultaneously
```

## Persistent Storage

### Volume Claim Template

```yaml
volumeClaimTemplates:
- metadata:
    name: data
  spec:
    accessModes: [ "ReadWriteOnce" ]
    storageClassName: "ssd"
    resources:
      requests:
        storage: 100Gi
```

Each pod gets its own PVC:
- `data-web-0`
- `data-web-1`
- `data-web-2`

## Database Example: PostgreSQL

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-config
data:
  postgresql.conf: |
    max_connections = 200
    shared_buffers = 256MB
    effective_cache_size = 1GB
    maintenance_work_mem = 64MB
    checkpoint_completion_target = 0.9
    wal_buffers = 16MB
    default_statistics_target = 100
    random_page_cost = 1.1
    effective_io_concurrency = 200
    work_mem = 4MB
    min_wal_size = 1GB
    max_wal_size = 4GB

---
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
type: Opaque
data:
  postgres-password: cG9zdGdyZXM=  # base64 encoded

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: "postgres"
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:13
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_DB
          value: mydb
        - name: POSTGRES_USER
          value: postgres
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: postgres-password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        - name: config
          mountPath: /etc/postgresql/postgresql.conf
          subPath: postgresql.conf
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U postgres
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U postgres
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: config
        configMap:
          name: postgres-config
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: "fast-ssd"
      resources:
        requests:
          storage: 100Gi
```

## Redis Cluster Example

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  serviceName: "redis"
  replicas: 6
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:6-alpine
        ports:
        - containerPort: 6379
          name: redis
        command:
        - redis-server
        - /etc/redis/redis.conf
        - --cluster-enabled
        - "yes"
        - --cluster-config-file
        - /data/nodes.conf
        - --cluster-node-timeout
        - "5000"
        - --appendonly
        - "yes"
        volumeMounts:
        - name: redis-data
          mountPath: /data
        - name: config
          mountPath: /etc/redis
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
      volumes:
      - name: config
        configMap:
          name: redis-config
  volumeClaimTemplates:
  - metadata:
      name: redis-data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: "fast-ssd"
      resources:
        requests:
          storage: 20Gi
```

## Scaling StatefulSets

```bash
# Scale up
kubectl scale statefulset web --replicas=5

# Scale down (pods removed in reverse order)
kubectl scale statefulset web --replicas=2
```

### Update Strategy

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 2  # Update pods 2, 3, 4... but not 0, 1
```

## Pod Disruption Budget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: web
```

## Init Containers

```yaml
spec:
  template:
    spec:
      initContainers:
      - name: init-db
        image: busybox
        command:
        - sh
        - -c
        - |
          if [ ! -f /data/initialized ]; then
            echo "Initializing database..."
            touch /data/initialized
          fi
        volumeMounts:
        - name: data
          mountPath: /data
      containers:
      - name: app
        # ...
```

## StatefulSet Updates

### Rolling Update

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
```

### OnDelete Strategy

```yaml
spec:
  updateStrategy:
    type: OnDelete
  # Pods updated only when manually deleted
```

## Best Practices

1. **Use headless services** - For stable DNS
2. **Set resource limits** - Prevent resource exhaustion
3. **Use init containers** - For initialization
4. **Configure health checks** - Liveness and readiness
5. **Set pod disruption budgets** - Maintain availability
6. **Use appropriate storage** - Fast storage for databases
7. **Monitor storage** - Track disk usage
8. **Backup data** - Regular backups of persistent volumes

## Common Patterns

### Master-Slave Pattern

```yaml
# Master pod (index 0)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: mysql
        command:
        - /bin/sh
        - -c
        - |
          if [ "$(hostname)" = "mysql-0" ]; then
            # Master configuration
            mysqld --server-id=1 --log-bin
          else
            # Slave configuration
            mysqld --server-id=$HOSTNAME_NUM --replicate-from=mysql-0
          fi
```

### Leader Election

```yaml
# Use init container for leader election
initContainers:
- name: elect-leader
  image: leader-elector:latest
  env:
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
```

## Conclusion

StatefulSets enable:
- Stable pod identities
- Persistent storage
- Ordered deployment
- Stateful applications

Use StatefulSets for databases, caches, and any application requiring stable identity and storage. The patterns shown here handle production workloads.

---

*Kubernetes StatefulSets from September 2018, covering Kubernetes 1.11+ features.*

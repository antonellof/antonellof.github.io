---
layout: post
title: "Kubernetes StatefulSets: Managing Stateful Applications"
date: 2018-09-08
categories: [Deep Dive]
tags: [Kubernetes, StatefulSets, State Management]
excerpt: "Deployments gave us elastic web servers. StatefulSets gave us databases that didn't forget who they were after every restart. Here's how we learned the difference the hard way."
---

My first attempt to run PostgreSQL on Kubernetes used a Deployment. Three replicas, shared PVC, fingers crossed. It worked great until the first pod restart — at which point three Postgres instances all thought they were the primary, our data directory looked like modern art, and I gained a healthy respect for workloads that have *opinions* about identity.

**Stateful applications remember things.** They care about hostname. They expect storage to follow them around. They want to start up in a predictable order. Deployments treat every pod like an interchangeable intern. StatefulSets treat each pod like a named employee with a desk and a filing cabinet.

If you're running databases, message brokers, or anything that writes to disk and gossip with peers, you want StatefulSets. Here's what we figured out deploying them in production on Kubernetes 1.11+.

## Deployments vs StatefulSets: Know Your Pod's Personality

| | Deployment | StatefulSet |
|---|---|---|
| Pod names | Random hash suffix | Stable ordinal: `web-0`, `web-1` |
| Storage | Shared or none | Dedicated PVC per pod |
| Startup order | All at once | Sequential (by default) |
| Network identity | Ephemeral | Stable DNS per pod |
| Best for | Web APIs, workers | Databases, queues, clusters |

The mental model: **Deployments scale out stateless work. StatefulSets scale out stateful work.** Mixing them up is how you get data corruption and 3 AM pages.

## Your First StatefulSet (With Storage That Sticks)

This nginx example is deliberately simple — the interesting part is `volumeClaimTemplates`, which gives each pod its own PersistentVolumeClaim:

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

When this creates three pods, Kubernetes also creates three PVCs: `www-web-0`, `www-web-1`, `www-web-2`. Kill `web-1`, and when it comes back, it reattaches to the same volume. Your data doesn't wander off.

## The Headless Service: DNS Names That Actually Mean Something

StatefulSets require a **headless Service** (`clusterIP: None`). Without it, pods get network identities but no way for peers to find each other. With it, each pod is reachable at a predictable DNS name:

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

Each pod gets:
- **Stable hostname:** `web-0`, `web-1`, `web-2`
- **Stable DNS:** `web-0.web.default.svc.cluster.local`

```bash
# Pods are accessible by name
ping web-0.web
ping web-1.web
ping web-2.web
```

This is non-negotiable for clustered databases. "Connect to whoever is available" doesn't work when you're setting up replication and one node needs to know it's `postgres-0` and the other is `postgres-1`.

## Ordered Deployment: Patience, Kubernetes Style

By default, StatefulSets use `podManagementPolicy: OrderedReady`:

```yaml
spec:
  podManagementPolicy: OrderedReady  # Default
  # Pods created sequentially: 0, then 1, then 2
```

Pod 1 won't start until pod 0 is Running and Ready. Annoying when you're impatient; essential when pod 1 needs to join a cluster that pod 0 initialized.

For workloads that don't care about order (some cache layers, stateless-ish workers with sticky storage), you can go parallel:

```yaml
spec:
  podManagementPolicy: Parallel
  # All pods created simultaneously
```

We use OrderedReady for anything involving leader election or primary/replica setup. Parallel for Redis cluster nodes once the cluster bootstrap script handles concurrent joins.

## Persistent Storage: One Disk Per Pod, No Sharing

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

**ReadWriteOnce** means one node mounts it at a time — which is what you want for a database. Don't try to share one PVC across pods unless you enjoy filesystem corruption.

Pick your `storageClassName` carefully. Databases on slow network-attached storage feel fine in dev and miserable under load.

## PostgreSQL on Kubernetes: The Example We Wish We'd Had Sooner

This isn't "Postgres in prod on K8s is easy" — it's "if you're going to do it, do it with eyes open." ConfigMap for tuning, Secret for credentials, probes that actually check readiness:

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

Honest caveat from 2018: many teams run Postgres *outside* Kubernetes and keep K8s for stateless apps. That's often the right call. But when you need it in-cluster, StatefulSets are the tool — not Deployments with wishful thinking.

## Redis Cluster: StatefulSets for Distributed Cache

Redis Cluster wants stable identities and persistent node configuration:

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

Six replicas because Redis Cluster wants three masters and three replicas. Resource limits prevent one noisy neighbor from evicting the whole node.

## Scaling: Up Is Easy, Down Requires Thought

```bash
# Scale up
kubectl scale statefulset web --replicas=5

# Scale down (pods removed in reverse order)
kubectl scale statefulset web --replicas=2
```

Scale-down removes highest-index pods first (`web-4`, then `web-3`). **That PVC sticks around by default** — which is usually what you want (data survives), but means scaling down doesn't free storage costs until you manually delete orphaned PVCs.

For rolling updates, you can partition the rollout to update replicas incrementally:

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 2  # Update pods 2, 3, 4... but not 0, 1
```

Set `partition: 0` to roll all pods; set it to `replicas` to pause updates entirely. Handy for canary-testing a new image on the highest-index pod first.

## Protecting Availability During Chaos

Kubernetes will happily evict your database pods during node maintenance. A PodDisruptionBudget says "not all at once, please":

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

For a 3-replica StatefulSet, `minAvailable: 2` means at most one pod can be disrupted at a time. Without this, a cluster upgrade can take down your entire database tier simultaneously.

## Init Containers: First-Day Setup Without Custom Images

Need to initialize data before the main container starts? Init containers run to completion before the app container launches:

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

We use init containers for schema migrations, config templating, and "wait until the leader pod is ready" logic.

## Update Strategies: Rolling vs OnDelete

**RollingUpdate** (default) — Kubernetes updates pods in reverse ordinal order, one at a time.

**OnDelete** — Pods update only when you manually delete them. Useful when you want full control over maintenance windows:

```yaml
spec:
  updateStrategy:
    type: OnDelete
  # Pods updated only when manually deleted
```

We default to RollingUpdate with a partition for staged rollouts. OnDelete for production databases where "automatic" and "database" shouldn't share a sentence without careful review.

## Patterns That Show Up in Real Clusters

### Master-Slave by Pod Index

Pod `mysql-0` becomes master; everyone else replicates from it. The hostname is stable, so the startup script can branch:

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

It's crude, but explicit — and sometimes crude beats a complex operator you don't fully understand yet.

### Leader Election

For workloads that need a single active leader:

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

## What We Do Differently Now

Headless services are mandatory — we don't deploy StatefulSets without them. Resource requests and limits go on every container; stateful workloads without limits are future eviction victims. Liveness and readiness probes must test actual readiness (`pg_isready`, not "port is open"). PDBs protect every production StatefulSet. Fast storage classes for databases, with disk usage alerts because PVCs don't shrink themselves. And backups happen outside the StatefulSet lifecycle — Kubernetes keeps pods alive; it doesn't replace your backup strategy.

## The Bottom Line

StatefulSets exist because some software has memory — literal and figurative. They give you stable names, sticky storage, ordered startup, and DNS that peers can rely on. Deployments are brilliant for stateless apps. For databases, caches, and clustered stateful services, StatefulSets are the difference between "it runs" and "it survives Tuesday."

Just please don't run three Postgres primaries on a shared volume. Some lessons you only need to learn once.

---

*Written September 2018, covering Kubernetes 1.11+ StatefulSet features. Kubernetes storage, operators, and managed database offerings have matured significantly since — evaluate whether in-cluster state is still the right tradeoff for your team.*

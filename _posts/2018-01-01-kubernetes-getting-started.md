---
layout: post
title: "Getting Started with Kubernetes: Pods, Services, and Deployments"
date: 2018-01-01
categories: [How-To]
tags: [Kubernetes, Containers, Orchestration, DevOps]
excerpt: "I learned Kubernetes the hard way—by deploying to production before I understood what a Pod actually was. Here's the mental model that finally made it click."
---

The first time I ran `kubectl get pods` in production, I saw three nginx containers in `CrashLoopBackOff` and felt a very specific kind of dread. Not panic exactly—more like the feeling you get when you realize you've been driving on the highway with the parking brake on.

I'd containerized our apps with Docker. That part felt like progress. Then someone said "we should move to Kubernetes," and suddenly I was staring at YAML files that looked like someone had copy-pasted a small novel into a terminal. Pods. Services. Deployments. ConfigMaps. Secrets. Probes with names like they belonged in a medical drama.

Kubernetes isn't magic. It's a very opinionated babysitter for containers. Once you understand *why* it makes the decisions it makes, the YAML stops feeling like incantations and starts feeling like configuration. This is the guide I wish I'd had before that first production deploy.

## What Kubernetes Actually Does (Besides Generate YAML)

Kubernetes (K8s—because eight letters between K and s is a tradition now) is an open-source container orchestration platform. In plain terms, it:

- Runs your containerized applications across a cluster of machines
- Gives them stable networking even when containers die and respawn like video game enemies
- Scales replicas up and down based on demand
- Restarts unhealthy containers before your pager goes off
- Manages storage volumes and secrets without you hardcoding passwords into Dockerfiles like it's 2009

The key insight: **you almost never manage individual containers directly**. You declare what you want, and Kubernetes fights reality until reality matches your declaration. Sometimes reality wins. Those are the interesting days.

## Pods: The Smallest Unit That Matters

A Pod is the smallest deployable unit in Kubernetes. It's one or more containers that share storage and network—think of it as a tiny host that happens to live inside your cluster.

Why not just deploy containers directly? Because Kubernetes needs a consistent abstraction. Sidecars, init containers, shared volumes—all of that lives at the Pod level. A Pod is ephemeral by design. It gets created, it does its job, it dies. You don't nurse individual Pods back to health; you let Deployments replace them.

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

For learning and debugging, Pods are great. For production? Resist the urge to deploy bare Pods. I learned this when a node got drained for maintenance and our "production" nginx Pod vanished like it had never existed. Because, structurally, it hadn't—there was nothing to recreate it.

```bash
# Create pod
kubectl apply -f pod.yaml

# Get pods
kubectl get pods

# Describe pod (your best friend when things go wrong)
kubectl describe pod nginx-pod

# View logs
kubectl logs nginx-pod

# Delete pod
kubectl delete pod nginx-pod
```

`kubectl describe` is the command you will run at 2 AM. It tells you *why* something is failing, not just *that* it's failing. Bookmark that thought.

## Deployments: How You Actually Run Things in Production

A Deployment manages Pod replicas and handles rolling updates. This is the resource you want for anything that needs to stay running.

The mental model: you tell Kubernetes "I want 3 copies of this app running," and it maintains that invariant. Pod dies? New one spawns. New image pushed? Rolling update swaps them out one at a time. Bad deploy? Rollback to the previous version before your users notice (ideally).

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

Notice the `resources` section. We'll come back to why this matters more than most teams realize.

```bash
# Create deployment
kubectl apply -f deployment.yaml

# Scale deployment
kubectl scale deployment nginx-deployment --replicas=5

# Update image
kubectl set image deployment/nginx-deployment nginx=nginx:1.16

# Rollout status (watch the drama unfold)
kubectl rollout status deployment/nginx-deployment

# Rollback (the button you'll wish you had sooner)
kubectl rollout undo deployment/nginx-deployment
```

That rollback command has saved more Friday afternoons than I'd like to admit. Kubernetes keeps a rollout history by default. Use it.

## Services: Because Pods Have Commitment Issues

Here's the problem with Pods: they don't have stable identities. A Pod gets an IP address when it's born, and that IP dies with it. If you're routing traffic directly to Pod IPs, you're building a system that breaks every time Kubernetes does exactly what it's designed to do—replace failed Pods.

Services solve this. A Service provides a stable network endpoint that routes to a set of Pods matching a label selector. Pods come and go; the Service address stays the same.

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

Kubernetes offers four Service types, and picking the wrong one is a rite of passage:

```yaml
# ClusterIP (default) - Internal only. Other pods can reach it; the internet cannot.
type: ClusterIP

# NodePort - Expose on every node's IP at a static port. Fine for dev, awkward for prod.
type: NodePort
nodePort: 30080

# LoadBalancer - Cloud provider spins up an actual load balancer. Costs money, works great.
type: LoadBalancer

# ExternalName - DNS CNAME to an external service. For when you need K8s to know about something outside the cluster.
type: ExternalName
externalName: external-service.example.com
```

**ClusterIP** for internal service-to-service communication. **LoadBalancer** for things that need to face the internet. **NodePort** when you're prototyping and don't want to wait for a cloud LB to provision. **ExternalName** when you're integrating with something Kubernetes doesn't own.

## Putting It Together: A Real Application Stack

### Multi-Container Pods (Sidecar Pattern)

Sometimes one container isn't enough. Log shipping, proxies, monitoring agents—the sidecar pattern puts a helper container alongside your main app, sharing a volume.

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

The sidecar reads logs from the shared volume and ships them somewhere useful. Your main app doesn't need to know logging infrastructure exists. Clean separation.

### Deployment + Service: The Minimum Viable Production Setup

This is the pattern you'll deploy 90% of the time:

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

Three replicas for availability. Health checks so Kubernetes knows when to restart vs. when to pull traffic. A Service so traffic has somewhere stable to go. This is not fancy, and that's the point—it works.

## ConfigMaps and Secrets: Stop Hardcoding Things

### ConfigMaps for Non-Sensitive Configuration

If it's not a password, it probably belongs in a ConfigMap.

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

Wire it into your Pod:

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

You can inject ConfigMap values as environment variables or mount them as files. File mounts are nice when your app expects a config file on disk and you don't want to rewrite it to read env vars.

### Secrets for Things You Don't Want in Git

Secrets are ConfigMaps with a security theater upgrade. They're base64-encoded, not encrypted, unless you enable encryption at rest. Treat them as "don't accidentally commit this" rather than "Fort Knox."

```bash
# Create secret from literals
kubectl create secret generic db-secret \
  --from-literal=username=admin \
  --from-literal=password=secret123

# Or from files (better for anything you don't want in shell history)
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

Reference in your Pod:

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

In production, pair this with something like HashiCorp Vault or your cloud provider's secrets manager. Kubernetes Secrets are a delivery mechanism, not a secrets management strategy.

## Health Checks: The Difference Between "Running" and "Working"

Kubernetes gives you three probe types. Understanding the distinction prevents you from either killing healthy containers or routing traffic to broken ones.

### Liveness Probe: "Is This Process Alive?"

If the liveness probe fails, Kubernetes **restarts the container**. Use this for detecting deadlocks or hung processes—situations where the process exists but isn't doing anything useful.

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

Don't point liveness at dependencies. If your database is down and `/health` checks the database, Kubernetes will restart your app in an infinite loop while the database is still down. That's not healing—that's chaos with extra steps.

### Readiness Probe: "Can This Handle Traffic?"

If the readiness probe fails, Kubernetes **removes the Pod from Service endpoints**. The container keeps running; it just stops receiving traffic until it's ready again.

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

This is where dependency checks belong. Database not connected? Not ready. Cache warming up? Not ready. Traffic waits; no restart storm.

### Startup Probe: "Give It a Minute"

For slow-starting applications, a startup probe prevents liveness probes from killing your container before it's finished booting.

```yaml
startupProbe:
  httpGet:
    path: /startup
    port: 8080
  initialDelaySeconds: 0
  periodSeconds: 10
  failureThreshold: 30
```

With `failureThreshold: 30` and `periodSeconds: 10`, Kubernetes will wait up to 5 minutes for your app to start before the liveness probe kicks in. JVM apps, I'm looking at you.

## Resource Management: The Thing Everyone Skips Until It's Too Late

### Requests and Limits

Without resource limits, one runaway container can starve everything else on the node. Ask me how I know.

```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "250m"  # 0.25 CPU
  limits:
    memory: "512Mi"
    cpu: "500m"  # 0.5 CPU
```

**Requests** tell the scheduler how much capacity to reserve. **Limits** cap what a container can actually use. Set requests based on normal usage; set limits with headroom for spikes. Setting limits without requests is like reserving a hotel room but not telling anyone which one.

### Namespace Resource Quotas

When you have multiple teams sharing a cluster, quotas prevent one team from accidentally (or deliberately) consuming everything.

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

Namespaces are your organizational boundary. Use them. "Everything in default" is a strategy that works until it very much doesn't.

## Operations You'll Actually Use

### Port Forwarding: Local Dev's Best Friend

```bash
# Forward local port to pod
kubectl port-forward pod/nginx-pod 8080:80

# Forward to service
kubectl port-forward service/nginx-service 8080:80
```

This tunnels traffic from your laptop into the cluster. Indispensable for debugging without exposing services publicly.

### Exec into a Pod: When Logs Aren't Enough

```bash
# Shell into pod
kubectl exec -it nginx-pod -- /bin/bash

# One-off command
kubectl exec nginx-pod -- ls /var/log
```

Sometimes you need to see what's actually on the filesystem. `kubectl exec` is your SSH equivalent.

### Copy Files: For Config Debugging

```bash
# Copy from pod
kubectl cp nginx-pod:/etc/nginx/nginx.conf ./nginx.conf

# Copy to pod
kubectl cp ./file.txt nginx-pod:/tmp/file.txt
```

Pulling a config file locally to diff against what you expected is faster than squinting at `kubectl describe` output.

## What I'd Tell Past Me

**Use Deployments, not bare Pods.** Pods are cattle, not pets—but only if something is responsible for replacing them when they wander off.

**Set resource requests and limits on everything.** The cluster doesn't have infinite CPU, and your app isn't the only one running. Underspecified resources lead to throttling, OOM kills, and very confusing latency spikes.

**Separate liveness from readiness.** Liveness restarts; readiness gates traffic. Mixing dependency checks into liveness probes creates restart loops that look like hauntings.

**Externalize configuration.** ConfigMaps for settings, Secrets for credentials, Git for manifests. The number of production incidents caused by config baked into images is embarrassing across our entire industry.

**Label everything.** Labels are how Services find Pods, how you filter `kubectl get`, and how you make sense of a cluster with 200 resources. `app: web-app` is a minimum. Add `version`, `environment`, `team` as needed.

**Use namespaces.** Even if you're a team of three. Future you will want isolation when you add staging, or a second product, or that one experimental service someone swore would be temporary.

**Version your manifests in Git.** `kubectl apply` from someone's laptop is not a deployment strategy. GitOps isn't mandatory, but reproducibility is.

**Monitor before you need to.** You will not notice gradual memory leaks from `kubectl get pods`. Wire up metrics early.

## Where to Start

Kubernetes is a lot. The good news: you don't need to understand every resource type on day one.

Start with a Deployment, a Service, and a ConfigMap. Deploy something simple—a stateless web app with a health endpoint. Scale it. Break it. Roll it back. Port-forward into it and read the logs.

Once that feels boring, add Secrets, probes, and resource limits. Then namespaces. Then Ingress. Each layer solves a real problem you'll eventually have.

The patterns in this post aren't theoretical—they're the baseline for production workloads. Pods run your containers. Deployments keep them running. Services give them addresses. ConfigMaps and Secrets keep configuration out of your images. Probes tell Kubernetes when to help and when to wait.

Kubernetes doesn't make operations easy. It makes operations *repeatable*. And once you've had a bad deploy roll back in thirty seconds while you finish your coffee, repeatable starts to feel a lot like magic.

---

*Written in January 2018, covering Kubernetes 1.9+ features. The core concepts hold; the ecosystem around them has only grown.*

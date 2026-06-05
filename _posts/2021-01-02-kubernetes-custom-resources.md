---
layout: post
title: "Advanced Kubernetes: Custom Resources and Operators"
date: 2021-01-02
categories: [Deep Dive]
tags: [Kubernetes, CRD, Operators]
excerpt: "kubectl apply -f database.yaml and get a running PostgreSQL instance—that's what operators do. CRDs extend Kubernetes' API with your domain, and operators make it actually work."
render_with_liquid: false
---

I watched a platform engineer manually provision databases for the third time that week. Copy Deployment YAML. Adjust environment variables. Create PVC. Set up Service. Wait. Repeat for Redis. Repeat for RabbitMQ. Same steps, different values, error-prone and boring.

"We should automate this," someone said. Shell scripts worked until they didn't—no status tracking, no self-healing, no lifecycle management when someone deleted a resource.

Custom Resource Definitions (CRDs) and operators are Kubernetes' answer: **extend the API with your domain concepts, then encode operational knowledge in a controller that reconciles desired state with actual state.**

Instead of `kubectl apply -f postgres-deployment.yaml`, you write `kubectl apply -f database.yaml` with `kind: Database`. The operator handles the rest. It's the pattern behind Prometheus, Istio, and every managed-database operator you've used.

## Custom Resources: Your API, Kubernetes' Machinery

Kubernetes stores everything as resources (Pods, Deployments, Services). CRDs let you define new resource types:

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.example.com
spec:
  group: example.com
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              databaseName:
                type: string
              databaseUser:
                type: string
              size:
                type: string
                enum: ["small", "medium", "large"]
          status:
            type: object
            properties:
              phase:
                type: string
              message:
                type: string
              ready:
                type: boolean
  scope: Namespaced
  names:
    plural: databases
    singular: database
    kind: Database
```

Apply the CRD, and `Database` becomes a first-class Kubernetes resource:

```bash
kubectl apply -f crd.yaml
kubectl get databases  # It works
```

### Creating Instances

```yaml
apiVersion: example.com/v1
kind: Database
metadata:
  name: my-database
spec:
  databaseName: mydb
  databaseUser: admin
  size: medium
```

```bash
kubectl apply -f database-instance.yaml
kubectl get databases
# NAME          AGE
# my-database   5s
```

Without an operator, this does nothing useful—Kubernetes stores the YAML and waits. The operator is what makes it real.

## The Operator Pattern: Reconciliation Loop

An operator watches custom resources and takes action to match desired state:

1. **Watch** — observe Database resources (create, update, delete)
2. **Reconcile** — compare desired spec vs actual cluster state
3. **Act** — create/update/delete Deployments, Services, PVCs
4. **Update status** — report phase (Creating, Ready, Failed)

```go
func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db examplev1.Database
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }
    
    if db.Status.Phase == "" {
        db.Status.Phase = "Creating"
        if err := r.Status().Update(ctx, &db); err != nil {
            return ctrl.Result{}, err
        }
    }
    
    if err := r.createDatabase(ctx, &db); err != nil {
        db.Status.Phase = "Failed"
        db.Status.Message = err.Error()
        r.Status().Update(ctx, &db)
        return ctrl.Result{}, err
    }
    
    db.Status.Phase = "Ready"
    db.Status.Ready = true
    return ctrl.Result{}, r.Status().Update(ctx, &db)
}

func (r *DatabaseReconciler) createDatabase(ctx context.Context, db *examplev1.Database) error {
    deployment := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      db.Name,
            Namespace: db.Namespace,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: int32Ptr(1),
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{"app": db.Name},
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{"app": db.Name},
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{{
                        Name:  "postgres",
                        Image: "postgres:13",
                        Env: []corev1.EnvVar{
                            {Name: "POSTGRES_DB", Value: db.Spec.DatabaseName},
                            {Name: "POSTGRES_USER", Value: db.Spec.DatabaseUser},
                        },
                    }},
                },
            },
        },
    }
    
    return r.Create(ctx, deployment)
}
```

The reconcile loop runs continuously. Delete the Deployment manually? Operator recreates it. Change `size` from small to medium? Operator adjusts resources. This is Kubernetes' superpower—**declarative state with automatic correction**.

## Operator SDK: Don't Start From Scratch

```bash
# Install Operator SDK
curl -LO https://github.com/operator-framework/operator-sdk/releases/download/v1.28.0/operator-sdk_linux_amd64
chmod +x operator-sdk && sudo mv operator-sdk /usr/local/bin/

# Scaffold a new operator
operator-sdk init --domain example.com --repo github.com/example/database-operator
operator-sdk create api --group example --version v1 --kind Database --resource --controller

make generate
make manifests
```

The SDK generates CRD manifests, Go types, controller boilerplate, and RBAC rules. You fill in reconciliation logic. [Kubebuilder](https://book.kubebuilder.io/) (which powers the SDK) is the standard toolchain.

## Status Updates: Tell Users What's Happening

```go
db.Status.Phase = "Ready"
db.Status.Message = "Database is ready"
db.Status.Ready = true
r.Status().Update(ctx, &db)
```

Users run `kubectl get databases` and see status. Without status updates, they're kubectl-describing Pods wondering why nothing works. Status is your UX.

## Finalizers: Clean Cleanup

When someone deletes a Database, you need to clean up PVCs, backups, external resources:

```go
const finalizerName = "database.example.com/finalizer"

func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db examplev1.Database
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        return ctrl.Result{}, err
    }
    
    if !containsString(db.Finalizers, finalizerName) {
        db.Finalizers = append(db.Finalizers, finalizerName)
        return ctrl.Result{}, r.Update(ctx, &db)
    }
    
    if !db.DeletionTimestamp.IsZero() {
        if err := r.cleanup(ctx, &db); err != nil {
            return ctrl.Result{}, err
        }
        db.Finalizers = removeString(db.Finalizers, finalizerName)
        return ctrl.Result{}, r.Update(ctx, &db)
    }
    
    // Normal reconciliation...
    return ctrl.Result{}, nil
}
```

Without finalizers, `kubectl delete database` removes the CR but leaves orphaned Deployments and PVCs. Finalizers block deletion until cleanup completes.

## Production Lessons

1. **Idempotent reconciliation** — running twice produces the same result
2. **Owner references** — child resources (Deployments) owned by parent (Database) for garbage collection
3. **RBAC** — operator ServiceAccount with minimal required permissions
4. **Leader election** — multiple operator replicas, only one reconciles
5. **Webhook validation** — reject invalid specs before they reach reconciliation
6. **Version your CRDs** — `v1alpha1` → `v1beta1` → `v1` with conversion webhooks
7. **Test with envtest** — unit test controllers without a real cluster

## When to Build an Operator

**Build an operator when:**
- You deploy the same complex application repeatedly
- Operational knowledge is tribal ("ask Dave how to set up Redis")
- You need day-2 operations (backup, upgrade, scaling) automated
- Platform team wants self-service for product teams

**Skip the operator when:**
- It's a one-off deployment (Helm chart is enough)
- The application doesn't need lifecycle management
- Nobody on the team knows Go (operators are typically Go)

Helm installs. Operators manage. Different tools, different problems.

## Conclusion

CRDs extend Kubernetes' API with your domain language. Operators encode operational expertise into software that runs 24/7. Together, they turn "ask platform team to provision a database" into "apply a YAML file and wait for Ready status."

The manual database provisioning that started this post became `kubectl apply -f database.yaml`. Product teams self-served. Platform team wrote the operator once and maintained it instead of doing the same manual steps weekly.

Start with a simple CRD and a controller that creates one Deployment. Add status, finalizers, and cleanup incrementally. Use Operator SDK. Read existing operators ([postgres-operator](https://github.com/zalando/postgres-operator), [prometheus-operator](https://github.com/prometheus-operator/prometheus-operator)) for patterns.

Kubernetes' power is declarative infrastructure. CRDs and operators let you declare *your* infrastructure—not just Pods and Services, but Databases, Queues, and Pipelines. That's platform engineering.

---

*Kubernetes Custom Resources and Operators from January 2021, covering CRDs and operator patterns.*

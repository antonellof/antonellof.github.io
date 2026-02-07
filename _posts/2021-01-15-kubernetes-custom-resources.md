---
layout: post
title: "Advanced Kubernetes: Custom Resources and Operators"
date: 2021-01-15
categories: [Deep Dive]
tags: [Kubernetes, CRD, Operators]
excerpt: "Extend Kubernetes with Custom Resource Definitions (CRDs) and operators. Learn how to create custom resources, build operators, and automate Kubernetes operations."
---

Kubernetes Custom Resources extend the API. After building production operators, here's how to create CRDs and operators effectively.

## What are Custom Resources?

Custom Resources:
- **Extend** Kubernetes API
- **Custom objects** - Domain-specific
- **Operators** - Automation logic
- **Declarative** - Desired state

## Custom Resource Definition

### Basic CRD

```yaml
# crd.yaml
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
  scope: Namespaced
  names:
    plural: databases
    singular: database
    kind: Database
```

### Create CRD

```bash
kubectl apply -f crd.yaml
```

## Custom Resource Instance

### Create Resource

```yaml
# database-instance.yaml
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
```

## Operator Pattern

### Operator Components

1. **Controller** - Watches resources
2. **Reconciler** - Ensures desired state
3. **Finalizer** - Cleanup logic

### Operator Implementation (Go)

```go
package main

import (
    "context"
    "fmt"
    
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller"
    "sigs.k8s.io/controller-runtime/pkg/manager"
)

type DatabaseReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db examplev1.Database
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }
    
    // Reconcile logic
    if db.Status.Phase == "" {
        db.Status.Phase = "Creating"
        if err := r.Status().Update(ctx, &db); err != nil {
            return ctrl.Result{}, err
        }
    }
    
    // Create database instance
    if err := r.createDatabase(ctx, &db); err != nil {
        return ctrl.Result{}, err
    }
    
    db.Status.Phase = "Ready"
    if err := r.Status().Update(ctx, &db); err != nil {
        return ctrl.Result{}, err
    }
    
    return ctrl.Result{}, nil
}

func (r *DatabaseReconciler) createDatabase(ctx context.Context, db *examplev1.Database) error {
    // Create PostgreSQL instance
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
                    Containers: []corev1.Container{
                        {
                            Name:  "postgres",
                            Image: "postgres:13",
                            Env: []corev1.EnvVar{
                                {Name: "POSTGRES_DB", Value: db.Spec.DatabaseName},
                                {Name: "POSTGRES_USER", Value: db.Spec.DatabaseUser},
                            },
                        },
                    },
                },
            },
        },
    }
    
    return r.Create(ctx, deployment)
}

func main() {
    mgr, err := manager.New(cfg, manager.Options{})
    if err != nil {
        panic(err)
    }
    
    if err = (&DatabaseReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr); err != nil {
        panic(err)
    }
    
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        panic(err)
    }
}
```

## Operator SDK

### Install Operator SDK

```bash
# Install
curl -LO https://github.com/operator-framework/operator-sdk/releases/download/v1.28.0/operator-sdk_linux_amd64
chmod +x operator-sdk
sudo mv operator-sdk /usr/local/bin/
```

### Create Operator

```bash
# Create new operator
operator-sdk init --domain example.com --repo github.com/example/database-operator

# Create API
operator-sdk create api --group example --version v1 --kind Database --resource --controller

# Generate code
make generate
make manifests
```

## Status Updates

### Update Status

```go
func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db examplev1.Database
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        return ctrl.Result{}, err
    }
    
    // Update status
    db.Status.Phase = "Ready"
    db.Status.Message = "Database is ready"
    db.Status.Ready = true
    
    if err := r.Status().Update(ctx, &db); err != nil {
        return ctrl.Result{}, err
    }
    
    return ctrl.Result{}, nil
}
```

## Finalizers

### Add Finalizer

```go
func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db examplev1.Database
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        return ctrl.Result{}, err
    }
    
    // Add finalizer if not present
    if !containsString(db.ObjectMeta.Finalizers, finalizerName) {
        db.ObjectMeta.Finalizers = append(db.ObjectMeta.Finalizers, finalizerName)
        if err := r.Update(ctx, &db); err != nil {
            return ctrl.Result{}, err
        }
    }
    
    // Handle deletion
    if db.ObjectMeta.DeletionTimestamp.IsZero() {
        // Normal reconcile
    } else {
        // Cleanup
        if err := r.cleanup(ctx, &db); err != nil {
            return ctrl.Result{}, err
        }
        
        // Remove finalizer
        db.ObjectMeta.Finalizers = removeString(db.ObjectMeta.Finalizers, finalizerName)
        if err := r.Update(ctx, &db); err != nil {
            return ctrl.Result{}, err
        }
    }
    
    return ctrl.Result{}, nil
}
```

## Best Practices

1. **Idempotent operations** - Safe retries
2. **Status updates** - Reflect current state
3. **Finalizers** - Cleanup resources
4. **Error handling** - Graceful failures
5. **Logging** - Debug information
6. **Testing** - Unit and integration tests
7. **Documentation** - Clear usage
8. **Versioning** - CRD versions

## Conclusion

Custom Resources and Operators enable:
- Kubernetes API extension
- Domain-specific abstractions
- Automation
- Declarative operations

Start with simple CRDs, then build operators. The patterns shown here handle production workloads.

---

*Kubernetes Custom Resources and Operators from January 2021, covering CRDs and operator patterns.*

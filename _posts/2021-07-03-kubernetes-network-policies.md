---
layout: post
title: "Kubernetes Network Policies: Security Best Practices"
date: 2021-07-03
categories: [How-To]
tags: [Kubernetes, Security, Network Policies]
excerpt: "In Kubernetes, every pod talks to every pod by default. Network policies fix that—default deny, explicit allow, and the day we discovered our staging database was reachable from production."
---

Kubernetes networking is permissive by default. Every pod can reach every other pod in the cluster. Every pod can reach the internet. Every pod can be reached from anywhere that can reach the cluster.

This is convenient for development. In production, it's how a compromised frontend container exfiltrates data through a backend that has database access, or how a misconfigured staging service corrupts production data because nothing stopped it from reaching the production database.

We discovered our staging API could query the production PostgreSQL instance. Same cluster, different namespaces, no network restrictions. Nobody intended this. Kubernetes allowed it by default.

Network policies fix this: **firewall rules for pods**. Define what's allowed, deny everything else. They're the difference between "we trust our code" and "we assume breach."

## Prerequisites: Your CNI Must Support Them

Network policies are Kubernetes resources, but enforcement requires a CNI plugin that supports them: Calico, Cilium, Weave Net, or similar. Flannel's default config doesn't enforce network policies.

Verify before investing time:

```bash
kubectl get networkpolicies --all-namespaces  # Should not error
# Check your CNI docs for NetworkPolicy support
```

If policies exist but nothing is blocked, your CNI isn't enforcing them. Ask me how I know.

## Default Deny: Start Here

The most important policy: block everything, then allow specifically.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}      # Applies to ALL pods in namespace
  policyTypes:
  - Ingress
  - Egress
```

`podSelector: {}` matches every pod. With no `ingress` or `egress` rules, all traffic is denied. Your pods are now isolated—probably too isolated. Add allow policies next.

**Apply default deny per namespace**, not cluster-wide. Production gets locked down. Development stays permissive (or less locked down).

## Allow Specific Traffic: Layer by Layer

### Frontend → Backend

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow-frontend
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: backend
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

Only frontend pods can reach backend pods on port 8080. Not staging frontend. Not random debug pods. Not the internet.

### Backend → Database

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-allow-backend
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: database
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: backend
    ports:
    - protocol: TCP
      port: 5432
```

Database only accepts connections from backend pods. The compromised frontend from our breach scenario? Can't reach the database directly.

### Cross-Namespace Access

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
      podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9090
```

Prometheus in the `monitoring` namespace can scrape metrics. Production API doesn't accept connections from elsewhere.

**This is how we fixed staging → production:** explicit namespace selectors ensuring only production backend reaches production database.

## Egress Policies: Control Outbound Too

Ingress policies are common. Egress is overlooked—and it's how data exfiltration happens.

### Allow DNS (Required)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

Without DNS egress, pods can't resolve hostnames. Everything breaks mysteriously. Add this before any other egress policy.

### Allow External APIs

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow-external
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: payment-api
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8      # Block internal ranges
        - 172.16.0.0/12
        - 192.168.0.0/16
    ports:
    - protocol: TCP
      port: 443
```

Payment API can reach external HTTPS endpoints but not internal cluster IPs. Limits lateral movement if compromised.

## Implementation Strategy

Don't deploy all policies at once. You'll lock yourself out.

**Phase 1: Audit** — map current traffic flows (who talks to whom)

**Phase 2: Label everything** — network policies select by labels; unlabeled pods are invisible to policies

```yaml
# Every deployment needs consistent labels
metadata:
  labels:
    app: backend
    tier: api
    env: production
```

**Phase 3: Default deny in production** — one namespace, verify nothing breaks

**Phase 4: Add allow policies** — one service at a time, test between each

**Phase 5: Egress policies** — after ingress is stable

**Phase 6: Extend to staging/other namespaces**

We used Calico's policy visualization and temporary logging policies to discover traffic we didn't know about. Expect surprises.

## Testing Network Policies

```bash
# Test from a debug pod
kubectl run debug --rm -it --image=nicolaka/netshoot -- bash

# Inside the pod:
curl http://backend-service:8080/health    # Should work if policy allows
nc -zv database-service 5432              # Should fail if policy denies
```

`nicolaka/netshoot` is a Swiss Army knife for network debugging. Keep a debug pod manifest handy.

## Common Gotchas

**Kubelet health checks:** If using network policies on pods with liveness/readiness probes, ensure kubelet can reach pods (usually from host network—not blocked by pod network policies).

**Same-namespace traffic:** `podSelector` without `namespaceSelector` only matches pods in the same namespace.

**Policy doesn't apply to the pod itself:** Network policies filter traffic TO/FROM pods—they don't affect the pod's own outbound identity.

**DNS in kube-system:** DNS egress must target kube-system namespace where CoreDNS runs.

**CNI not enforcing:** Policies exist in API but traffic flows unrestricted. Verify CNI support.

## Monitoring and Compliance

- **Calico/Cilium dashboards** — visualize allowed and denied flows
- **Policy audit tools** — [netpol-analyzer](https://github.com/sozercan/kubectl-netassert), Cilium Hubble
- **GitOps policies** — version control network policies like application code
- **Regular review** — new services need new policies; stale policies accumulate

## Conclusion

Network policies implement zero-trust inside your cluster. Default allow is Kubernetes' out-of-box behavior; default deny is security's requirement. The gap between them is how staging queries production databases.

Start with default deny in production. Add ingress allows service by service. Don't forget DNS egress. Label your pods consistently. Test with netshoot before declaring victory.

Our staging-to-production incident wouldn't have happened with a five-line NetworkPolicy restricting database access to production backend pods. Five lines. That's the ROI of network segmentation in Kubernetes.

Pods shouldn't trust each other just because they share a cluster. Network policies make that distrust enforceable.

---

*Kubernetes Network Policies from July 2021, covering security best practices.*

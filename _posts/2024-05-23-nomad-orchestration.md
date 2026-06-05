---
layout: post
title: "Nomad: Simple and Flexible Orchestration"
date: 2024-05-23
categories: [How-To]
tags: [Nomad, Orchestration, Containers, DevOps]
excerpt: "Orchestrate workloads with HashiCorp Nomad: job scheduling, multi-cloud deployment, container and VM support, and when to choose Nomad over Kubernetes."
render_with_liquid: false
---

[HashiCorp Nomad](https://www.nomadproject.io/) is the orchestrator you reach for when Kubernetes feels like overkill. It schedules containers, VMs, Java apps, static binaries—basically anything—across your infrastructure with a fraction of Kubernetes's operational complexity.

I switched to Nomad after wrestling with Kubernetes for a 10-server deployment. K8s is powerful but complex: etcd clusters, CNI plugins, ingress controllers, service meshes. For our needs (schedule some Docker containers, maybe some batch jobs), it was like using a crane to hang a picture. Nomad felt like using a hammer—simple tool, right job.

The operational model is elegant: run Nomad servers (consensus via Raft), run Nomad clients (execute workloads), submit job specs (HCL files), done. No separate scheduler, no node controllers, no 50 CRDs to learn.

Created by [HashiCorp](https://www.hashicorp.com/), Nomad integrates beautifully with Consul (service discovery) and Vault (secrets). Together they form a cohesive infrastructure stack.

## Nomad vs Kubernetes

| Feature | Nomad | Kubernetes |
|---------|-------|------------|
| Learning curve | Low | High |
| Operational overhead | Minimal | Significant |
| Workload types | Containers, VMs, binaries, Java | Containers only |
| Cluster size | 10-10,000 nodes | 100-5,000 nodes |
| Community size | Smaller | Massive |
| Cloud native features | Basic | Extensive |
| Good for | Small-medium deployments | Large, complex systems |

**Choose Nomad when:**
- Team size <20 people
- Running diverse workloads (not just containers)
- Want operational simplicity
- Multi-cloud or hybrid cloud
- Need to schedule batch jobs, cron jobs, services together

**Choose Kubernetes when:**
- Large teams need advanced features
- Heavy investment in K8s ecosystem
- Need extensive tooling (Helm, operators, etc.)
- Cloud-native best practices required

Read [Nomad vs Kubernetes](https://www.nomadproject.io/docs/nomad-vs-kubernetes) for official comparison.

## Core Architecture

**Servers** - Form consensus quorum (Raft), make scheduling decisions. Run 3-5 servers for HA.

**Clients** - Execute tasks on behalf of servers. Can be 10 or 10,000 nodes.

**Jobs** - Declarative specs written in HCL (HashiCorp Configuration Language). Like Kubernetes Deployments but simpler.

**Allocations** - Running instances of tasks. Nomad places allocations on clients based on resources and constraints.

**Drivers** - Execute workloads: Docker, `exec` (raw binaries), Java, QEMU (VMs), and custom plugins.

Install Nomad (single binary!):

```bash
# Download latest release
curl -LO https://releases.hashicorp.com/nomad/1.7.5/nomad_1.7.5_linux_amd64.zip
unzip nomad_1.7.5_linux_amd64.zip
sudo mv nomad /usr/local/bin/

# Verify
nomad version

# Start dev agent (single node, not for production)
nomad agent -dev
```

For production, see [deployment guide](https://developer.hashicorp.com/nomad/tutorials/enterprise/production-deployment-guide-vm-with-consul).

## Writing Job Specifications

Jobs are written in HCL:

```hcl
# web-app.nomad.hcl
job "web-app" {
  datacenters = ["dc1"]
  type = "service"
  
  group "app" {
    count = 3  # Run 3 instances
    
    network {
      port "http" {
        to = 8080
      }
    }
    
    task "server" {
      driver = "docker"
      
      config {
        image = "nginx:1.25"
        ports = ["http"]
      }
      
      resources {
        cpu    = 500  # MHz
        memory = 256  # MB
      }
      
      service {
        name = "web-app"
        port = "http"
        
        check {
          type     = "http"
          path     = "/health"
          interval = "10s"
          timeout  = "2s"
        }
      }
    }
  }
}
```

Deploy:
```bash
# Validate job file
nomad job validate web-app.nomad.hcl

# Plan changes (like terraform plan)
nomad job plan web-app.nomad.hcl

# Run job
nomad job run web-app.nomad.hcl

# Check status
nomad job status web-app

# View logs
nomad alloc logs <allocation-id>
```

### Batch Jobs

```hcl
job "data-pipeline" {
  datacenters = ["dc1"]
  type = "batch"  # Runs once, exits
  
  group "etl" {
    task "extract" {
      driver = "docker"
      
      config {
        image = "python:3.11"
        command = "python"
        args = ["etl.py"]
      }
      
      # Artifact fetching
      artifact {
        source = "https://example.com/etl.py"
      }
      
      resources {
        cpu    = 2000
        memory = 4096
      }
    }
  }
}
```

### Periodic Jobs (Cron)

```hcl
job "backup" {
  datacenters = ["dc1"]
  type = "batch"
  
  periodic {
    cron             = "0 2 * * *"  # Daily at 2am
    prohibit_overlap = true  # Don't run if previous still running
    time_zone        = "America/New_York"
  }
  
  group "backup" {
    task "run-backup" {
      driver = "exec"
      
      config {
        command = "/usr/local/bin/backup.sh"
      }
    }
  }
}
```

## Integration with Consul and Vault

Nomad shines when combined with [Consul](https://www.consul.io/) and [Vault](https://www.vaultproject.io/):

### Service Discovery with Consul

Nomad automatically registers services:

```hcl
task "api" {
  driver = "docker"
  
  config {
    image = "api:latest"
    ports = ["http"]
  }
  
  service {
    name = "api"
    port = "http"
    tags = ["v1", "production"]
    
    # Health check
    check {
      type     = "http"
      path     = "/health"
      interval = "10s"
      timeout  = "2s"
    }
    
    # Connect for service mesh (mTLS)
    connect {
      sidecar_service {}
    }
  }
}
```

Other services discover via Consul DNS:
```bash
curl http://api.service.consul:8080/users
```

### Secrets Management with Vault

Inject secrets securely:

```hcl
task "app" {
  driver = "docker"
  
  vault {
    policies = ["app-policy"]
  }
  
  template {
    data = <<EOF
DATABASE_URL={{ with secret "database/creds/app" }}{{ .Data.connection_url }}{{ end }}
API_KEY={{ with secret "secret/api-key" }}{{ .Data.key }}{{ end }}
EOF
    destination = "secrets/app.env"
    env         = true
  }
  
  config {
    image = "app:latest"
  }
}
```

Vault issues short-lived credentials, automatically renewed by Nomad.

## Production Best Practices

1. **Use namespaces** - Isolate teams:
```bash
nomad namespace apply -description "Dev team" dev
nomad job run -namespace=dev app.nomad.hcl
```

2. **Enable ACLs** - Secure the API:
```bash
nomad acl bootstrap
nomad acl policy apply developer developer-policy.hcl
```

3. **Monitor with Prometheus** - Export metrics:
```hcl
telemetry {
  prometheus_metrics = true
  publish_allocation_metrics = true
  publish_node_metrics = true
}
```

4. **Backup state** - Snapshot Raft data:
```bash
nomad operator snapshot save backup.snap
```

5. **Use `nomad plan`** - Validate before applying:
```bash
nomad job plan app.nomad.hcl
# Shows what will change, like terraform plan
```

6. **Set resource limits** - Prevent resource exhaustion:
```hcl
resources {
  cpu    = 1000  # MHz
  memory = 1024  # MB
  
  memory_max = 2048  # Hard limit
}
```

7. **Implement health checks** - Detect and restart failed tasks:
```hcl
service {
  check {
    type     = "http"
    path     = "/health"
    interval = "10s"
    timeout  = "2s"
    
    check_restart {
      limit = 3
      grace = "10s"
    }
  }
}
```

## Conclusion

Nomad proves orchestration doesn't have to be complex. A single binary, simple HCL job specs, and multi-workload support make it pragmatic for teams that don't need Kubernetes's complexity.

The HashiCorp ecosystem integration is seamless: Consul for service discovery, Vault for secrets, Terraform for infrastructure. Everything works together naturally.

For small-to-medium deployments, Nomad hits a sweet spot: powerful enough for production, simple enough that one person can manage it. When your alternative is Kubernetes and you don't need its advanced features, Nomad is worth serious consideration.

**Further Resources:**
- [Nomad Documentation](https://developer.hashicorp.com/nomad/docs) - Comprehensive guides
- [Nomad Tutorials](https://developer.hashicorp.com/nomad/tutorials) - Hands-on learning
- [GitHub Repository](https://github.com/hashicorp/nomad) - Source code
- [Job Specification](https://developer.hashicorp.com/nomad/docs/job-specification) - HCL reference
- [Consul Integration](https://developer.hashicorp.com/nomad/docs/integrations/consul-integration) - Service discovery
- [Vault Integration](https://developer.hashicorp.com/nomad/docs/integrations/vault-integration) - Secrets management
- [Nomad Community Forum](https://discuss.hashicorp.com/c/nomad/) - Get help

---

*Nomad orchestration from May 2024, expanded with practical patterns and operational guidance.*

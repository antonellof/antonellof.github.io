---
layout: post
title: "Consul: Service Discovery and Configuration"
date: 2024-10-21
categories: [How-To]
tags: [Consul, Service Discovery, Networking, Configuration]
excerpt: "Service discovery with HashiCorp Consul: service mesh, DNS integration, health checking, and how Consul enables dynamic infrastructure."
---

[HashiCorp Consul](https://www.consul.io/) is a service mesh solution that provides service discovery, health checking, and distributed configuration. In a world of ephemeral infrastructure—containers, autoscaling, serverless—Consul answers the question: "How do I find and connect to my services?"

I introduced Consul to replace hardcoded service IPs. We were using microservices with Docker, and service locations changed constantly. Configuration files were filled with IP addresses that broke every deployment. Consul's DNS interface (`api.service.consul`) and automatic health checking eliminated that fragility entirely.

Consul does multiple things: service registry, health checking, key/value store, service mesh (Connect), and multi-datacenter federation. You can use pieces independently or the whole platform.

Created by [HashiCorp](https://www.hashicorp.com/), Consul integrates with Nomad (orchestration) and Vault (secrets) for a complete infrastructure stack.

## Core Features

**Service Discovery** - Services register themselves, others discover via DNS or HTTP API.

**Health Checking** - Automatic health checks with configurable intervals and timeouts.

**Service Mesh (Connect)** - Automatic mTLS between services, no code changes.

**KV Store** - Distributed key-value store for configuration.

**Multi-Datacenter** - WAN federation across regions.

Read [Consul architecture](https://developer.hashicorp.com/consul/docs/architecture) for details.

## Installation and Setup

Install Consul (single binary):

```bash
# Download latest release
curl -LO https://releases.hashicorp.com/consul/1.17.2/consul_1.17.2_linux_amd64.zip
unzip consul_1.17.2_linux_amd64.zip
sudo mv consul /usr/local/bin/

# Verify
consul version

# Start dev agent (single node, not for production)
consul agent -dev
```

For production, run 3-5 servers for HA. See [deployment guide](https://developer.hashicorp.com/consul/tutorials/production-deploy/deployment-guide).

## Service Registration

### Via Configuration File

```json
// /etc/consul.d/web-api.json
{
  "service": {
    "name": "web-api",
    "tags": ["v1", "production"],
    "port": 8080,
    "check": {
      "http": "http://localhost:8080/health",
      "interval": "10s",
      "timeout": "1s"
    }
  }
}
```

Reload Consul to pick up the service:
```bash
consul reload
```

### Via HTTP API

```bash
# Register service
curl -X PUT http://localhost:8500/v1/agent/service/register \
  -d '{
    "ID": "web-api-1",
    "Name": "web-api",
    "Tags": ["v1"],
    "Port": 8080,
    "Check": {
      "HTTP": "http://localhost:8080/health",
      "Interval": "10s"
    }
  }'

# Deregister service
curl -X PUT http://localhost:8500/v1/agent/service/deregister/web-api-1
```

### Via SDK (Go example)

```go
package main

import (
    "github.com/hashicorp/consul/api"
    "log"
)

func main() {
    // Create client
    config := api.DefaultConfig()
    client, err := api.NewClient(config)
    if err != nil {
        log.Fatal(err)
    }
    
    // Register service
    registration := &api.AgentServiceRegistration{
        ID:      "web-api-instance-1",
        Name:    "web-api",
        Port:    8080,
        Tags:    []string{"v1", "production"},
        Check: &api.AgentServiceCheck{
            HTTP:     "http://localhost:8080/health",
            Interval: "10s",
            Timeout:  "1s",
        },
    }
    
    err = client.Agent().ServiceRegister(registration)
    if err != nil {
        log.Fatal(err)
    }
    
    log.Println("Service registered")
}
```

## Service Discovery

### DNS Interface

Consul provides a DNS server on port 8600:

```bash
# Lookup service
dig @127.0.0.1 -p 8600 web-api.service.consul

# Returns A records for healthy instances:
# web-api.service.consul. 0 IN A 10.1.2.3
# web-api.service.consul. 0 IN A 10.1.2.4

# SRV records include port information
dig @127.0.0.1 -p 8600 web-api.service.consul SRV

# Use in application
curl http://web-api.service.consul:8080/users
```

Configure system DNS to forward `.consul` queries:

```bash
# /etc/systemd/resolved.conf
[Resolve]
DNS=127.0.0.1:8600
Domains=~consul
```

### HTTP API

```bash
# List all services
curl http://localhost:8500/v1/catalog/services | jq

# Get service instances
curl http://localhost:8500/v1/catalog/service/web-api | jq

# Health check query (only healthy instances)
curl http://localhost:8500/v1/health/service/web-api?passing | jq

# Filter by tag
curl http://localhost:8500/v1/health/service/web-api?tag=production | jq
```

### Application Integration (Python)

```python
import consul
import requests

# Create Consul client
c = consul.Consul()

# Discover service
index, services = c.health.service('web-api', passing=True)

if services:
    # Pick first healthy instance (or implement load balancing)
    service = services[0]['Service']
    address = service['Address']
    port = service['Port']
    
    # Make request
    response = requests.get(f'http://{address}:{port}/users')
    print(response.json())
else:
    print("No healthy instances found")
```

## Health Checking

Consul supports multiple check types:

### HTTP Check

```json
{
  "check": {
    "http": "http://localhost:8080/health",
    "interval": "10s",
    "timeout": "1s"
  }
}
```

### TCP Check

```json
{
  "check": {
    "tcp": "localhost:5432",
    "interval": "10s",
    "timeout": "1s"
  }
}
```

### Script Check

```json
{
  "check": {
    "args": ["/usr/local/bin/check-db.sh"],
    "interval": "30s",
    "timeout": "5s"
  }
}
```

### TTL Check (Application reports)

```json
{
  "check": {
    "ttl": "30s",
    "deregister_critical_service_after": "90s"
  }
}
```

Application updates check status:

```bash
# Mark as passing
curl -X PUT http://localhost:8500/v1/agent/check/pass/service:web-api

# Mark as failing
curl -X PUT http://localhost:8500/v1/agent/check/fail/service:web-api
```

## Service Mesh with Consul Connect

[Consul Connect](https://developer.hashicorp.com/consul/docs/connect) provides automatic mTLS between services:

### Enable Connect

```json
{
  "service": {
    "name": "web-api",
    "port": 8080,
    "connect": {
      "sidecar_service": {
        "port": 20000
      }
    }
  }
}
```

### Configure Service Intentions

Control which services can communicate:

```bash
# Allow database-api to call web-api
consul intention create -allow web-api database

# Deny public-api from calling internal-service
consul intention create -deny public-api internal-service

# List intentions
consul intention list
```

### Transparent Proxy

Route traffic through sidecars automatically:

```bash
# Start sidecar proxy
consul connect proxy -sidecar-for web-api

# Application connects to localhost, proxy handles mTLS
curl http://localhost:8080/users
# Traffic is automatically encrypted to upstream services
```

## Key/Value Store

Use Consul's KV store for configuration:

```bash
# Put key
consul kv put config/database/host db.example.com
consul kv put config/database/port 5432

# Get key
consul kv get config/database/host

# List keys
consul kv get -recurse config/

# Delete key
consul kv delete config/database/host
```

### Watch for Changes

```bash
# Watch for config changes
consul watch -type=key -key=config/database/host \
  sh -c 'echo "Config changed"; restart-app.sh'
```

### In Application (Python)

```python
import consul
import json

c = consul.Consul()

# Read configuration
index, data = c.kv.get('config/database', recurse=True)

config = {}
for item in data:
    key = item['Key'].split('/')[-1]
    value = item['Value'].decode('utf-8')
    config[key] = value

print(f"DB Host: {config['host']}")
print(f"DB Port: {config['port']}")
```

## Production Best Practices

1. **Run 3-5 servers** - For Raft consensus and HA
2. **Enable ACLs** - Secure the API:
```bash
consul acl bootstrap
```

3. **Use prepared queries** - For failover:
```bash
consul prepared query create \
  -name web-api-failover \
  -service web-api \
  -failover-datacenters dc2,dc3
```

4. **Monitor Raft health**:
```bash
consul operator raft list-peers
```

5. **Backup KV store**:
```bash
consul snapshot save backup.snap
```

6. **Set appropriate check intervals** - Balance freshness vs load

7. **Use service tags for versioning** - `["v1"]`, `["v2"]` for gradual rollouts

## Conclusion

Consul solves the "how do I find my services" problem elegantly. The DNS interface requires zero code changes—just point applications at `service.consul` instead of hardcoded IPs. The HTTP API provides rich metadata for advanced use cases.

The health checking system is robust: multiple check types, configurable intervals, automatic deregistration of failed services. Combined with the service mesh (Connect), Consul provides both discovery and secure communication.

For dynamic infrastructure—containers, autoscaling, multi-cloud—Consul is essential. It turns ephemeral services into addressable, discoverable, secure components.

**Further Resources:**
- [Consul Documentation](https://developer.hashicorp.com/consul/docs) - Comprehensive guides
- [Consul Tutorials](https://developer.hashicorp.com/consul/tutorials) - Hands-on learning
- [GitHub Repository](https://github.com/hashicorp/consul) - Source code
- [Consul Connect](https://developer.hashicorp.com/consul/docs/connect) - Service mesh
- [Service Discovery Patterns](https://microservices.io/patterns/service-registry.html) - Architecture patterns
- [Consul API](https://developer.hashicorp.com/consul/api-docs) - HTTP API reference
- [Consul Community Forum](https://discuss.hashicorp.com/c/consul/) - Get help

---

*Consul service discovery from October 2024, covering production patterns and Connect mesh.*

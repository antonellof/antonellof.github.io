---
layout: post
title: "AI-Powered Code Execution: Security Considerations"
date: 2024-11-15
categories: [Case Study]
tags: [AI, Security, Code Execution, Sandboxing]
excerpt: "Secure AI-powered code execution: sandboxing, resource limits, input validation, and security patterns for safely executing AI-generated code."
---

Letting AI-generated code run in production sounds terrifying—and it should. Every code execution platform I've built has been an exercise in defense-in-depth: assume the code is malicious, limit blast radius, monitor everything.

The challenge: AI coding assistants like GitHub Copilot, Cursor, and ChatGPT generate code that users want to run immediately. Online REPLs, notebook environments, and CI/CD systems execute untrusted code constantly. How do you allow this while preventing: cryptocurrency mining, data exfiltration, privilege escalation, or resource exhaustion?

This post covers the security architecture that works—learned from building code execution sandboxes that process millions of untrusted snippets.

## Threat Model

Assume worst-case scenarios:

**Malicious actors** - Users intentionally trying to break out of sandboxes, mine crypto, or attack infrastructure.

**Compromised AI** - LLM outputs poisoned by adversarial prompts to generate malicious code.

**Resource exhaustion** - Infinite loops, memory bombs, fork bombs consuming resources.

**Data exfiltration** - Accessing secrets, environment variables, files, or making network requests to attacker-controlled servers.

**Privilege escalation** - Breaking out of containers to access host system.

The goal: **defense-in-depth**. When one layer fails (and it will), others catch it.

## Layer 1: Sandboxing Technologies

Choose the right isolation level for your threat model:

### Containers (Docker)

Good baseline, but **not secure enough alone**. Containers share the kernel with the host.

```python
import docker

client = docker.from_env()

container = client.containers.run(
    image='python:3.11-slim',
    command='python -c "print(1+1)"',
    
    # Resource limits
    mem_limit='128m',
    memswap_limit='128m',  # No swap
    cpu_quota=50000,  # 50% of one CPU
    cpu_period=100000,
    
    # Security options
    cap_drop=['ALL'],  # Drop all Linux capabilities
    security_opt=['no-new-privileges'],  # Prevent privilege escalation
    read_only=True,  # Read-only filesystem
    network_disabled=True,  # No network
    
    # Cleanup
    remove=True,
    detach=False,
    stdout=True,
    stderr=True,
    
    # Timeout (handle in code)
    timeout=10
)

print(container.decode())
```

**Pros**: Lightweight, fast startup (~1-2s), easy to use
**Cons**: Shared kernel, potential escape vulnerabilities
**Use for**: Low-sensitivity code, when combined with other layers

### gVisor

[gVisor](https://gvisor.dev/) provides a user-space kernel that intercepts syscalls. More secure than bare Docker.

```bash
# Install gVisor runtime
sudo apt-get update && sudo apt-get install -y runsc

# Configure Docker to use gVisor
cat <<EOF | sudo tee /etc/docker/daemon.json
{
  "runtimes": {
    "runsc": {
      "path": "/usr/bin/runsc"
    }
  }
}
EOF

sudo systemctl restart docker

# Run with gVisor
docker run --runtime=runsc --rm python:3.11 python -c "print('sandboxed')"
```

**Pros**: Better isolation than Docker, reasonable overhead (~30% slower)
**Cons**: Not all syscalls supported, some compatibility issues
**Use for**: Medium security, production code execution

### Firecracker MicroVMs

[Firecracker](https://firecracker-microvm.github.io/) provides VM-level isolation with container-like speed.

```python
import subprocess
import json

# Start Firecracker VM
config = {
    "boot-source": {
        "kernel_image_path": "/path/to/vmlinux",
        "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
    },
    "drives": [{
        "drive_id": "rootfs",
        "path_on_host": "/path/to/rootfs.ext4",
        "is_root_device": True,
        "is_read_only": False
    }],
    "machine-config": {
        "vcpu_count": 1,
        "mem_size_mib": 512
    }
}

# Configure and start via API
# Boot time: ~125ms
# Isolation: Full VM
```

**Pros**: VM-level security, fast boot (<125ms), used by AWS Lambda
**Cons**: Requires Linux KVM, more operational complexity
**Use for**: High security, multi-tenant platforms

### WebAssembly (Wasm)

[Wasmtime](https://wasmtime.dev/) or [Wasmer](https://wasmer.io/) for ultra-secure, portable execution.

```python
from wasmtime import Store, Module, Instance

# Load Wasm module
store = Store()
module = Module.from_file(store.engine, "code.wasm")
instance = Instance(store, module, [])

# Execute function
add = instance.exports(store)["add"]
result = add(store, 5, 3)  # Returns 8

# No access to filesystem, network, or host system by default
```

**Pros**: Perfect sandboxing, no syscalls, portable, near-native speed
**Cons**: Limited language support, requires compilation to Wasm
**Use for**: Ultimate security, supported languages (Rust, C, Go, Python via tools)

### E2B Code Interpreter

For a managed solution, [E2B](https://e2b.dev/) provides secure cloud sandboxes:

```python
from e2b import Sandbox

# Create isolated sandbox
with Sandbox() as sandbox:
    # Execute code securely
    result = sandbox.run_code("""
import pandas as pd
df = pd.DataFrame({'a': [1, 2, 3]})
print(df.sum())
    """)
    
    print(result.stdout)  # Prints: a    6
    print(result.stderr)
    print(result.error)
```

**Pros**: Fully managed, secure by default, supports multiple languages
**Cons**: Network latency, cost, external dependency
**Use for**: Quick implementation, don't want to manage infrastructure

## Layer 2: Resource Limits

Prevent resource exhaustion with hard limits:

### CPU Time

```python
import resource
import signal

def timeout_handler(signum, frame):
    raise TimeoutError("Execution exceeded time limit")

# Set alarm for wall-clock time
signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(10)  # 10 seconds

# Set CPU time limit (more precise)
resource.setrlimit(resource.RLIMIT_CPU, (5, 5))  # 5 seconds of CPU

try:
    exec(untrusted_code)
except TimeoutError:
    print("Code execution timed out")
finally:
    signal.alarm(0)  # Cancel alarm
```

### Memory

```python
import resource

# Limit virtual memory to 128MB
MAX_MEMORY = 128 * 1024 * 1024  # bytes
resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY, MAX_MEMORY))

# Also limit stack size
resource.setrlimit(resource.RLIMIT_STACK, (8 * 1024 * 1024, 8 * 1024 * 1024))

# Now code can't allocate more than 128MB
try:
    exec(untrusted_code)
except MemoryError:
    print("Code exceeded memory limit")
```

### Process Limits

```python
# Prevent fork bombs
resource.setrlimit(resource.RLIMIT_NPROC, (10, 10))  # Max 10 processes

# Limit file descriptors
resource.setrlimit(resource.RLIMIT_NOFILE, (10, 10))  # Max 10 open files
```

### Kubernetes ResourceQuotas

For production, use Kubernetes resource limits:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: code-sandbox
spec:
  containers:
  - name: executor
    image: python:3.11
    resources:
      requests:
        memory: "64Mi"
        cpu: "100m"
      limits:
        memory: "128Mi"  # Hard limit
        cpu: "500m"      # 50% of one core
    securityContext:
      runAsNonRoot: true
      runAsUser: 1000
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
```

## Production Architecture

Here's a complete secure code execution system:

```
┌─────────────┐
│   User/AI   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│  Input Validation       │
│  - AST analysis         │
│  - Size limits          │
│  - Secret detection     │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│  Queue (Redis/RabbitMQ) │
│  - Rate limiting        │
│  - Priority             │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│  Executor Workers       │
│  - gVisor containers    │
│  - Resource limits      │
│  - Timeout enforcement  │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│  Monitoring             │
│  - Metrics (Prometheus) │
│  - Logs (ELK)          │
│  - Alerts (PagerDuty)   │
└─────────────────────────┘
```

## Best Practices Checklist

- ✅ **Use VM or microVM isolation** for high-value targets
- ✅ **Drop all Linux capabilities** in containers
- ✅ **Disable network access** by default, whitelist if needed
- ✅ **Enforce CPU and memory limits** at multiple layers
- ✅ **Set execution timeouts** (wall-clock and CPU time)
- ✅ **Validate input** with AST analysis before execution
- ✅ **Run as non-root user** always
- ✅ **Use read-only filesystems** where possible
- ✅ **Implement rate limiting** per user/IP
- ✅ **Monitor and alert** on anomalies
- ✅ **Audit log everything** for forensics
- ✅ **Keep sandboxes ephemeral** - destroy after use
- ✅ **Update regularly** - patch sandbox OS/runtime
- ✅ **Test escape attempts** - red team your system

## Conclusion

Securing AI code execution is hard but solvable. The key is defense-in-depth: combine multiple security layers so no single failure compromises the system.

Start with the strongest isolation you can afford (Firecracker or gVisor), add resource limits, validate inputs, monitor everything, and test relentlessly. Assume attackers will try—because they will.

The good news: This problem is mostly solved. Use existing tools (gVisor, Firecracker, E2B) rather than rolling your own. The bad news: You still need to understand the layers and configure them correctly.

AI code execution will become ubiquitous. Building it securely isn't optional—it's table stakes.

**Further Resources:**
- [gVisor Documentation](https://gvisor.dev/docs/) - Secure container runtime
- [Firecracker Guide](https://github.com/firecracker-microvm/firecracker/tree/main/docs) - microVM setup
- [E2B](https://e2b.dev/) - Managed code sandboxes
- [Wasmtime](https://wasmtime.dev/) - WebAssembly runtime
- [Docker Security Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
- [OWASP Secure Coding](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/) 
- [AWS Lambda Security](https://docs.aws.amazon.com/lambda/latest/dg/lambda-security.html) - How Firecracker is used

---

*AI code execution security from November 2024, covering sandboxing and security patterns.*

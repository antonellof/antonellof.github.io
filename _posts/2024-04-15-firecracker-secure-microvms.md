---
layout: post
title: "Firecracker: Secure and Fast microVMs"
date: 2024-04-15
categories: [Deep Dive]
tags: [Firecracker, microVMs, Virtualization, AWS Lambda]
excerpt: "Explore Firecracker: lightweight microVMs, fast boot times, security isolation, and how Firecracker powers AWS Lambda and other serverless platforms."
---

[Firecracker](https://firecracker-microvm.github.io/) is AWS's open-source virtualization technology that powers Lambda, Fargate, and other serverless services. It boots microVMs in under 125ms with minimal memory overhead (~5MB), combining container-like density with VM-level security isolation.

The key insight: most serverless workloads don't need full VMs with BIOS, bootloaders, and hundreds of device drivers. Strip that away, keep just KVM and a minimal device model, and you get Firecracker—fast enough to spin up per-request, secure enough for multi-tenant platforms.

I first experimented with Firecracker building a code execution sandbox. Docker containers weren't isolated enough (shared kernel), and traditional VMs were too slow (10+ second boot times). Firecracker hit the sweet spot: VM security with near-container speed.

## Architecture

Firecracker is built on [KVM](https://www.linux-kvm.org/) (Kernel-based Virtual Machine) and uses Rust for memory safety. Each microVM runs its own kernel and minimal device model:

- **virtio devices**: Network, block storage (fast paravirtualized I/O)
- **Rate limiters**: CPU and I/O rate limiting per VM
- **Jailer**: Additional security layer (seccomp, cgroups, namespaces)
- **API-driven**: HTTP API for VM lifecycle management

No BIOS, no PCI bus, no legacy devices. Just what's needed for running workloads.

Read the [Firecracker design document](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) for architectural details.

## Getting Started

Install Firecracker (requires Linux with KVM):

```bash
# Download latest release
ARCH=$(uname -m)
VERSION="v1.7.0"
curl -LOJ https://github.com/firecracker-microvm/firecracker/releases/download/${VERSION}/firecracker-${VERSION}-${ARCH}.tgz

tar -xzf firecracker-${VERSION}-${ARCH}.tgz
sudo mv release-${VERSION}-${ARCH}/firecracker-${VERSION}-${ARCH} /usr/local/bin/firecracker
sudo mv release-${VERSION}-${ARCH}/jailer-${VERSION}-${ARCH} /usr/local/bin/jailer

# Verify
firecracker --version
```

### Create a MicroVM

Firecracker uses an HTTP API. Start the API server:

```bash
# Remove old socket if exists
rm -f /tmp/firecracker.socket

# Start Firecracker
firecracker --api-sock /tmp/firecracker.socket
```

In another terminal, configure and start the VM:

```bash
# Set boot source (kernel)
curl --unix-socket /tmp/firecracker.socket \
    -X PUT 'http://localhost/boot-source' \
    -H 'Content-Type: application/json' \
    -d '{
        "kernel_image_path": "/path/to/vmlinux",
        "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
    }'

# Set root filesystem
curl --unix-socket /tmp/firecracker.socket \
    -X PUT 'http://localhost/drives/rootfs' \
    -H 'Content-Type: application/json' \
    -d '{
        "drive_id": "rootfs",
        "path_on_host": "/path/to/rootfs.ext4",
        "is_root_device": true,
        "is_read_only": false
    }'

# Configure resources
curl --unix-socket /tmp/firecracker.socket \
    -X PUT 'http://localhost/machine-config' \
    -H 'Content-Type: application/json' \
    -d '{
        "vcpu_count": 2,
        "mem_size_mib": 1024
    }'

# Start the VM
curl --unix-socket /tmp/firecracker.socket \
    -X PUT 'http://localhost/actions' \
    -H 'Content-Type: application/json' \
    -d '{"action_type": "InstanceStart"}'
```

The VM boots in ~125ms. You're now running a fully isolated microVM.

### Pre-built Images

Use [Firecracker's CI scripts](https://github.com/firecracker-microvm/firecracker/tree/main/tools) or pre-built images:

```bash
# Download Alpine Linux rootfs and kernel
curl -o vmlinux https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin
curl -o rootfs.ext4 https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/rootfs/bionic.rootfs.ext4
```

For production, build custom images with your application baked in. Tools like [Packer](https://www.packer.io/) work well.

## Production Best Practices

After running Firecracker workloads at scale:

1. **Use the Jailer** - Adds seccomp, cgroups, namespaces for defense-in-depth. Required for multi-tenant environments:

```bash
jailer --id microvm-1 \
    --exec-file /usr/local/bin/firecracker \
    --uid 123 --gid 456 \
    -- --api-sock /run/firecracker.socket
```

2. **Optimize boot time** - Use minimal kernels and small rootfs. AWS's production Lambda images boot in ~85ms.

3. **Resource limits** - Set CPU and memory limits per VM:

```json
{
  "vcpu_count": 2,
  "mem_size_mib": 1024,
  "cpu_template": "T2",  // Intel-specific optimizations
  "track_dirty_pages": true  // For live migration/snapshots
}
```

4. **Snapshots for faster starts** - Create snapshots of fully booted VMs and restore them (< 5ms):

```bash
# Create snapshot
curl --unix-socket /tmp/firecracker.socket \
    -X PUT 'http://localhost/snapshot/create' \
    -d '{"snapshot_path": "/path/to/snapshot", "mem_file_path": "/path/to/mem"}'

# Restore from snapshot (much faster than boot)
firecracker --api-sock /tmp/firecracker.socket \
    --config-file /path/to/snapshot-config.json
```

5. **Monitor and observe** - Track VM lifecycle, resource usage, and errors. Use [Firecracker's metrics](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/metrics.md).

6. **Network setup** - Use TAP devices for networking:

```bash
# Create TAP device
sudo ip tuntap add tap0 mode tap
sudo ip addr add 172.16.0.1/24 dev tap0
sudo ip link set tap0 up

# Configure in Firecracker
curl --unix-socket /tmp/firecracker.socket \
    -X PUT 'http://localhost/network-interfaces/eth0' \
    -d '{
        "iface_id": "eth0",
        "guest_mac": "AA:FC:00:00:00:01",
        "host_dev_name": "tap0"
    }'
```

7. **Rate limiting** - Prevent noisy neighbors:

```json
{
  "bandwidth": {
    "size": 125000,  // Bytes
    "refill_time": 1000  // Milliseconds
  },
  "ops": {
    "size": 1000,
    "refill_time": 1000
  }
}
```

8. **Scale horizontally** - Run many microVMs per host. AWS runs thousands per bare metal server.

## When to Use Firecracker

**Good fit:**
- Serverless platforms (function-as-a-service)
- CI/CD runners (isolated build environments)
- Code execution sandboxes (online IDEs, notebook kernels)
- Multi-tenant SaaS (untrusted user code)

**Not ideal:**
- Desktop applications (requires Linux KVM)
- Long-running services (containers are simpler)
- Windows guests (KVM is Linux-only)
- Legacy apps needing full hardware emulation

## Tools and Ecosystem

- **[Firecracker-containerd](https://github.com/firecracker-microvm/firecracker-containerd)** - Run container images in Firecracker VMs
- **[Firectl](https://github.com/firecracker-microvm/firectl)** - CLI wrapper for Firecracker API
- **[Flintlock](https://github.com/weaveworks/flintlock)** - Kubernetes-native Firecracker management
- **[Fly.io](https://fly.io/)** - Uses Firecracker for their platform
- **[Koyeb](https://www.koyeb.com/)** - Firecracker-based serverless

## Conclusion

Firecracker proves you can have both security and speed. By rethinking virtualization for cloud-native workloads, AWS created something genuinely novel—microVMs that boot as fast as containers with VM-level isolation.

If you're building multi-tenant platforms, serverless runtimes, or secure execution environments, Firecracker is worth serious evaluation. The operational complexity is real (you're managing VMs), but the security and isolation guarantees are unmatched.

**Further Reading:**
- [Firecracker Documentation](https://github.com/firecracker-microvm/firecracker/tree/main/docs)
- [Getting Started Guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)
- [AWS Blog: Firecracker](https://aws.amazon.com/blogs/aws/firecracker-lightweight-virtualization-for-serverless-computing/)
- [KVM Documentation](https://www.linux-kvm.org/page/Documents)
- [Firecracker GitHub](https://github.com/firecracker-microvm/firecracker)

---

*Firecracker microVMs from April 2024, covering secure virtualization and fast boot times.*

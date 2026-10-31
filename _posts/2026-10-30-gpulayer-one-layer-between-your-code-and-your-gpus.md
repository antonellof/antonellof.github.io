---
layout: post
title: "GPUlayer: One Layer Between Your Code and Every GPU You Can Reach"
date: 2026-10-30
categories: [Projects]
tags: [GPU, PyTorch, Distributed Training, MLOps, AI Infrastructure, Coding Agents, MCP, Claude Code, Python, Apple Silicon, NVIDIA, Kubernetes, Open Source]
image: /assets/images/gpulayer/og.png
excerpt: "I built GPUlayer because my compute is spread across a MacBook, Linux boxes, and cloud VMs—and I needed a single layer that both I and my coding agents (Claude Code, Pi agents, MCP) could use to run workloads across every GPU I own or rent."
---

<p align="center">
  <img src="/assets/images/gpulayer/logo.svg" alt="GPUlayer" width="260" />
</p>

Most GPU software assumes the GPU is attached to the machine where you type `python`.

PyTorch, Lightning, Hugging Face Accelerate, JAX, MLX, and CuPy all do a great job deciding *how* a computation uses the hardware it is given. None of them decide *which* machine should run the job, ship your project and inputs there, check whether the driver and libraries actually work before starting, or bring logs and checkpoints back when it finishes.

I built [GPUlayer](https://www.gpulayer.dev/) ([GitHub](https://github.com/antonellof/gpulayer)) to solve two closely related problems:

1. **My GPUs are spread across different machines**: an Apple Silicon laptop, Linux servers, and rented cloud VMs. Every time I started a new workload, I ended up repeating the same manual ritual—`ssh`, `rsync`, hoping the virtualenv and CUDA build still matched the driver, starting `tmux`, and copying checkpoints back.
2. **I needed a way to give my coding agents control over all of my GPUs**: I do most of my day-to-day work inside coding agents—Claude Code, Pi agents, and MCP-enabled editors—running on my laptop. Handing an agent raw SSH keys and teaching it which box is free, which one has CUDA vs. Metal (`mps`/`mlx`), and how to `rsync` artifacts back is fragile and dangerous. I wanted one structured control layer so an agent on my MacBook can inspect every GPU I can reach, submit a training run or benchmark to the right machine, stream the logs, and pull back the results.

Before GPUlayer, running a job on another machine looked like this:

```bash
ssh gpu-box
rsync -av my_project/ gpu-box:~/my_project/
# hope the virtualenv and CUDA build still match the driver
tmux new -s train
cd ~/my_project && python train.py
# check back later, rsync checkpoints home
```

Multiply that by several machines with different drivers, a Mac with Metal (`mps` and `mlx`) instead of CUDA, a 96-run learning-rate sweep, or a multi-node job where `torchrun` needs matching ranks, addresses, and ports on every host.

With GPUlayer, that becomes:

```bash
pip install gpulayer
gpulayer submit --accelerator cuda --source my_project -- python train.py
```

GPUlayer is published on PyPI under Apache 2.0, and validated on Apple Silicon, NVIDIA CUDA (Tesla T4), automatic Google Cloud GPU provisioning, and fleets of up to 30 machines across two cloud regions. This post walks through what it does, how the scheduler and distributed runtime work, how it performs against PyTorch Lightning and `torchrun`, and where its boundaries are today.

---

## What GPUlayer does

GPUlayer sits underneath your frameworks and above your machines: your laptop, servers that joined with `gpulayer join`, Kubernetes worker pools, or cloud VMs provisioned on demand.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/architecture-dark.svg" />
  <img src="/assets/images/gpulayer/architecture-light.svg" alt="GPUlayer architecture: commands, Python functions, PyTorch training, and services go through GPUlayer to your laptop, remote servers, and cloud VMs" />
</picture>

Everything goes through the same queue, capability matcher, and wire protocol across four workload types:

### 1. Any command or binary

Scripts, shell pipelines, C++ or Rust binaries, Blender renders, or `ffmpeg` transcodes run as jobs without wrapper code. You point GPUlayer at a source directory, declare inputs and outputs, and state the hardware requirements:

```bash
# Run a script on any worker with a CUDA GPU
gpulayer submit --accelerator cuda --source ./app -- ./render.sh

# Stage an input file and run a shell job
gpulayer submit --source examples/shell_job \
  --input examples/shell_job/sales.csv:sales.csv -- bash report.sh
```

### 2. Python functions with any library

Decorate a function with `@gl.remote`, specify the accelerator and framework versions it needs, and call it directly or fan it out across every free worker with `.map()`:

```python
import gpulayer as gl

@gl.remote(accelerator="mps", frameworks={"mlx": ">=0.10"})
def matmul_benchmark(n: int) -> dict:
    import mlx.core as mx
    ...

# Scatters across available workers in parallel
results = matmul_benchmark.map([1024, 2048, 4096])
```

Arguments and return values are plain JSON, and code travels as a clean source bundle rather than brittle pickled bytecode.

### 3. PyTorch training and distributed launch

GPUlayer includes a focused PyTorch integration (`gpulayer.pytorch`) with a `Trainer`, `Runtime`, and `launch()`. The exact same script runs in-process on your laptop, as multi-process DDP on one machine, or across multiple nodes:

```bash
# Single process
python examples/trainer_regression/train.py

# 2-process DDP on CPU
python examples/trainer_regression/train.py --accelerator cpu --devices 2

# 2 nodes x 2 processes across remote workers
python examples/trainer_regression/train.py --accelerator cpu --nodes 2 --devices 2 --target remote
```

Or directly in Python:

```python
import gpulayer.pytorch as glt

trainer = glt.Trainer(
    accelerator="cuda",
    devices=4,
    num_nodes=2,
    max_epochs=10,
    target="remote",
)
trainer.fit(model, train_loader, val_loader)
```

The `Trainer` handles device placement, mixed precision (`fp16`/`bf16`), `torch.compile`, gradient accumulation with DDP `no_sync`, sanity validation steps, callbacks (`EarlyStopping`, `ModelCheckpoint(save_top_k=N)`, `LearningRateMonitor`), `test()`, `predict()`, CUDA side-stream batch prefetching, two-level gradient sync for multi-node CPU/gloo runs, and experimental FSDP2 (`strategy="fsdp"`). If you already use PyTorch Lightning or Accelerate, `glt.launch()` places the job and starts the processes with the standard `torchrun` environment variables they expect.

### 4. Long-running services

For inference endpoints or persistent workers, `gpulayer submit --service` (or `gl.service(...)`) runs replicas on distinct machines, assigns each replica a free `$PORT`, waits for it to accept connections, reports `host:port` endpoints via `Job.endpoints()`, restarts crashed replicas with exponential backoff, and re-places replicas if a worker machine disappears.

---

## Placement that explains itself

When a job fails on a cluster, the worst outcome is waiting three minutes for container setup and `import torch` only to hit `RuntimeError: No CUDA GPUs are available` or a missing library.

In GPUlayer, workers probe their hardware and environment on startup. For GPU libraries (`torch.cuda`, `jax.cuda`, `cupy.cuda`, `torch.mps`, `mlx`), GPUlayer does not merely check whether the Python package is importable—it runs a lightweight GPU probe in a separate interpreter to verify that the library can actually execute on the device. A CPU-only `jax` or broken CUDA installation will never advertise itself as a working GPU worker.

When a job arrives, the scheduler evaluates every worker against the job's requirements. If no worker qualifies, the job is rejected immediately with per-worker reasons:

```text
scheduling: no eligible worker
  gpu-box-1    needs 2 usable cuda device(s), worker has 1
  mac-studio   framework 'jax' not installed
  laptop       torch on this worker cannot use CUDA
  gpu-box-2    eligible
```

### Topology-aware groups and NVLink/PCIe GPU selection

Placement goes beyond counting free GPUs:

- **Rack, zone, and region locality (`--group-locality`)**: Workers report their cloud `region`, `zone` (read automatically from the GCE metadata server on Google Cloud or passed via flags/env), and an optional `gpulayer.dev/network-group` label for rack or InfiniBand islands. When gang-scheduling a multi-node job, the default `prefer` policy keeps all nodes in the same network group if possible, then the same zone, then the same region, before falling back to cross-region placement.
- **Best-connected GPUs on a host**: On multi-GPU machines, workers parse `nvidia-smi topo -m` into link speeds and NUMA affinities. When a task asks for multiple GPUs on an 8-GPU server, GPUlayer picks the free subset whose slowest pairwise interconnect is fastest (preferring an NVLink island or GPUs behind a single PCIe switch over arbitrary lowest indices) and exports `CUDA_DEVICE_ORDER=PCI_BUS_ID` so mixed-GPU machines never mismatch device indices.

---

## From one laptop to cloud GPUs, Kubernetes, and AI agents

### Adding machines in one command

For local work, the control plane runs embedded inside your Python process or CLI call with zero setup. When you want to pool multiple machines, start the server on one host:

```bash
gpulayer up
```

`gpulayer up` generates a TLS certificate with a pinned fingerprint, creates named role-based tokens (`admin`, `submitter`, `join`, `metrics`), and prints the exact `gpulayer join` command to paste on any other machine:

```bash
gpulayer join https://192.168.1.50:8443 --token <join-token> --tls-fingerprint SHA256:...
```

Because workers poll the control plane over outbound HTTPS connections, a worker on a home workstation or lab server behind NAT can join without port forwarding or VPN tunnels.

### Automatic Google Cloud provisioning

When your standing machines are busy—or when you develop on a MacBook and only want to pay for an NVIDIA GPU while a job runs—GPUlayer can provision cloud VMs per job (`gpulayer[gcp]`).

Configure your allowed machine offers in `providers.json`, start `gpulayer up --providers providers.json`, and submit with `--provider gcp --accelerator cuda`. When no existing worker fits, GPUlayer creates a Compute Engine VM (such as a Spot Tesla T4), boots it with a single-use join token, runs the job as soon as the worker reports `torch.cuda`, downloads the checkpoints and logs, and deletes the VM when the job finishes. In our validation runs, a fresh Spot T4 VM went from API creation to running a CUDA `Trainer` job in 78 seconds and tore itself down immediately on completion.

### Web dashboard, Prometheus, and Kubernetes

The server includes a built-in web dashboard (`gpulayer dashboard`) showing queued and running jobs, per-rank live logs, placement diagnostics, worker hardware inventory, and live GPU/CPU utilization, alongside a `/metrics` Prometheus endpoint and prebuilt Grafana dashboard.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/dashboard/overview-dark.png" />
  <img src="/assets/images/gpulayer/dashboard/overview-light.png" alt="GPUlayer web dashboard overview showing jobs, workers, and cluster activity" />
</picture>

For teams running on Kubernetes, GPUlayer ships container images on GitHub Container Registry (`ghcr.io/antonellof/gpulayer`) and a Helm chart (`deploy/kubernetes/helm/gpulayer`) that deploys the control plane as a StatefulSet alongside CPU and NVIDIA GPU worker pools.

### Giving coding agents control over all your GPUs (`gpulayer mcp` and `SKILL.md`)

One of my primary reasons for building GPUlayer was letting my coding agents—**Claude Code**, **Pi agents**, Cursor, and Codex—use every GPU I own or rent without giving them raw SSH access or make-shift bash loops.

When an agent is writing a kernel, tuning hyperparameters, or debugging a training script on my laptop, it needs to run that code on an NVIDIA GPU or across a multi-node fleet, wait for the outcome, read the logs, and inspect the output files. GPUlayer gives agents three ways to do that through the same capability scheduler and scoped token permissions (`submitter` or `--read-only`, never needing an `admin` token or SSH keys):

1. **MCP server (`gpulayer mcp`)**: A built-in Model Context Protocol server over stdio exposing structured tools: `gpulayer_resources`, `gpulayer_submit`, `gpulayer_wait`, `gpulayer_job_status`, `gpulayer_job_logs`, `gpulayer_list_jobs`, `gpulayer_cancel`, and `gpulayer_download_outputs`.
2. **Agent Skill (`integrations/skills/gpulayer/SKILL.md`)**: For CLI-native harnesses like **Pi** and **Claude Code**, the repository ships a ready-to-use `SKILL.md` that teaches the agent how to inspect available accelerators (`gpulayer resources list --json`), submit jobs with `--accelerator cuda` or `--accelerator mps`, stream logs (`gpulayer job logs <id> -f`), interpret per-worker rejection reasons instead of blindly retrying, and download outputs.
3. **HTTP / Python SDK**: Custom agent loops can hit the REST API or `gpulayer.Client` directly.

Wiring it into Claude Code or Pi takes one command:

```bash
# Add the MCP server to Claude Code against your GPUlayer control plane
claude mcp add gpulayer \
  -e GPULAYER_URL=https://gpu-server:8470 \
  -e GPULAYER_TOKEN=glc_... \
  -e GPULAYER_FINGERPRINT=sha256:... \
  -- gpulayer mcp

# Or install the CLI skill for Pi / Claude Code
cp -r integrations/skills/gpulayer ~/.claude/skills/
```

When you tell your agent *"Train `train.py` on an NVIDIA GPU for 3 epochs and tell me the validation loss"*, it calls `gpulayer_resources`, sees which worker has `cuda` and `torch`, calls `gpulayer_submit` with `source_dir: "."` and `accelerator: "cuda"`, waits with `gpulayer_wait`, and reads the metrics back—while every agent-submitted job is tracked by token identity (`submitted_by`) on the dashboard.

---

## Performance and benchmarks

Every benchmark below comes from reproducible scripts in [`benchmarks/`](https://github.com/antonellof/gpulayer/tree/main/benchmarks), with raw logs checked into [`benchmarks/results/`](https://github.com/antonellof/gpulayer/tree/main/benchmarks/results).

### 1. Single-GPU training speed vs. PyTorch Lightning

We trained the exact same models, datasets, and SGD optimizer with one logged loss per step using GPUlayer's `Trainer` and PyTorch Lightning's `Trainer` (with Lightning's logger, progress bar, model summary, and checkpointing turned off to make the loop comparison fair) on a Google Cloud `n1-standard-8` VM with an NVIDIA Tesla T4 (driver 580, Python 3.12, PyTorch 2.15.0, CUDA 13.2, Lightning 2.6.6). Each configuration ran 100 and 600 steps three times in fresh processes, taking the difference of median wall times divided by 500 steps:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/training-step-dark.svg" />
  <img src="/assets/images/gpulayer/perf/training-step-light.svg" alt="Training step time on Tesla T4: GPUlayer vs PyTorch Lightning" />
</picture>

| Workload (Tesla T4 / CPU) | GPUlayer (ms/step) | Lightning (ms/step) | Speedup | GPUlayer startup | Lightning startup |
|---|---:|---:|---|---:|---:|
| MLP, fp32, batch 256 | **4.06 ms** | 5.64 ms | **1.39x faster** | 4.77 s | 5.31 s |
| MLP, fp16 mixed precision | **5.00 ms** | 6.25 ms | **1.25x faster** | 4.82 s | 5.55 s |
| CNN, fp16 mixed, batch 128 | **10.82 ms** | 12.33 ms | **1.14x faster** | 5.65 s | 5.74 s |
| DDP, 2 CPU processes | **3.20 ms** | 9.56 ms | **2.99x faster** | 10.32 s | 9.35 s |

Why the numbers differ:

- **Small models (MLP)**: When a forward/backward pass takes 4 ms, framework bookkeeping per step is visible. GPUlayer's loop avoids synchronous device-to-host stalls when recording step losses.
- **Compute-bound CNN**: On larger convolutional steps, GPUlayer enables two optimizations by default on CUDA: cuDNN autotuning (`cudnn.benchmark = True` unless `deterministic=True`) and asynchronous side-stream batch prefetching (`Runtime.batches`), which pins the next batch and copies it to the GPU on a secondary CUDA stream while the current step computes. Ablating those two flags on the same T4 (`benchmarks/results/2026-10-31-gcp-t4/`) isolated their contribution: **12.67 ms/step** with both off, **12.10 ms** with prefetch only (~5%), **11.53 ms** with cuDNN autotuning only (~9%), and **10.93 ms** with both enabled.
- **CPU DDP**: GPUlayer pins each worker process to a dedicated thread count by default, whereas Lightning leaves PyTorch's default multi-threading untouched, causing two ranks to contend over the 8 vCPUs.
- **Startup overhead**: On a single GPU, GPUlayer starts training 0.1 to 0.7 seconds sooner than Lightning.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/startup-dark.svg" />
  <img src="/assets/images/gpulayer/perf/startup-light.svg" alt="Startup time: GPUlayer vs PyTorch Lightning" />
</picture>

### 2. Multi-node strong scaling: 2 to 8 machines (32 processes)

Next, we ran a multi-node CNN training job (32,768 images, global batch size 256 split across all ranks, 2 epochs) across **2, 4, and 8 GCP `n1-standard-4` VMs** (4 processes per machine, up to 32 processes total over `gloo`). Both trainers ran on the exact same VMs in interleaved order. With GPUlayer, a single `Trainer(num_nodes=N, devices=4)` call scheduled and launched all machines; with Lightning, `torchrun` was started on every node with matching rendezvous addresses.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/strong-scaling-dark.svg" />
  <img src="/assets/images/gpulayer/perf/strong-scaling-light.svg" alt="Multi-node strong scaling across 2, 4, and 8 machines: GPUlayer vs PyTorch Lightning" />
</picture>

| Machines | Total Processes | GPUlayer Wall Time | Lightning (`torchrun`) | GPUlayer Lead | Final Loss (GL / PL) |
|---:|---:|---:|---:|---|---|
| 2 | 8 | **118.9 s** | 120.8 s | **1.6% faster** | 2.129 / 2.125 |
| 4 | 16 | **73.3 s** | 77.4 s | **5.3% faster** | 2.143 / 2.137 |
| 8 | 32 | **50.5 s** | 57.3 s | **11.9% faster** | 2.162 / 2.164 |

From 2 to 8 machines, GPUlayer scaled **2.35x** vs. Lightning's **2.11x**, finishing **11.9% faster on 8 machines** while converging to the same loss.

The difference comes from **two-level gradient synchronization** ([ADR-0020](https://www.gpulayer.dev/docs/decisions/ADR-0020-two-level-gradient-sync/)). When running multi-node DDP over `gloo` with multiple processes per host, standard flat ring all-reduce sends messages across every rank on every machine. GPUlayer instead forms an intra-node group on each machine and an inter-node group across local rank 0s: gradients are summed inside each machine in shared memory first, followed by a single all-reduce across the machines, and broadcast back locally. On 8 machines x 4 processes, that cut the per-step time from 117 ms to 102 ms.

### 3. Direct distributed launcher vs. `torchrun`

By default (`launcher="direct"`), GPUlayer workers spawn rank processes directly with the exact environment variables `torch.distributed` expects (`MASTER_ADDR`, `MASTER_PORT`, `WORLD_SIZE`, `RANK`, `LOCAL_RANK`) instead of going through `torchrun`'s elastic agent rendezvous.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/distributed-startup-dark.svg" />
  <img src="/assets/images/gpulayer/perf/distributed-startup-light.svg" alt="Distributed job startup: GPUlayer direct launcher vs torchrun" />
</picture>

Across 2 to 16 machines, the direct launcher saves **1.1 to 2.3 seconds per job** compared to `torchrun`. On an 8-machine (16-process) job, startup + collective finished in **4.3 s** vs. **6.9 s** with `torchrun`; on 16 machines (32 processes), **5.4 s** vs. **8.1 s**.

### 4. Fleet throughput and 30-machine scale tests

To test mixed-workload scheduling across heterogeneous machines, we first ran two GCP VMs (one `n1-standard-8` with a Tesla T4 and one `e2-standard-8`, 15 job slots total):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/scale-dark.svg" />
  <img src="/assets/images/gpulayer/perf/scale-light.svg" alt="Spreading jobs across machines: cumulative task time vs wall clock time" />
</picture>

| Workload | Jobs | Wall Clock | Cumulative Task Time | Jobs per Worker (`cpu8`, `t4-cpu`, `t4`) |
|---|---:|---:|---:|---|
| Tiny jobs (0.02 s each) | 500 | **9.0 s** | 11.0 s | 243, 188, 69 |
| Data shards (0.6 s each) | 200 | **11.8 s** | 127.8 s | 115, 72, 13 |
| LR training sweep | 96 | **55.2 s** | 241.7 s | 56, 34, 6 |

We then scaled the fleet to **30 worker VMs** (`n1-standard-4`, 120 concurrent slots) split across two regions—23 in Belgium (`europe-west1`) and 7 in the Netherlands (`europe-west4`):

- **5,000 tiny jobs, 2,000 data shards, and a 480-run training sweep** all completed cleanly across all 30 machines.
- **Fault tolerance and fail-fast**: When one rank in an 8-machine distributed job exited with an error, GPUlayer aborted every rank across all 8 machines within **4.9 seconds**. When 3 worker VMs were killed mid-run during a 600-job batch, the 9 in-flight tasks on those hosts were automatically rescheduled onto healthy workers with **0 failed jobs**.
- **92.7 jobs/second throughput**: Submitting 2,000 jobs with `Client.submit_batch` (`POST /v1/jobs/batch`) ingested all 2,000 jobs in **1.1 seconds** and drained them in **21.6 seconds** across 8 workers.

Getting from early prototypes (7.8 jobs/s) to 92.7 jobs/s took four concrete systems fixes that are documented in the changelog:
1. **`TCP_NODELAY` and thread-shared HTTPS connection pools**: On Linux, Nagle's algorithm + delayed ACKs were holding responses for 40 ms and opening fresh TLS handshakes per worker thread. Reuse + `TCP_NODELAY` cut per-request latency from 43 ms to 0.6 ms.
2. **Keyed long-poll wakeups**: Idle workers wait on condition variables keyed to capability changes rather than polling every 200 ms, cutting a 480-job training sweep on 30 workers from 102 s to 45 s.
3. **Partial SQLite indexes on active tasks**: As historical tasks grew past 13,000 rows, scanning for active reservations took 2.2 ms per scheduling pass; a partial index over active states dropped that query to **0.002 ms**.
4. **WAL mode with `synchronous=NORMAL` and batch submission**: Reduced disk commit latency on standard cloud persistent disks from 2.25 ms to 0.02 ms and server CPU cost to 4.1 ms per job.

---

## How GPUlayer compares to other tools

Most tools in the GPU ecosystem live either inside the training script or at the cloud VM provisioning layer. Often they complement GPUlayer rather than replace it:

| Tool | Primary Layer | Chooses Hardware? | Uses Existing Machines? | Workloads |
|---|---|---|---|---|
| **GPUlayer** | Workload placement & execution layer | Yes (GPU, VRAM, frameworks, rack/zone topology, + GCP provisioning) | Yes (`gpulayer join`, laptop, servers, K8s) | Commands in any language, `@gl.remote` Python functions, distributed PyTorch, services |
| **PyTorch Lightning / Accelerate** | In-process training loop organization | No (runs where launched) | Yes (manual SSH / `torchrun`) | PyTorch training & inference |
| **Ray** | Distributed Python runtime & actor framework | Inside a standing Ray cluster | Yes (requires Ray cluster) | Python tasks/actors serialized against Ray APIs |
| **SkyPilot / dstack** | Multi-cloud VM & container orchestrators | Yes (cloud instance catalogs & fleets) | dstack yes; SkyPilot via SSH node pools | Task specs / containers / services |
| **Modal** | Hosted serverless GPU cloud | Yes (Modal's cloud only) | No (cannot bring your own GPUs) | Python functions, containers, web endpoints |
| **Slurm / Kubernetes** | Multi-tenant cluster schedulers | Yes (within the cluster) | Yes (requires cluster ops) | Batch scripts (Slurm) / containers (K8s) |

- **PyTorch Lightning & Accelerate**: Choose them when you need rich training features like DeepSpeed, dozens of loggers, or complex model parallelism. You can pair them with `gpulayer.pytorch.launch()` so GPUlayer handles machine selection, code staging, and multi-node process launch while Lightning or Accelerate runs the loop.
- **Ray**: Choose Ray when you need stateful distributed actors, a shared in-memory object store, or Ray Tune/Serve. Choose GPUlayer when you want to run arbitrary shell commands, binaries, MLX on Macs, or standard Python/PyTorch scripts without rewriting them around a cluster runtime.
- **Modal**: `@gl.remote` and `.map()` feel very similar to Modal, except GPUlayer is self-hosted and runs on hardware you already own or rent—including Apple Silicon Macs and local workstations.

---

## Current boundaries

What is not built or validated yet:

- **Multi-GPU per host and multi-node NCCL**: Selecting the best-connected GPUs via `nvidia-smi topo -m` and multi-GPU reservations are implemented and tested against recorded topologies, but hardware validation so far has used single-GPU T4 VMs and multi-node CPU `gloo` (up to 30 VMs) while waiting on higher cloud GPU quota.
- **Cloud providers beyond Google Cloud**: Automatic per-job VM creation and teardown is validated on GCP (CPU and Spot T4). AWS, Azure, and specialized GPU clouds are not wired up yet, though any VM you boot yourself can join with `gpulayer join`.
- **Service load balancing**: Long-running services manage replicas, `$PORT` assignment, readiness, and restarts, but do not yet include a reverse proxy or autoscaler in front of replica endpoints.
- **Untrusted multi-tenant sandboxing**: Workloads execute as normal OS processes on workers. GPUlayer is designed for an engineer or a team sharing hardware they trust, not for running untrusted third-party code.

---

## Try it in five minutes

GPUlayer requires Python 3.10+. PyTorch is optional if you only run commands or non-PyTorch Python functions.

```bash
# Install from PyPI (or `pip install "gpulayer[torch]"` for the PyTorch Trainer)
pip install gpulayer

# Inspect what GPUs, memory, and frameworks this machine offers
gpulayer resources detect

# Run a command job locally
gpulayer submit --source examples/shell_job \
  --input examples/shell_job/sales.csv:sales.csv -- bash report.sh

# Start a control plane and open the web dashboard
gpulayer up
gpulayer dashboard
```

- **Website & Documentation**: [gpulayer.dev](https://www.gpulayer.dev/) · [Quickstart](https://www.gpulayer.dev/docs/get-started/quickstart/)
- **Detailed Comparisons**: [gpulayer.dev/compare](https://www.gpulayer.dev/compare/)
- **Benchmarks & Raw Logs**: [Performance and comparison](https://www.gpulayer.dev/docs/get-started/performance-and-comparison/)
- **Source & Issues**: [github.com/antonellof/gpulayer](https://github.com/antonellof/gpulayer)

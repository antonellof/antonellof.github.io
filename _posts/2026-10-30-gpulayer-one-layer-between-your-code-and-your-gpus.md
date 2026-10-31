---
layout: post
title: "GPUlayer: One Layer Between Your Code and Every GPU You Can Reach"
date: 2026-10-30
categories: [Projects]
tags: [GPU, PyTorch, Distributed Training, MLOps, AI Infrastructure, Coding Agents, MCP, Claude Code, Python, Apple Silicon, NVIDIA, Kubernetes, Open Source]
image: /assets/images/gpulayer/og.png
excerpt: "I built GPUlayer because my compute is spread across a MacBook, Linux servers, and rented cloud VMs—and I needed a single layer that both I and my coding agents (Claude Code, Pi agents, MCP) could use to run workloads on every GPU I can reach."
---

<p align="center">
  <img src="/assets/images/gpulayer/logo.svg" alt="GPUlayer" width="260" />
</p>

Most GPU software assumes the GPU is attached to the machine where you type `python`.

PyTorch, PyTorch Lightning, Hugging Face Accelerate, JAX, MLX, and CuPy decide how a computation uses the hardware it is given. On their own they don't pick the machine, check that its driver and libraries work before the job starts, or bring logs and checkpoints back to you. Accelerate can send a script to an Amazon SageMaker instance you choose, and TorchX can submit PyTorch jobs to a cluster; both still leave choosing a suitable machine and checking it to you.

I built [GPUlayer](https://www.gpulayer.dev/) ([GitHub](https://github.com/antonellof/gpulayer)) to solve two problems:

1. **My compute is spread across machines**: an Apple Silicon laptop, Linux boxes, and rented cloud VMs. Starting a workload meant `ssh`, `rsync`, hoping the virtualenv and CUDA build still matched the driver, running inside `tmux`, and copying checkpoints back—or starting `torchrun` by hand on every node with matching ranks and addresses.
2. **I needed a way to give my coding agents control over my GPUs**: I do most of my work inside Claude Code, Pi agents, and MCP clients on my laptop. Giving an agent raw SSH access and teaching it which machine is free, which one has CUDA vs. Metal (`mps`/`mlx`), and how to copy results back is fragile. I wanted one control plane so an agent can inspect every GPU I can reach, submit a job, read the logs, and fetch the outputs safely.

With GPUlayer, running a job on a remote GPU is:

```bash
pip install gpulayer
gpulayer submit --accelerator cuda --source my_project -- python train.py
```

---

## What GPUlayer does

GPUlayer sits between your code and the machines you can reach: your laptop, servers that joined with `gpulayer join`, [Kubernetes worker pools](https://www.gpulayer.dev/docs/guides/kubernetes/), or [cloud VMs created per job](https://www.gpulayer.dev/docs/guides/cloud-providers/).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/architecture-dark.svg" />
  <img src="/assets/images/gpulayer/architecture-light.svg" alt="GPUlayer architecture: commands, Python functions, PyTorch training, and services go through GPUlayer to your laptop, remote servers, and cloud VMs" />
</picture>

All four workload types share one queue, scheduler, and wire protocol:

- **[Any command or binary](https://www.gpulayer.dev/docs/workloads/commands/)**: Scripts, binaries, Blender renders, or `ffmpeg` pipelines run as jobs with staged inputs and returned outputs (`gpulayer submit --accelerator cuda --source ./app -- ./render.sh`).
- **[Python functions](https://www.gpulayer.dev/docs/workloads/functions/)**: Decorate a function with `@gl.remote(accelerator="mps", frameworks={"mlx": ">=0.10"})` and call it directly or fan it out across free workers with `fn.map([...])`.
- **[PyTorch training and launch](https://www.gpulayer.dev/docs/pytorch/trainer/)**: `gpulayer.pytorch.Trainer` runs the same script in-process, as multi-process DDP, or across multiple nodes (`Trainer(accelerator="cuda", devices=4, num_nodes=2, target="remote")`), handling mixed precision, callbacks, checkpoints, CUDA batch prefetching, and two-level gradient sync. Existing PyTorch Lightning or Accelerate scripts can use [`glt.launch()`](https://www.gpulayer.dev/docs/pytorch/launch/).
- **[Long-running services](https://www.gpulayer.dev/docs/guides/services/)**: `gpulayer submit --service` (or `gl.service(...)`) runs replicas on separate workers, assigns a free `$PORT`, reports `host:port` endpoints, and restarts or reschedules failed replicas.

---

## Placement that explains itself

Workers probe their hardware and environment on startup. For GPU libraries (`torch.cuda`, `jax.cuda`, `cupy.cuda`, `torch.mps`, `mlx`), each worker runs a probe in a separate Python subprocess to verify the library actually executes on the GPU—so a CPU-only `jax` build or broken driver is never advertised as a usable GPU.

When no worker fits a job, the [scheduler](https://www.gpulayer.dev/docs/architecture/scheduling/) rejects it before anything starts and reports the exact reason per worker:

```text
scheduling: no eligible worker
  gpu-box-1    needs 2 usable cuda device(s), worker has 1
  mac-studio   framework 'jax' not installed
  laptop       torch on this worker cannot use CUDA
  gpu-box-2    eligible
```

Placement is also topology-aware:
- **Rack, zone, and region locality**: Workers report their cloud `zone`, `region`, and optional `gpulayer.dev/network-group` label. Distributed jobs automatically stay in one rack, zone, or region whenever possible ([ADR-0021](https://www.gpulayer.dev/docs/decisions/ADR-0021-topology-aware-group-placement/)).
- **Best-connected GPUs on a host**: Workers read `nvidia-smi topo -m` and allocate the free GPU subset with the fastest interconnect (preferring NVLink islands or a shared PCIe switch over arbitrary device indices).

---

## Giving coding agents control over your GPUs

To let **Claude Code**, **Pi agents**, Cursor, and Codex run GPU workloads without SSH keys or admin privileges, GPUlayer provides both an [MCP server and a CLI Agent Skill](https://www.gpulayer.dev/docs/guides/ai-agents/):

```bash
# Connect Claude Code to your GPUlayer control plane via MCP
claude mcp add gpulayer \
  -e GPULAYER_URL=https://gpu-server:8470 \
  -e GPULAYER_TOKEN=glc_... \
  -e GPULAYER_FINGERPRINT=sha256:... \
  -- gpulayer mcp

# Or install the CLI skill for Pi / Claude Code
cp -r integrations/skills/gpulayer ~/.claude/skills/
```

With a scoped `submitter` token (or `--read-only`), an agent can list free GPUs (`gpulayer_resources`), ship a local directory and start a job (`gpulayer_submit`), wait for completion (`gpulayer_wait`), read per-rank logs (`gpulayer_job_logs`), and pull checkpoints back (`gpulayer_download_outputs`). Every job records who submitted it on the web dashboard (`gpulayer dashboard`).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/dashboard/overview-dark.png" />
  <img src="/assets/images/gpulayer/dashboard/overview-light.png" alt="GPUlayer web dashboard overview showing jobs, workers, and cluster activity" />
</picture>

Adding your own machines takes one command (`gpulayer up` on the server, then paste the printed `gpulayer join` line on any worker, even behind NAT). When no standing worker fits a job, [Google Cloud provisioning](https://www.gpulayer.dev/docs/guides/cloud-providers/) (`--provider gcp --accelerator cuda`) can create a Spot GPU VM, join it to the pool, run the job, and delete the VM as soon as it finishes.

---

## Performance and benchmarks

All benchmark scripts and raw logs are in [`benchmarks/`](https://github.com/antonellof/gpulayer/tree/main/benchmarks); full methodology is on the [Performance and comparison](https://www.gpulayer.dev/docs/get-started/performance-and-comparison/) page.

### 1. Single-GPU speed vs. the PyTorch Lightning Trainer

Tested on a GCP `n1-standard-8` with one NVIDIA Tesla T4 (PyTorch 2.15.0, CUDA 13.2, Lightning 2.6.6), training the same models, data, and SGD optimizer with loggers and checkpointing disabled in both trainers:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/training-step-dark.svg" />
  <img src="/assets/images/gpulayer/perf/training-step-light.svg" alt="Training step time on Tesla T4: GPUlayer vs PyTorch Lightning" />
</picture>

| Case (Tesla T4 / CPU) | GPUlayer | PyTorch Lightning | Result |
|---|---:|---:|---|
| MLP, fp32, batch 256 | **4.06 ms/step** | 5.64 ms/step | **1.39x faster** |
| MLP, fp16 mixed precision | **5.00 ms/step** | 6.25 ms/step | **1.25x faster** |
| CNN, fp16 mixed, batch 128 | **10.82 ms/step** | 12.33 ms/step | **1.14x faster** |
| DDP, 2 CPU processes | **3.20 ms/step** | 9.56 ms/step | **2.99x faster** |

On small models, GPUlayer's loop does less per-step work and avoids synchronous GPU-to-CPU waits when logging losses. On the compute-bound CNN, GPUlayer enables cuDNN autotuning and side-stream batch prefetching (`Runtime.batches`) by default—cutting the T4 step from 12.67 ms (both off) to 10.93 ms (both on). On single-GPU runs, GPUlayer also starts 0.1 to 0.7 s sooner:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/startup-dark.svg" />
  <img src="/assets/images/gpulayer/perf/startup-light.svg" alt="Startup time: GPUlayer vs PyTorch Lightning" />
</picture>

### 2. Multi-node training and locality (2 to 8 machines)

We trained a CNN across **2, 4, and 8 GCP `n1-standard-4` VMs** (4 processes per machine, up to 32 processes over `gloo`), alternating between GPUlayer (`Trainer(num_nodes=N, devices=4)`) and the PyTorch Lightning Trainer launched via `torchrun` on the same machines:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/strong-scaling-dark.svg" />
  <img src="/assets/images/gpulayer/perf/strong-scaling-light.svg" alt="Multi-node strong scaling across 2, 4, and 8 machines: GPUlayer vs PyTorch Lightning" />
</picture>

| Machines (Processes) | GPUlayer | PyTorch Lightning (`torchrun`) | GPUlayer Lead |
|---|---:|---:|---|
| 2 (8 procs) | **118.9 s** | 120.8 s | **1.6% faster** |
| 4 (16 procs) | **73.3 s** | 77.4 s | **5.3% faster** |
| 8 (32 procs) | **50.5 s** | 57.3 s | **11.9% faster** |

GPUlayer's lead on 8 machines comes from [two-level gradient sync](https://www.gpulayer.dev/docs/decisions/ADR-0020-two-level-gradient-sync/): summing gradients inside each machine before running one cross-node all-reduce (cutting the 8x4 step from 117 ms to 102 ms), while starting every node from a single `Trainer(num_nodes=8)` call.

We also measured the effect of **topology-aware placement** across 12 Skylake VMs in `europe-west1-b`, `europe-west1-c`, and `europe-west4-a`: splitting a 4-machine job across two regions (`56.2 s`) was **16 to 24% slower** than keeping it within one region (`45.0–48.6 s`). Submitted unpinned, the scheduler placed all 4 nodes in a single zone automatically.

### 3. Direct distributed launch and 30-machine scale

Because GPUlayer spawns distributed ranks directly rather than through `torchrun`'s elastic agent, distributed jobs start **1.1 to 2.3 s faster** across 2 to 16 machines:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/distributed-startup-dark.svg" />
  <img src="/assets/images/gpulayer/perf/distributed-startup-light.svg" alt="Distributed job startup: GPUlayer direct launcher vs torchrun" />
</picture>

Across heterogeneous workers and a **30-machine fleet** (120 slots across two GCP regions), GPUlayer handled 5,000 tiny jobs, 2,000 data shards, and 480-run sweeps, reached **92.7 jobs/s** with `submit_batch`, stopped all 8 nodes of a failing distributed job within **4.9 s**, and automatically rescheduled tasks when 3 worker VMs were killed mid-run with zero failed jobs.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/scale-dark.svg" />
  <img src="/assets/images/gpulayer/perf/scale-light.svg" alt="Spreading jobs across machines: cumulative task time vs wall clock time" />
</picture>

---

## Where it sits and current boundaries

A full capability matrix against PyTorch Lightning, Accelerate, Ray, SkyPilot, dstack, Modal, Slurm, and Kubernetes is on the [Compare page](https://www.gpulayer.dev/compare/):

- **PyTorch Lightning and Accelerate** organize training inside the machines they are started on; GPUlayer sits underneath them to pick the hardware, ship code, and launch the processes.
- **Ray, SkyPilot, and dstack** manage clusters or multi-cloud capacity; GPUlayer focuses on a zero-ceremony `gpulayer up` / `gpulayer join` for hardware you already have, capability-aware placement with explanations, Apple Silicon + CUDA support, and MCP/agent integration.
- **Modal** offers a similar `@remote` developer experience on Modal's cloud; GPUlayer is self-hosted on your own machines and cloud accounts.

**What is not validated yet** ([Status and roadmap](https://www.gpulayer.dev/docs/project/status/)):
- **Multiple GPUs per host and multi-node NCCL**: Multi-GPU reservation and `nvidia-smi topo -m` interconnect selection are implemented and tested against recorded topologies, but live multi-GPU validation is waiting on Google Cloud GPU quota.
- **Cloud providers beyond Google Cloud**, **load balancing in front of services**, and **untrusted multi-tenant sandboxing** (jobs run as normal OS processes).

---

## Try it

```bash
pip install gpulayer          # or: pip install "gpulayer[torch]"
gpulayer resources detect     # inspect local GPUs and frameworks
gpulayer up                   # start the control plane
gpulayer dashboard            # open the web UI
```

- **Docs & Quickstart**: [gpulayer.dev/docs](https://www.gpulayer.dev/docs/) · [Quickstart](https://www.gpulayer.dev/docs/get-started/quickstart/)
- **Comparisons & Benchmarks**: [gpulayer.dev/compare](https://www.gpulayer.dev/compare/) · [Performance and comparison](https://www.gpulayer.dev/docs/get-started/performance-and-comparison/)
- **GitHub**: [github.com/antonellof/gpulayer](https://github.com/antonellof/gpulayer)

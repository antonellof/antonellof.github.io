---
layout: post
title: "GPUlayer: One Layer Between Your Code and Every GPU You Can Reach"
date: 2026-10-30
categories: [Projects]
tags: [GPU, PyTorch, Distributed Training, MLOps, AI Infrastructure, Coding Agents, MCP, Claude Code, Python, Apple Silicon, NVIDIA, Kubernetes, Open Source]
image: /assets/images/gpulayer/og.png
excerpt: "I built GPUlayer because my compute is spread across a MacBook, Linux servers, and rented cloud VMs, and I needed one layer that both I and my coding agents (Claude Code, Pi, MCP) could use to run workloads on every GPU I can reach."
---

<p align="center">
  <img src="/assets/images/gpulayer/logo.svg" alt="GPUlayer" width="260" />
</p>

Most GPU software assumes the GPU is attached to the machine where you type `python`.

PyTorch, PyTorch Lightning, Hugging Face Accelerate, JAX, MLX, and CuPy decide how a computation uses the hardware it is given. On their own they don't pick the machine, check that its driver and libraries work before the job starts, or bring logs and checkpoints back to you. Accelerate can send a script to an Amazon SageMaker instance you choose, and TorchX can submit PyTorch jobs to a cluster; both still leave choosing a suitable machine and checking it to you.

I built [GPUlayer](https://www.gpulayer.dev/) ([GitHub](https://github.com/antonellof/gpulayer)) for two reasons.

First, my GPUs live on different machines: an Apple Silicon laptop, a couple of Linux boxes, and rented cloud VMs. Starting a workload meant `ssh`, `rsync`, hoping the virtualenv and CUDA build still matched the driver, running inside `tmux`, and copying checkpoints back. For multi-node jobs it meant starting `torchrun` by hand on every host with matching ranks and addresses.

Second, I needed a way to give my coding agents control over all of those GPUs. I do most of my work inside Claude Code, Pi agents, and MCP clients on my laptop. Giving an agent raw SSH keys and teaching it which machine is free, which one has CUDA vs. Metal (`mps` or `mlx`), and how to copy results back is fragile. I wanted a single control plane so an agent can inspect every GPU I can reach, submit a job, read the logs, and fetch the outputs safely.

With GPUlayer, running a job on a remote GPU is:

```bash
pip install gpulayer
gpulayer submit --accelerator cuda --source my_project -- python train.py
```

## What GPUlayer does

GPUlayer sits between your code and the machines you can reach: your laptop, servers that joined with `gpulayer join`, [Kubernetes worker pools](https://www.gpulayer.dev/docs/guides/kubernetes/), or [cloud VMs created per job](https://www.gpulayer.dev/docs/guides/cloud-providers/).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/architecture-dark.svg" />
  <img src="/assets/images/gpulayer/architecture-light.svg" alt="GPUlayer architecture: commands, Python functions, PyTorch training, and services go through GPUlayer to your laptop, remote servers, and cloud VMs" />
</picture>

Four kinds of work share the same queue and scheduler:

- [Commands and binaries](https://www.gpulayer.dev/docs/workloads/commands/) in any language, such as scripts, Blender renders, or `ffmpeg` pipelines, with inputs staged and output files returned (`gpulayer submit --accelerator cuda --source ./app -- ./render.sh`).
- [Python functions](https://www.gpulayer.dev/docs/workloads/functions/) decorated with `@gl.remote(accelerator="mps", frameworks={"mlx": ">=0.10"})`, called once or fanned out across free workers with `fn.map([...])`.
- [PyTorch training and launch](https://www.gpulayer.dev/docs/pytorch/trainer/) through `gpulayer.pytorch.Trainer`, which runs the same script in-process, as multi-process DDP, or across multiple nodes (`Trainer(accelerator="cuda", devices=4, num_nodes=2, target="remote")`) with mixed precision, callbacks, checkpoints, CUDA batch prefetching, and two-level gradient sync. Existing PyTorch Lightning or Accelerate scripts can use [`glt.launch()`](https://www.gpulayer.dev/docs/pytorch/launch/).
- [Long-running services](https://www.gpulayer.dev/docs/guides/services/) (`gpulayer submit --service` or `gl.service(...)`), which keep replicas running on separate workers, assign each a free `$PORT`, report `host:port` endpoints, and restart or reschedule failed replicas.

## Placement that explains itself

Workers probe their hardware and environment on startup. For GPU libraries (`torch.cuda`, `jax.cuda`, `cupy.cuda`, `torch.mps`, `mlx`), each worker runs a check in a separate Python subprocess to verify that the library actually executes on the GPU, so a CPU-only `jax` build or broken driver is never advertised as a working GPU.

When no worker fits a job, the [scheduler](https://www.gpulayer.dev/docs/architecture/scheduling/) rejects it before starting anything and reports the reason for every worker:

```text
scheduling: no eligible worker
  gpu-box-1    needs 2 usable cuda device(s), worker has 1
  mac-studio   framework 'jax' not installed
  laptop       torch on this worker cannot use CUDA
  gpu-box-2    eligible
```

Placement also accounts for network and GPU topology. Workers report their cloud `zone`, `region`, and an optional `gpulayer.dev/network-group` label, and the scheduler keeps distributed jobs in one rack, zone, or region whenever possible ([ADR-0021](https://www.gpulayer.dev/docs/decisions/ADR-0021-topology-aware-group-placement/)). On multi-GPU machines, workers parse `nvidia-smi topo -m` and pick the free GPU subset whose slowest link is fastest, preferring an NVLink island or a shared PCIe switch over arbitrary lowest device indices.

## Giving coding agents control over your GPUs

To let Claude Code, Pi agents, Cursor, and Codex run GPU workloads without SSH keys or admin privileges, GPUlayer includes an [MCP server and a CLI Agent Skill](https://www.gpulayer.dev/docs/guides/ai-agents/):

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

With a `submitter` token (or `--read-only`), an agent can list free GPUs (`gpulayer_resources`), ship a local project directory and start a job (`gpulayer_submit`), wait for it to finish (`gpulayer_wait`), read per-rank logs (`gpulayer_job_logs`), and download checkpoints (`gpulayer_download_outputs`). Every job records which token submitted it on the web dashboard (`gpulayer dashboard`).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/dashboard/overview-dark.png" />
  <img src="/assets/images/gpulayer/dashboard/overview-light.png" alt="GPUlayer web dashboard overview showing jobs, workers, and cluster activity" />
</picture>

Adding your own machines takes one command (`gpulayer up` on the server, then paste the printed `gpulayer join` line on any worker, including machines behind NAT). When no standing worker fits a job, [Google Cloud provisioning](https://www.gpulayer.dev/docs/guides/cloud-providers/) (`--provider gcp --accelerator cuda`) can create a Spot GPU VM, join it to the pool, run the job, and delete the VM when it finishes.

## Performance and benchmarks

All benchmark scripts and raw logs are in [`benchmarks/`](https://github.com/antonellof/gpulayer/tree/main/benchmarks), and the full method is on the [Performance and comparison](https://www.gpulayer.dev/docs/get-started/performance-and-comparison/) page.

### Single-GPU speed against the PyTorch Lightning Trainer

On a GCP `n1-standard-8` VM with one NVIDIA Tesla T4 (PyTorch 2.15.0, CUDA 13.2, Lightning 2.6.6), we trained the same models, data, and SGD optimizer with both trainers (loggers and checkpointing off):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/training-step-dark.svg" />
  <img src="/assets/images/gpulayer/perf/training-step-light.svg" alt="Training step time on Tesla T4: GPUlayer vs PyTorch Lightning" />
</picture>

| Case (Tesla T4 / CPU) | GPUlayer | PyTorch Lightning | Result |
|---|---:|---:|---|
| MLP, fp32, batch 256 | 4.06 ms/step | 5.64 ms/step | 1.39x faster |
| MLP, fp16 mixed precision | 5.00 ms/step | 6.25 ms/step | 1.25x faster |
| CNN, fp16 mixed, batch 128 | 10.82 ms/step | 12.33 ms/step | 1.14x faster |
| DDP, 2 CPU processes | 3.20 ms/step | 9.56 ms/step | 2.99x faster |

On small models, GPUlayer's loop does less per-step work and does not wait for the GPU when logging a loss. On the compute-bound CNN, GPUlayer turns on cuDNN autotuning and copies the next batch to the GPU on a side stream (`Runtime.batches`) while the current step runs, cutting the T4 step from 12.67 ms (both off) to 10.93 ms (both on). On one GPU, GPUlayer also starts 0.1 to 0.7 s sooner:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/startup-dark.svg" />
  <img src="/assets/images/gpulayer/perf/startup-light.svg" alt="Startup time: GPUlayer vs PyTorch Lightning" />
</picture>

### Multi-node training and locality

We trained a CNN across 2, 4, and 8 GCP `n1-standard-4` VMs (4 processes per machine, up to 32 processes over `gloo`), alternating between GPUlayer (`Trainer(num_nodes=N, devices=4)`) and the PyTorch Lightning Trainer started with `torchrun` on each machine:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/strong-scaling-dark.svg" />
  <img src="/assets/images/gpulayer/perf/strong-scaling-light.svg" alt="Multi-node strong scaling across 2, 4, and 8 machines: GPUlayer vs PyTorch Lightning" />
</picture>

| Machines (Processes) | GPUlayer | PyTorch Lightning (`torchrun`) | GPUlayer Lead |
|---|---:|---:|---|
| 2 (8 procs) | 118.9 s | 120.8 s | 1.6% faster |
| 4 (16 procs) | 73.3 s | 77.4 s | 5.3% faster |
| 8 (32 procs) | 50.5 s | 57.3 s | 11.9% faster |

GPUlayer's lead on 8 machines comes from [two-level gradient sync](https://www.gpulayer.dev/docs/decisions/ADR-0020-two-level-gradient-sync/), which sums gradients inside each machine before running one all-reduce across machines (cutting the 8x4 step from 117 ms to 102 ms), and it starts every node from one `Trainer(num_nodes=8)` call.

On 12 Skylake VMs across `europe-west1-b`, `europe-west1-c`, and `europe-west4-a`, splitting a 4-machine job across two regions (56.2 s) was 16 to 24% slower than keeping it in one region (45.0 to 48.6 s). When submitted without pinning, the scheduler placed all 4 machines in one zone on its own.

### Direct distributed launch and 30-machine scale

GPUlayer starts the processes of a distributed job directly instead of going through `torchrun`'s elastic agent, saving 1.1 to 2.3 s per job on 2 to 16 machines:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/distributed-startup-dark.svg" />
  <img src="/assets/images/gpulayer/perf/distributed-startup-light.svg" alt="Distributed job startup: GPUlayer direct launcher vs torchrun" />
</picture>

Across two heterogeneous VMs and a 30-machine fleet (120 slots across two GCP regions), GPUlayer ran 5,000 tiny jobs, 2,000 data shards, and 480-run sweeps, reached 92.7 jobs/s with `submit_batch`, stopped all 8 machines of a failing distributed job within 4.9 s, and retried in-flight tasks on healthy workers when 3 VMs were killed mid-run with zero failed jobs.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/assets/images/gpulayer/perf/scale-dark.svg" />
  <img src="/assets/images/gpulayer/perf/scale-light.svg" alt="Spreading jobs across machines: cumulative task time vs wall clock time" />
</picture>

## Where it sits and what is left

The [Compare page](https://www.gpulayer.dev/compare/) covers how GPUlayer relates to PyTorch Lightning, Accelerate, Ray, SkyPilot, dstack, Modal, Slurm, and Kubernetes:

- PyTorch Lightning and Accelerate organize training inside the machines they are started on; GPUlayer sits underneath them to pick the hardware, ship code, and start the processes.
- Ray, SkyPilot, and dstack manage clusters or cloud capacity; GPUlayer focuses on a simple `gpulayer up` / `gpulayer join` for hardware you already have, placement with per-worker explanations, Apple Silicon and CUDA support, and MCP/agent integration.
- Modal has a similar `@remote` interface on Modal's infrastructure; GPUlayer is self-hosted on your own machines and cloud accounts.

Every capability in the initial design is now tested or hardware-validated except running several GPUs per machine and NCCL across machines ([Status and roadmap](https://www.gpulayer.dev/docs/project/status/)). Multi-GPU reservation and `nvidia-smi topo -m` interconnect selection are implemented and tested against recorded topologies, while live multi-GPU runs are waiting on Google Cloud GPU quota. Other cloud providers, a load balancer in front of services, and sandboxing for untrusted users are also still ahead.

## Try it

```bash
pip install gpulayer          # or: pip install "gpulayer[torch]"
gpulayer resources detect     # inspect local GPUs and frameworks
gpulayer up                   # start the control plane
gpulayer dashboard            # open the web UI
```

Documentation and quickstart: [gpulayer.dev/docs](https://www.gpulayer.dev/docs/) · [Quickstart](https://www.gpulayer.dev/docs/get-started/quickstart/) · [Compare](https://www.gpulayer.dev/compare/) · [GitHub](https://github.com/antonellof/gpulayer)

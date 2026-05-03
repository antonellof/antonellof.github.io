---
layout: post
title: "Cognitora: A Datacenter-Scale, Open-Source LLM Inference Orchestrator (NVIDIA Dynamo Alternative)"
date: 2026-05-03
categories: [Systems]
tags: [LLM Inference, vLLM, SGLang, TensorRT-LLM, NVIDIA Dynamo, KV Cache, Disaggregated Inference, Rust, Kubernetes, GPU Orchestration]
excerpt: "Inference engines like vLLM, SGLang, and TensorRT-LLM are excellent at saturating one node. They are not, by themselves, a multi-node serving system. Cognitora is a single-binary, Rust-only orchestration layer that turns those engines into a KV-aware, disaggregated, energy-conscious cluster — without a Python control plane or a Kubernetes-only runtime. This post walks through the architecture, the routing model, and how it stacks up against NVIDIA Dynamo, Ray Serve, KServe, Triton, and the vLLM Production Stack."
---

If you have spent any time pushing an LLM into production, the shape of the problem is familiar. A single H100 with [vLLM](https://github.com/vllm-project/vllm) serves Llama 3 8B at impressive throughput. A single node with [SGLang](https://github.com/sgl-project/sglang) handles structured generation beautifully. [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM) wrings every last token-per-second out of an NVL72. None of those are a *cluster*. The moment the workload outgrows one box — or the moment the prefill phase wants different hardware than the decode phase, or the moment a hot prefix shows up on the wrong replica — you are back to writing a routing layer, a KV-cache layer, and a deployment layer yourself.

The two reference points the rest of the industry agrees on are [**NVIDIA Dynamo**](https://github.com/ai-dynamo/dynamo) (Rust core, Python frontend, Kubernetes-first) and a long tail of generic ML serving stacks: [**Ray Serve**](https://docs.ray.io/en/latest/serve/), [**KServe**](https://kserve.github.io/website/), [**NVIDIA Triton Inference Server**](https://github.com/triton-inference-server/server), [**BentoML**](https://github.com/bentoml/BentoML), and the [**vLLM Production Stack**](https://github.com/vllm-project/production-stack). Each makes a different tradeoff between "specialized for LLM inference" and "general purpose," between "one click on a managed cloud" and "I can run it on bare metal in a datacenter I own."

[**Cognitora**](https://github.com/antonellof/cognitora-inference) is an open-source LLM inference orchestration layer that lands in a deliberately specific spot in that design space: **bare-metal-first, Rust-only, engine-agnostic, KV-cache-aware**. It does not replace vLLM or SGLang — it coordinates them into a cluster. It is distributed as six statically-linked binaries with no Python control plane, no JVM operator, and no hard Kubernetes dependency. The same artifacts run as systemd units on a rack of servers, as a Helm chart on Kubernetes, or as Terraform-provisioned VMs across AWS, GCP, Azure, and Hetzner.

This post is the long-form version of *why that combination of choices*, and what falls out of them.

```bash
# One-line install — six static binaries, no runtime deps
curl -fsSL https://raw.githubusercontent.com/antonellof/cognitora-inference/main/deploy/installer/install.sh | sh

# Bring up Llama-3.1 8B on a single GPU with vLLM
bash recipes/llama3-8b/vllm/agg/up.sh

# Same model, prefill/decode disaggregated across two GPUs
bash recipes/llama3-8b/vllm/disagg-single-node/up.sh
```

## The thing inference engines don't do

A modern inference engine is a token factory. Hand it a request, get tokens back. The contract is "one process, one model, one node." Everything outside that contract — which replica should serve this request, which replica already has the system prompt cached on-GPU, when to spill cold KV blocks to RAM or SSD, when to migrate a long-context request from a prefill-optimized box to a decode-optimized one, how to weight a thermally-throttled GPU in the routing decision — is, from the engine's point of view, somebody else's problem.

Historically *somebody else* was a stack of glue: an Nginx in front, a Redis for KV metadata, a Python scheduler reading Prometheus, a Kubernetes operator reconciling deployments, a custom autoscaler. That stack works. It is also five processes in five languages with five failure modes, and it is the part of the system that has the worst observability story precisely when an SRE needs it most — at 03:00 on the first day a new model is in production.

The Cognitora bet is that the orchestration layer should be **one runtime, in Rust, with a small surface area**. Six binaries, each one statically linked, each one with a well-defined responsibility:

| Binary           | Job                                                                |
| ---------------- | ------------------------------------------------------------------ |
| `cgn-router`     | OpenAI-compatible HTTP gateway + KV-aware routing                  |
| `cgn-agent`      | Per-node engine supervisor + NVML telemetry                        |
| `cgn-kvcached`   | Tiered KV cache daemon (GPU / RAM / SSD) + QUIC/RDMA peer fetch    |
| `cgn-metrics`    | Prometheus aggregator + Redfish/IPMI/DCGM power telemetry          |
| `cgn-ctl`        | Admin CLI (install, cluster, model, pki, bench)                    |
| `cgn-operator`   | Optional Kubernetes operator (kube-rs)                             |

The `cgn-operator` is optional on purpose. If you run on bare metal, the systemd path is a first-class citizen rather than the "deprecated, please use the Helm chart" path that most cloud-native projects eventually push you toward.

## KV-aware routing: the routing decision is the product

The single biggest lever in multi-node LLM inference is *not* token throughput. It is **KV cache reuse**. If a request shares a 4,000-token system prompt with a request that finished 200 ms ago on replica B, sending the new request to replica B saves 4,000 tokens of prefill compute. Sending it to replica A — because round-robin said so — burns a GPU-second to recompute something that already exists in HBM somewhere else in the cluster. At fleet scale that decision dominates everything else.

There are two common ways to encode "which replica has which prefix":

1. **Radix trees over chained block hashes.** This is what Dynamo's KV-aware router uses. Each block of KV is hashed; the cluster maintains a radix tree keyed on those hashes; the router descends the tree to find the deepest match. Fast, memory-efficient, the canonical structure.
2. **Sequence-chained BLAKE3 digests with longest-prefix overlap.** This is Cognitora's choice. Each block's digest is chained from the previous block's digest, so the digest at position `i` summarizes the entire prefix `[0..i]`. Routing becomes "which replica reports the deepest prefix match against this digest sequence?"

The two approaches are close cousins. The motivating difference for Cognitora is **positional correctness on interleaved requests**. With a chained digest, two requests that share tokens out of order — same content, different positions — produce different chains, so the router does not falsely claim a cache hit that would force the engine to recompute or, worse, return a positionally incorrect KV. On real-world traces with heavy system-prompt sharing the practical hit ratio sits at **≥ 0.55**, and the routing decision itself is sub-millisecond:

| Metric                                                | Target                |
| ----------------------------------------------------- | --------------------- |
| `cgn-router` routing decision p99                     | < 500 µs / vCPU       |
| `cgn-router` HTTP overhead vs direct engine           | < 3 ms p99            |
| `cgn-kvcached` warm tier hit                          | < 200 µs              |
| `cgn-kvcached` cold tier hit (SSD)                    | < 5 ms                |
| Cross-node QUIC fetch (1 MiB block, 10 GbE)           | < 12 ms               |
| Representative cache hit ratio                        | ≥ 0.55                |
| Energy efficiency vs round-robin baseline             | ≥ 1.4×                |

Worth flagging the obvious caveat: those are the project's stated targets, not numbers measured on your traffic. The shape of the metrics matters more than the absolute values — sub-millisecond routing, single-digit-millisecond HTTP overhead, sub-200-µs warm hits. If any of those numbers grew by an order of magnitude the architecture would fall apart, so they are useful as a sanity envelope.

## Disaggregation: prefill and decode want different hardware

Prefill is compute-bound. Decode is memory-bandwidth-bound. Running both on the same SKU is a compromise — you either over-provision compute for the decode phase or starve memory bandwidth for the prefill phase. The fix, popularized by [DistServe](https://arxiv.org/abs/2401.09670) and now standard in production stacks, is **disaggregated inference**: prefill on one pool of GPUs, decode on another, with the KV blocks streamed between them.

Cognitora handles disaggregation through the [NIXL](https://github.com/ai-dynamo/nixl) connector — the same NVIDIA-developed transport library Dynamo uses — and exposes the choice as a single TOML knob:

```toml
[engine]
kv_offload = "nixl"   # one of: none | nixl | lmcache | hicache | kvbm
```

That single knob renders the right engine argv for vLLM, SGLang, or TensorRT-LLM. The recipe folders ship the topologies most people actually want — `recipes/llama3-8b/vllm/agg/`, `recipes/llama3-8b/vllm/disagg-single-node/`, `recipes/llama3-70b/vllm/agg/` — so you do not have to translate "I want 70B FP8 on 4×H100 with TP=4 and disaggregation off" into engine-specific flags.

Engine support matrix:

| Engine        | KV routing | Disaggregation | KV offload backends         |
| ------------- | ---------- | -------------- | --------------------------- |
| vLLM          | yes        | NIXL           | LMCache, KVBM, multi-tier   |
| SGLang        | yes        | NIXL           | HiCache, multi-tier         |
| TensorRT-LLM  | yes        | NIXL           | KVBM (WIP), multi-tier      |
| llama.cpp     | yes        | n/a            | multi-tier                  |
| OpenAI-compat | yes        | n/a            | n/a (Ollama, hosted APIs)   |

llama.cpp and OpenAI-compatible servers as **first-class engines** — not "we tolerate them, here is a config flag" — is a genuine differentiator. It means the same router that fronts your H100 fleet can also fan requests out to a developer's Ollama on a Mac mini, or to a hosted Anthropic / OpenAI / Together endpoint when on-prem capacity is saturated. That changes what cluster topologies are reasonable to consider.

## Tiered KV cache + cross-cluster federation

The KV cache is a hierarchy in any non-trivial deployment: GPU HBM is hot and small, system RAM is warm and bigger, SSD is cold and effectively unbounded. `cgn-kvcached` materializes that hierarchy as one daemon with explicit tier latencies (sub-200 µs warm, sub-5 ms cold) and a **QUIC peer-fetch path** between nodes — so a cache miss on node A that lives in node B's RAM does not become a recompute, it becomes a 12 ms cross-node fetch.

The federation piece is the part that surprised me on first read. Cognitora's router can form a **federation across clusters**, not just nodes — meaning a hot prefix that exists in your Frankfurt region can serve a request that landed on your Virginia router, if the prefill cost amortized across the network round-trip beats recomputing locally. Most production stacks do not even attempt this; they treat each cluster as an island. Whether that capability is *worth the operational complexity* depends entirely on your traffic shape, and Cognitora makes the right call by leaving it off by default.

## Energy-aware scheduling

The bit of the design I like most aesthetically is also the one with the least proven impact: routing decisions can incorporate **power telemetry from Redfish, IPMI, and DCGM**. A GPU that is thermally throttled, or a node whose PSU is drawing closer to its budget than its neighbors, gets weighted down in admission control. The stated efficiency target — **≥ 1.4× over a round-robin baseline** — is plausible on workloads where the cluster is power-limited rather than compute-limited, which is increasingly the situation in modern racks where power per rack-U is the binding constraint.

I would not buy a system *because* of energy-aware scheduling alone. I would treat it as a strong tiebreaker if it is otherwise the right shape — and it is one of the explicit gaps in Dynamo today, which doesn't surface power telemetry into routing.

## Cognitora vs NVIDIA Dynamo

Dynamo is the obvious comparison and the most capable alternative. The two projects share a lot of DNA — Rust core, KV-aware routing, NIXL-based disaggregation, Prometheus telemetry — and disagree on a small number of important things.

| Aspect                          | Cognitora                                                          | NVIDIA Dynamo                                            |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Runtime artifact                | Six static Rust binaries (no Python control plane)                 | Rust core + Python frontend                              |
| First-class engines             | vLLM, SGLang, TRT-LLM, **llama.cpp**, **OpenAI-compat**            | vLLM, SGLang, TRT-LLM                                    |
| KV routing signal               | Sequence-chained BLAKE3 + longest-prefix overlap                   | Radix tree on chained block hashes                       |
| KV offload selection            | Single TOML knob (`none/nixl/lmcache/hicache/kvbm`)                | KVBM + LMCache + FlexKV (separate scripts)               |
| Multi-tier KV                   | RAM + SSD + cross-cluster QUIC peer fetch                          | Full G1–G4 (KVBM owns GPU/Host/SSD/remote)               |
| Cross-cluster federation        | yes — QUIC peer fetch + router federation                          | single cluster only                                      |
| Multi-model cascade             | yes — SLM→LLM logprob gating                                       | partial                                                  |
| Energy / power telemetry        | yes — Redfish + IPMI + DCGM                                        | not yet                                                  |
| Deployment surfaces             | Bare metal (systemd), Kubernetes (Helm), Terraform                 | Kubernetes-first (operator + CRDs)                       |
| Multimodal / video pipelines    | not yet                                                            | yes — Image E/P/D, FastVideo, SGLang Diffusion           |
| Gang scheduling                 | basic (node selectors)                                             | Grove (NVL72-aware)                                      |
| Install surface                 | one curl line, six static binaries                                 | pip, container, or operator                              |

Reading that table honestly: **if your workload is multimodal, video, or NVL72-shaped, pick Dynamo today.** That is where NVIDIA's investment is showing through. If your workload is text-only LLM serving on heterogeneous hardware (mix of H100 / L40S / older Ampere / on-prem llama.cpp / hosted API fallback), if you do not want a Python control plane in the hot path, if you care about cross-cluster federation, or if you operate a power-constrained rack and want telemetry to feed the scheduler — Cognitora is the closer fit.

The *llama.cpp + OpenAI-compat* line is the one I would emphasize most to anyone considering this for a real deployment. It changes what "the cluster" can include. A company-internal cluster that is allowed to burst to a hosted API during a traffic spike has a very different cost curve than a cluster that has to provision for peak.

## Cognitora vs the rest of the field

Dynamo is the closest comparison; the broader field is worth a paragraph each because the alternatives genuinely have different jobs.

**[vLLM Production Stack](https://github.com/vllm-project/production-stack)** is the most natural alternative if you are vLLM-only and Kubernetes-native. It ships a router, autoscaler, and observability stack tuned for vLLM. Cognitora is the right pick if "vLLM-only" is not a constraint you want to commit to — most production fleets end up running at least two engines (vLLM + SGLang for structured output, or vLLM + TRT-LLM for the largest models) and the multi-engine story is easier on Cognitora's side.

**[Ray Serve](https://docs.ray.io/en/latest/serve/)** is the right answer if you already run Ray, or if your inference workload is genuinely heterogeneous (LLM + classical ML + Python preprocessing + tool calls all in one DAG). Ray's strength is composability across arbitrary Python workloads. Cognitora's strength is being narrowly excellent at the LLM-serving slice — no Python in the data path, no Ray cluster to operate, no actor model to reason about.

**[KServe](https://kserve.github.io/website/)** is the Kubernetes-native, model-serving-CRD answer. It is the right fit when "this is one of forty model deployments my platform team manages, and they all need to look the same in the cluster." If LLM inference is the workload your platform team primarily exists to serve, the abstraction layer KServe imposes starts costing more than it saves.

**[NVIDIA Triton Inference Server](https://github.com/triton-inference-server/server)** is still excellent for *non-LLM* inference — vision, audio, classical models — and increasingly for LLMs via the TensorRT-LLM backend. If your fleet is mostly non-LLM with LLM as a side workload, Triton is the centerpiece. If LLM is the workload, the LLM-specific systems (Cognitora, Dynamo, vLLM Production Stack) are a better starting point because the things they specialize in — KV routing, prefill/decode disaggregation, prefix sharing — are not a thing Triton optimizes for at the platform level.

**[BentoML](https://github.com/bentoml/BentoML)** lives at a different altitude. It is excellent at "package this Python model + preprocessing + business logic into a deployable artifact." It is not, and does not try to be, a multi-node KV-aware orchestrator. The two compose: BentoML for service packaging, Cognitora (or Dynamo) for cluster-level orchestration of LLM-specific concerns.

The honest summary is that LLM serving has bifurcated into two layers that used to be one. The lower layer is "given a request and a replica, generate tokens efficiently" — vLLM, SGLang, TRT-LLM, llama.cpp own this. The upper layer is "given a fleet, route requests so KV is reused and disaggregation pays off" — Dynamo and Cognitora are the two open-source projects that take this layer seriously as a standalone product. Generic ML serving stacks (KServe, Triton, Ray Serve, BentoML) cover the upper layer for general workloads but do not optimize for the LLM-specific signals that turn out to dominate cost.

## Multi-model cascades

One smaller capability worth calling out because it has outsized cost impact: **multi-model cascades with logprob gating**. The idea is old — route easy queries to a small model, fall back to a large model only when the small one is uncertain — but the orchestrator has to support it natively or it becomes a Python-in-the-hot-path workaround. Cognitora exposes it as a routing policy:

```
small_model = "qwen3-7b"
large_model = "llama3-70b"
gate        = "logprob"     # escalate when small-model logprob < threshold
```

For workloads where ~70% of requests are genuinely simple (classification-shaped, lookup-shaped, short-answer chat), this cuts cost dramatically without touching tail quality. Dynamo has partial support; in Cognitora it is a first-class router policy.

## Honest limits

A few things I would want to know before betting a production deployment on this:

- **Pre-1.0.** The OpenAI-compatible HTTP surface is stable; the internal gRPC APIs and TOML config surface may shift in minor releases. Pin a version and read the changelog.
- **No multimodal/video.** If your roadmap includes image generation or video diffusion serving, Dynamo is ahead. The Cognitora architecture has no in-principle obstacle here, but the engine integrations are not shipped today.
- **Gang scheduling is basic.** Node selectors, not [Grove](https://github.com/NVIDIA/grove)-style NVL72-aware co-scheduling. If you operate NVL72 racks and need topology-aware placement, Dynamo is the better fit until this lands.
- **The performance numbers are targets, not benchmarks on your traffic.** The architecture supports them; whether your specific workload realizes them depends on prefix sharing, request shape, and hardware mix. The right move on a new deployment is to A/B against round-robin on a slice of real traffic and measure.
- **The cross-cluster federation story is powerful and operationally heavy.** Turn it on only when you actually have multi-region traffic that benefits from it. The defaults are sensibly conservative.

## Try it

```bash
# Install — six static binaries, no runtime deps
curl -fsSL https://raw.githubusercontent.com/antonellof/cognitora-inference/main/deploy/installer/install.sh | sh

# Bring up Llama-3.1 8B on a single GPU with vLLM
bash recipes/llama3-8b/vllm/agg/up.sh

# Disaggregated prefill/decode on two GPUs in one node
bash recipes/llama3-8b/vllm/disagg-single-node/up.sh

# Llama-3.3 70B FP8 on 4×H100 with TP=4
HF_TOKEN=… bash recipes/llama3-70b/vllm/agg/up.sh
```

On Kubernetes:

```bash
helm install cognitora oci://ghcr.io/antonellof/charts/cognitora \
  --set router.replicas=2 \
  --set models.llama3-70b.tp=4
```

From source (if you want to read the routing code, which I recommend — it is the most interesting part):

```bash
git clone https://github.com/antonellof/cognitora-inference.git
cd cognitora-inference
cargo build --release --no-default-features \
  -p cgn-router -p cgn-agent -p cgn-kvcached \
  -p cgn-metrics -p cgn-ctl -p cgn-operator
```

Once a router is up, point any OpenAI-compatible client at it. The wire protocol is the lingua franca, so existing application code does not change.

## Why this shape of system, now

The closing observation is meta. For two years the LLM-inference field has tolerated a stack where Python is in the request path, Kubernetes is the only first-class deployment target, and "the orchestrator" is whatever combination of Nginx, Redis, and homegrown schedulers a given team has glued together. That stack works at startup scale. It does not work at datacenter scale, where a 1% efficiency gain is worth more than a feature, where the difference between sub-500-µs and 5-ms routing decisions shows up as a line item, and where the operations team would prefer a single binary they can `strace`.

Cognitora is one answer to *"what would the orchestrator look like if it were designed today, for that scale, in one language, with KV cache reuse as the centerpiece rather than an afterthought?"* NVIDIA Dynamo is another. Both are credible; they make different bets on the runtime shape (single-binary Rust vs Rust+Python), the deployment surface (bare-metal-first vs Kubernetes-first), and the engine ecosystem (broad including llama.cpp/OpenAI-compat vs the three industrial engines). Which one fits depends on what your fleet actually looks like — and the fact that there are two well-engineered open-source choices in this layer at all is a meaningful change from where the field was twelve months ago.

**Links:**

- [Cognitora repository](https://github.com/antonellof/cognitora-inference) — Apache-2.0, Rust 1.89+
- [NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo) — the closest comparable system
- [vLLM Production Stack](https://github.com/vllm-project/production-stack) — vLLM-only alternative
- [NIXL](https://github.com/ai-dynamo/nixl) — the disaggregation transport both projects build on
- [DistServe](https://arxiv.org/abs/2401.09670) — the original prefill/decode disaggregation paper
- [Ray Serve](https://docs.ray.io/en/latest/serve/) · [KServe](https://kserve.github.io/website/) · [Triton Inference Server](https://github.com/triton-inference-server/server) · [BentoML](https://github.com/bentoml/BentoML) — generic ML-serving alternatives

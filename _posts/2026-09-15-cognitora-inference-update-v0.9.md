---
layout: post
title: "Cognitora v0.9.1: gossip discovery, live KV prefix, and a native engine"
date: 2026-09-15
categories: [Systems]
tags: [LLM Inference, vLLM, SGLang, NVIDIA Dynamo, KV Cache, Disaggregated Inference, Rust, Kubernetes, GPU Orchestration, Cognitora]
excerpt: "Cognitora is at v0.9.1. Since the May v0.3.0 post, the project added etcd-optional gossip discovery, live KV prefix tracking, carbon-aware admission, a zero-dependency fleet dashboard, a seventh binary for native GGUF inference, and a preview CognitoraConnector path into cgn-kvcached. Here is what shipped and what stays preview."
---

[**Cognitora**](https://github.com/antonellof/cognitora-inference) is an open-source LLM inference orchestration layer. Statically linked Rust binaries sit above vLLM, SGLang, TensorRT-LLM, llama.cpp, and MLX. Those engines stay the token factories. Cognitora coordinates them into a KV-aware, disaggregated cluster.

The router scores replicas by prefix overlap with sequence-chained BLAKE3 digests. Prefill and decode run on different GPUs with NIXL between them when you ask for disaggregation. Tiered KV spill lives in `cgn-kvcached`. No Python control plane. No hard Kubernetes dependency. The same artifacts run as systemd units on a rack, as recipes on one host, or via Helm.

One node with vLLM saturates well. None of the token factories are a fleet. Hot prefixes land on the wrong replica. Prefill wants different hardware than decode. You end up writing routing, cache, and deployment layers yourself. [NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo) covers part of the space. Cognitora lands bare-metal-first, Rust-only, and engine-agnostic.

The [original post](https://www.fratepietro.com/2026/cognitora-inference-llm-orchestration/) covers the full architecture and the Dynamo comparison. The May write-up described **[v0.3.0](https://github.com/antonellof/cognitora-inference/releases/tag/v0.3.0)**: real `/v1/embeddings`, a Kubernetes CPU quickstart on GKE, `cgn-ctl install --apply`, and Llama 3 8B/70B recipes. Six months and six minor releases later, Cognitora sits at **[v0.9.1](https://github.com/antonellof/cognitora-inference/releases/tag/v0.9.1)** (September 2026). The thesis stayed put: one Rust runtime, KV reuse as the routing signal, bare-metal-first. Most of what I called "designed but not fully wired" in May is wired now. A few bets landed after the May write-up.

```bash
# Pin the current release
curl -fsSL https://inference.cognitora.dev/install | CGN_VERSION=v0.9.1 sh

# Fastest sanity check: 8B aggregated on one GPU
bash recipes/llama3-8b/vllm/agg/up.sh

# Cognitora-native KV offload into cgn-kvcached (preview)
bash recipes/llama3-8b/vllm/agg-cgn/up.sh

# Disagg with CognitoraConnector + NIXL multi-connector (preview, 2 GPUs)
bash recipes/llama3-8b/vllm/disagg-cgn/up.sh

# Native GGUF engine, no external vLLM required (preview)
bash recipes/llama3-8b/cgn-infer/single-node/up.sh
```

## Release map: v0.3 → v0.9.1

| Version | Theme | Headline |
| ------- | ----- | -------- |
| **0.4.0** | Make the KV layer live | Prefix index populated after dispatch. `cgn-kvcached` eviction loop (RAM watermark spill + SSD TTL). Real hit/miss/spill stats |
| **0.5.0** | Native inference engine | **`cgn-infer`**: seventh binary, Candle + mmap GGUF, continuous batching, distributed layer-pipeline gRPC (preview) |
| **0.6.0** | Feed the routing score | Engine Prometheus scraper feeds queue/cache into the score. Closed autoscaler cordon loop. Streaming cascade. TensorRT-LLM spawn driver |
| **0.7.0** | OpenAI parity + live KV prefix | Tool calling, structured output, multimodal image passthrough. Post-generation KV prefixes written to etcd. SLA planner in operator. Turnkey Helm. Multi-node e2e in CI |
| **0.8.0** | Etcd-optional | Gossip discovery (`state_backend = "gossip"`). Cross-cluster federation wired. Soft `watt_limit`. ROCm. Capability-aware routing. Fleet dashboard |
| **0.9.0** | Carbon + live KV prefix reconciliation | Carbon-aware admission for deferrable workloads. KV epoch + eviction-burst prefix reconciliation |
| **0.9.1** | Admission + energy metrics | Per-model inflight caps on the gateway. Fleet `tokens_per_watt` gauges. Energy benchmark harness |
| **Unreleased** | CognitoraConnector | `kv_offload = "cgn"` spills vLLM blocks into `cgn-kvcached` via `python/cgn-kv-connector`. Router prefix digest passthrough to the connector |

The sections below group by operator impact, not by semver.

## The routing score now uses real signals

In May I described KV-aware routing as sequence-chained BLAKE3 digests plus longest-prefix overlap, with load, power, and capacity terms in the score. In v0.3 those secondary terms were mostly inert. The architecture supported them. The data path did not fill them.

**v0.4** turned on optimistic prefix recording after every successful dispatch. Prefill and decode nodes in a disaggregated pair both get indexed.

**v0.6** closed the loop on load and capacity. `cgn-agent` scrapes the engine Prometheus `/metrics` (vLLM queue depth and GPU cache usage, SGLang equivalents) and publishes numbers in the heartbeat and `Agent.Health` RPC. Nodes with unknown capacity report `total_blocks == 0` instead of inventing a value.

**v0.7** replaced pure optimism with live KV prefix tracking. After a generation completes, the agent writes lease-bound etcd keys under `/cognitora/kv/<node>/<digest>`. The router watcher mirrors PUT/DELETE into the prefix map. Entries expire with the node's heartbeat lease. The agent prunes under KV pressure (under 5% free blocks) and past a 4096-key cap. The overlap score tracks what engines cached, not what the router hoped would land.

**v0.9.0** added KV epoch reconciliation. Agents publish a monotonic `kv_epoch` in heartbeats (bumped on engine restart, block-pool resize, or large free-block jumps). The router prunes stale prefix entries on epoch changes, eviction bursts, and pressure. Cognitora treats this as a workable alternative to engine block-hash KV events, which do not map cleanly onto the BLAKE3 digest chain.

If you evaluate Cognitora on prefix-heavy traffic, this progression is the gap between a neat design and a router stopping you from hitting a node whose system prompt left HBM ten minutes ago.

## Etcd is optional. Federation forwards.

The original post treated etcd as the cluster state backend and called cross-cluster federation operationally heavy. Both need a September update.

Gossip discovery (`state_backend = "gossip"`, v0.8) wraps [chitchat](https://github.com/quickwit-oss/chitchat) scuttlebutt over UDP. Agents republish the same JSON node record they would write to etcd. The router joins as a record-less member and reconciles live members every 2.5s. Multi-node clusters from a laptop to a rack no longer require standing up etcd. Live KV prefix tracking, cordon flags, routing policy hot-reload, and autoscaler hints stay etcd-only by design. See [`docs/architecture/gossip.md`](https://github.com/antonellof/cognitora-inference/blob/main/docs/architecture/gossip.md).

Cross-cluster federation (also v0.8) is wired in the gateway. When local routing finds no eligible node and `[router.federation]` is enabled, the router forwards to the lowest-connect-latency reachable peer. Forwards are counted in `cgn_router_federation_forwards_total{model,peer}`. Single-hop by construction.

For a small fleet with zero external services, gossip is the headline. For multi-region without a Kubernetes-of-Kubernetes layer, federation matches the docs.

## Seven binaries, not six

**`cgn-infer`** (v0.5, preview) is Cognitora's first-party inference engine: mmap GGUF via Candle, OpenAI HTTP surface, BLAKE3 block-hash prefix cache aligned with `cgn-kvcached`, continuous batching, and a distributed layer-pipeline mode over a new activation-streaming gRPC service.

The binary ships in the same release tarballs and Docker image as the original six. Recipe: `recipes/llama3-8b/cgn-infer/single-node/`. Only `kv_offload = "none"` is valid. Disaggregation and external connector offload do not apply to the native engine yet.

I would not replace vLLM with `cgn-infer` for production LLM serving today. I would use the binary to see a fully self-contained Cognitora stack on a Mac or a CPU-only dev loop, and to watch how the layer-pipeline story evolves.

MLX on Apple Silicon landed in the v0.3.x line (`engine.kind = "mlx"`, mlx-lm's `mlx_lm.server`). The README lists MLX alongside vLLM and llama.cpp in the engine matrix. Same constraint: `kv_offload = "none"`.

## OpenAI surface: tools, images, streaming cascade

**v0.7** brought the gateway closer to what production clients send:

- `tools`, `tool_choice`, `response_format` pass through to vLLM/SGLang via a new `extensions_json` proto field.
- Streaming `delta.tool_calls` fragments aggregate into complete tool calls on buffered responses.
- Multimodal `content` arrays (`type: image_url`, …) round-trip to the engine. Prefix hashing uses text parts only so images do not pollute KV-overlap scoring.
- Cascade is bypassed for tool requests (tool formats are not portable across cascade models).

**v0.6** made the SLM→LLM cascade work on streaming traffic. Early cascade steps run buffered for confidence gating. If every cheap model escalates, the final model streams live token-by-token. Gateway dispatch retry/failover (up to 3 attempts, strictly before the first token) landed in the same release.

## KV strategy: one more knob (`cgn`)

The original post listed `engine.kv_offload` as `none | nixl | lmcache | hicache | kvbm`. The recipe matrix now walks every backend:

| Recipe | Backend | GPUs |
| ------ | ------- | ---- |
| `llama3-8b/vllm/agg-lmcache` | LMCache | 1 |
| `llama3-8b/vllm/agg-kvbm` | NVIDIA KVBM (Dynamo parity) | 1 |
| `llama3-8b/sglang/agg-hicache` | SGLang HiCache | 1 |
| `llama3-8b/vllm/agg-cgn` | CognitoraConnector → `cgn-kvcached` | 1 |
| `llama3-8b/vllm/disagg-cgn` | CognitoraConnector + NIXL multi-connector | 2 |

The new `kv_offload = "cgn"` path (unreleased / preview) installs `python/cgn-kv-connector`, which implements vLLM's `CognitoraConnector` and spills blocks into the colocated `cgn-kvcached` daemon over gRPC (`PutBlock`). The router forwards sequence-chained prefix digests as `kv_transfer_params.cgn_prefix_digests` so the connector probes the cache. When `kv_offload = "cgn"`, agents also BatchLookup local kvcached and pass `cgn_resident_digests` for scheduler-side hits.

Layer-4 routing intelligence and layer-2 engine offload share the same `cgn-kvcached` index without forcing LMCache or KVBM as intermediaries. The path is preview. Full layer-wise GPU↔host transfer is still being hardened.

## Energy, carbon, and admission are enforced

The May post called energy-aware scheduling a strong tiebreaker with Redfish/IPMI/DCGM telemetry. The v0.8 to v0.9 line turned several of those ideas into working knobs:

- Soft power cap (`[agent].watt_limit`): rides the heartbeat, mirrored to `cgn_cluster_node_watt_limit`. The selector prefers under-cap nodes.
- Cluster energy gauges (v0.9.1): `cgn_cluster_power_watts_total` and `cgn_cluster_tokens_per_watt`, refreshed every 5s.
- Energy benchmark harness (`scripts/bench/energy/`): samples router `/metrics` around `bench_client.py` runs and writes J/token to `summary.md`.
- Carbon-aware admission (v0.9.0): the router polls a grid-intensity provider (`static`, Electricity Maps, or WattTime) and rejects low-priority requests (`X-CGN-Priority: low`) while gCO₂/kWh exceeds threshold. Fails open until the first successful poll.
- Router admission control (v0.9.1): per-(model, role) inflight caps from `[router.admission].max_queue` enforced on chat, embeddings, and gRPC Generate. Deadline admission rejects when estimated TTFT exceeds the request deadline.

ROCm support (v0.8) extends the power story to AMD. `cgn-power` reads `rocm-smi`. Agents publish GPU identity from NVML or ROCm. Engine spawn pins both `CUDA_VISIBLE_DEVICES` and `HIP_VISIBLE_DEVICES`.

## Observability without Grafana

**v0.8** shipped a standalone fleet dashboard (`dashboard/`): zero dependencies, polls any CORS-enabled `/metrics` endpoint, in-browser ring buffers and canvas charts for req/s, tokens/s, latency p50/p95, TTFT p95, queue depth, power vs cap, KV used %, J/token, plus a live node table with GPU identity. Deep-linkable via `?endpoint=` and `?interval=`. A stdlib-only mock fleet generator simulates a 16-node mixed GPU fleet for demos.

The router mirrors its node registry into `cgn_cluster_node_*` gauges every 5s and observes `cgn_router_chat_ttft_seconds` on the first streamed token. `/metrics` answers CORS preflight so browser apps scrape any Cognitora listener directly.

If you read the original post and cared about sub-500 µs routing decisions, you also need to see whether those decisions help on your traffic. The dashboard fills the gap without standing up Prometheus + Grafana on day one.

## Kubernetes and CI maturity

Several items from the original honest-limits list moved:

- Turnkey Helm (v0.7): engine sidecar block, mTLS off by default for first contact, `hostNetwork` opt-in, chart README. Still no published OCI chart. Install from a git checkout or use the CPU quickstart manifest.
- Multi-node e2e in default CI (v0.7): `tests/e2e/multi_node_kv.sh` with a stub OpenAI engine, including a real 2-agent prefix-affinity assertion.
- GPU disaggregation bench harness (`scripts/bench/disagg/` + workflow_dispatch): reproducible prefill/decode split benchmarks. `--mode disagg-cgn` for the CognitoraConnector topology.
- Soft perf gate (since v0.3): `cargo bench` on routing/prefix paths posts a sticky PR comment. Hard S3 baselines remain planned.

The CPU quickstart manifest from v0.3 (`deploy/kubernetes/quickstart/cognitora-cpu.yaml`) remains the fastest path to a public URL without GPU quota.

## Heterogeneous fleets

Capability-aware routing (v0.8): agents publish `gpu_name`, `gpu_vendor`, `vram_total_mb`. Per-model `min_vram_mb` and `require_gpu` filter candidates. Nodes reporting no GPU identity are never filtered, so older agents keep working.

The recipe catalog expanded beyond Llama 3: Qwen-3 7B, DeepSeek-V4-Flash (B200 and GB200 variants for both vLLM and SGLang), and the full 8B KV-backend walkthrough. Llama-3.3 70B disagg-single-node (8× H100/H200, TP=4 prefill + TP=4 decode) remains the datacenter-shaped target. See the original post for hardware context.

## What I would revise in the original comparison

Reading the May Dynamo comparison today, a few rows need nuance:

| May write-up | September reality |
| ------------ | ----------------- |
| Cross-cluster federation "off by default, operationally heavy" | Wired in v0.8. Still off by default. No longer aspirational |
| Energy telemetry "strong tiebreaker" | Soft caps, fleet J/token gauges, carbon admission, and energy bench harness shipped |
| "Performance numbers are targets" | Still true for your traffic. Routing score terms, live KV prefix tracking, and engine telemetry are no longer placeholders |
| "No multimodal/video" | Text+image passthrough for chat models shipped in v0.7. Video diffusion serving still out of scope |
| "Gang scheduling is basic" | Still basic (node selectors, capability constraints). NVL72-aware co-scheduling not landed |
| "Helm chart maturity" | Turnkey in v0.7. OCI publish still on the roadmap |

Dynamo remains ahead on multimodal/video pipelines and NVL72-shaped gang scheduling. Cognitora's differentiation (llama.cpp + MLX + OpenAI-compat + native `cgn-infer`, gossip discovery, cross-cluster federation, carbon admission, positionally correct digests with live KV prefix tracking) is stronger than in May. The gap on "is the routing score real?" has largely closed.

## Honest limits (September 2026)

- Still pre-1.0. Pin `CGN_VERSION=v0.9.1` and read the [changelog](https://github.com/antonellof/cognitora-inference/blob/main/CHANGELOG.md). Expect Proto and TOML shifts in minor releases.
- `cgn-infer` and `CognitoraConnector` are preview. Do not bet production on them until the changelog drops the preview tag.
- No published OCI Helm chart. Local chart path or CPU quickstart manifest.
- Gossip vs etcd is a real tradeoff. Gossip gives you discovery. Live KV prefix tracking and policy hot-reload still want etcd.
- Cross-cluster federation and carbon admission are easy to misconfigure. Defaults stay conservative for a reason.
- Benchmark numbers on your hardware still require running the harness. CI gates routing microbenchmarks. Disagg and energy numbers need GPU hosts.

## Try the new paths

```bash
# Install v0.9.1
curl -fsSL https://inference.cognitora.dev/install | CGN_VERSION=v0.9.1 sh

# Gossip-backed two-node lab (no etcd). See docs/architecture/gossip.md
# state_backend = "gossip" in cognitora.toml

# Preview: vLLM blocks into cgn-kvcached
pip install ./python/cgn-kv-connector   # from repo checkout
bash recipes/llama3-8b/vllm/agg-cgn/up.sh

# Preview: native GGUF, no vLLM
bash recipes/llama3-8b/cgn-infer/single-node/up.sh

# Fleet dashboard against a running router
python3 dashboard/mock_metrics.py &   # optional mock fleet
open "dashboard/index.html?endpoint=http://127.0.0.1:8080/metrics"

# Energy benchmark (needs a live cluster + bench_client)
bash scripts/bench/energy/run.sh
```

**Links:**

- [Original Cognitora post (May 2026)](https://www.fratepietro.com/2026/cognitora-inference-llm-orchestration/)
- [Cognitora repository](https://github.com/antonellof/cognitora-inference) (Apache-2.0)
- [CHANGELOG](https://github.com/antonellof/cognitora-inference/blob/main/CHANGELOG.md) · [v0.9.1 release](https://github.com/antonellof/cognitora-inference/releases/tag/v0.9.1) · [v0.3.0 release](https://github.com/antonellof/cognitora-inference/releases/tag/v0.3.0)
- [KV strategy doc](https://github.com/antonellof/cognitora-inference/blob/main/docs/architecture/kv-strategy.md) · [Gossip discovery](https://github.com/antonellof/cognitora-inference/blob/main/docs/architecture/gossip.md) · [cgn-infer architecture](https://github.com/antonellof/cognitora-inference/blob/main/docs/architecture/cgn-infer.md)
- [Recipes index](https://github.com/antonellof/cognitora-inference/blob/main/recipes/README.md)
- [NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo) · [NIXL](https://github.com/ai-dynamo/nixl)

---
layout: post
title: "llama.cpp, vLLM, and SGLang: Three Approaches to LLM Inference"
date: 2026-10-21
categories: [Deep Dive]
tags: [LLM, AI, Generative AI, llama.cpp, vLLM, SGLang, LLM Inference, Machine Learning, AI Engineering, MLOps]
image: /assets/images/posts/llm-inference-three-tools.jpg
excerpt: "llama.cpp, vLLM, and SGLang all run transformer weights and stream tokens, yet each is built around a different systems bottleneck. Here is how they differ across model loading, KV cache memory, request scheduling, and execution, and how those choices set your latency, resource footprint, and serving cost."
---

In my [LLM inference learning roadmap](https://www.fratepietro.com/2026/llm-inference-learning-roadmap/), every call to a language model splits into two phases. **Prefill** reads the input prompt in parallel, builds the KV cache, and is compute-bound. **Decode** generates output tokens one at a time, reading the model weights from memory on every step, and is memory-bandwidth-bound.

The transformer math stays the same across engines. The bottleneck changes completely with your workload:

- **One user on a laptop or workstation** is constrained by memory capacity and single-stream memory bandwidth.
- **Hundreds of independent users hitting an API** are constrained by GPU KV cache fragmentation and batch utilization.
- **Multi-turn agents and RAG pipelines** calling the model ten times per task are constrained by repeated prefill computation over shared prefixes and structured JSON generation.

That split explains why **llama.cpp**, **vLLM**, and **SGLang** coexist instead of converging into one tool. Each engine optimizes model loading, memory layout, request scheduling, and token generation for a different traffic shape.

![Three LLM inference tools compared across four stages: llama.cpp for local GGUF inference on CPU and GPU, vLLM for high-throughput serving with continuous batching and PagedAttention, and SGLang for agent and multi-turn workflows with cache-aware routing and RadixAttention](/assets/images/posts/llm-inference-three-tools.jpg)

Working across all three layers, building [Frink](https://www.fratepietro.com/2026/frink-rust-alternative-to-llama-cpp/) against `llama.cpp`'s GGUF and kernel conventions, sizing local `llama.cpp` and `vLLM` plans in [Rondine](https://www.fratepietro.com/2026/rondine-hardware-aware-local-llm-launcher/), and routing across `vLLM` and `SGLang` pools in [Cognitora](https://www.fratepietro.com/2026/cognitora-inference-update-v0.9/), makes the architectural boundaries between them concrete. Here is how each engine works from model load to response stream, and how to compare them on performance, resource usage, and cost.

## 1. llama.cpp: local inference, GGUF quantization, and CPU/GPU flexibility

**[llama.cpp](https://github.com/ggml-org/llama.cpp)** starts from a strict constraint: run open-weight models on the hardware you already own, without a cloud GPU cluster, a Python runtime, or a 400 MB PyTorch dependency tree.

### 01. Local user and zero-dependency runtime

Written in C and C++ on top of `ggml`, `llama.cpp` compiles down to native binaries (`llama-cli` and `llama-server`). Startup takes milliseconds, idle memory overhead outside the model weights is near zero, and the engine targets a single user or a small handful of local concurrent streams.

### 02. Model loading: GGUF and fused block quantization

Instead of loading a directory of `safetensors` shards and JSON config files through Python, `llama.cpp` reads a single **GGUF** file. GGUF packs the tokenizer vocabulary, Jinja chat template, architecture hyperparameters, and quantized weight tensors into one header-indexed binary blob.

Two loading choices define its memory footprint and speed:

- **`mmap()` weight mapping.** The engine maps the GGUF file straight from disk into virtual memory. On Apple Silicon unified memory or Linux hosts with warm page cache, weights do not need to be copied across user-space buffers before inference starts, and multiple processes share the same physical pages.
- **Block quantization (`Q4_K_M`, `Q5_K_M`, `Q8_0`, `IQ4_NL`).** Weights are grouped into small blocks (for example, 32 weights per block in `Q8_0` or 256-weight super-blocks in K-quants) with compact scale factors. During single-user decode, the processor reads the entire weight matrix once per generated token. Shrinking a 16-bit checkpoint to 4.5 bits per weight (`Q4_K_M`) cuts memory traffic by more than 3x. Because `llama.cpp` dequantizes weights *inside* the dot-product kernel rather than expanding tensors back to FP16 in memory, that bandwidth reduction turns directly into higher tokens per second.

### 03. Inference across CPU and GPU

`llama.cpp` runs across almost any compute backend: CPU SIMD (`AVX2`, `AVX-512`, `ARM NEON`), Apple `Metal`, NVIDIA `CUDA`, AMD `HIP`, and cross-vendor `Vulkan` or `SYCL`.

When a checkpoint exceeds your discrete GPU's VRAM, layer offloading (`-ngl`) lets you split the transformer graph across devices. You pin as many layers (or Mixture-of-Experts shared layers) as fit into VRAM and stream the remaining layers from system RAM on the CPU. You trade decode latency for the ability to run a 32B or 70B model that would otherwise crash with an out-of-memory error.

### 04. Response and server surface

Output streams straight to your terminal or through `llama-server`'s OpenAI-compatible `/v1/chat/completions` endpoint. For concurrency, `llama-server` divides its allocated context buffer (`-c`) across a fixed number of parallel slots (`-np`). It also enforces structured outputs per token using GBNF grammars, masking out invalid vocabulary tokens before sampling so malformed JSON cannot be emitted.

```bash
# Serve a 4-bit GGUF checkpoint with 4 parallel slots, FlashAttention,
# and an 8-bit quantized KV cache on Apple Metal or CUDA
llama-server \
  -hf bartowski/Qwen2.5-14B-Instruct-GGUF:Q4_K_M \
  -ngl all \
  -c 16384 \
  -np 4 \
  -fa \
  -ctk q8_0 -ctv q8_0 \
  --port 8080
```

**Best for:**

- Local development, CLI tools, and desktop apps
- Offline, edge, and air-gapped deployments
- Running quantized models on Apple Silicon unified memory, consumer GPUs, or CPU+GPU split setups

(If you work in Rust or want a single 23 MB binary with verified logit parity against `libllama` and faster decode on Apple Metal, this is the exact space I built [Frink](https://github.com/antonellof/frink) for.)

## 2. vLLM: continuous batching, PagedAttention, and high-throughput serving

**[vLLM](https://github.com/vllm-project/vllm)** solves the opposite problem. You have dedicated datacenter or workstation GPUs, and dozens or hundreds of independent requests arrive at the same time. Your goal is to keep the GPU's Tensor Cores saturated and serve the highest possible tokens per second per dollar.

### 01. Many concurrent users

A single decode request is memory-bandwidth-bound: the GPU loads gigabytes of weights from High Bandwidth Memory (HBM) to compute a single token's activations, leaving most of its arithmetic units idle. When 64 users decode at once, the GPU loads each weight tile from HBM *once* and multiplies it against all 64 token vectors in a single batched matrix-matrix multiplication (GEMM). Batching converts wasted memory bandwidth into useful throughput.

### 02. Request scheduling: continuous batching and chunked prefill

Static batching groups `N` requests together and waits until every request in the batch finishes generating before starting the next batch. If three callers generate 40 tokens and the fourth generates 1,500 tokens, three GPU slots sit idle for 1,460 steps.

`vLLM` replaces static batches with **iteration-level continuous batching**:

- After every forward pass (one generated token), the scheduler evicts completed requests and injects waiting requests from the queue into the next iteration's batch.
- **Chunked prefill** prevents a newly arrived 16,000-token prompt from monopolizing the GPU for hundreds of milliseconds. The scheduler slices long prompts into fixed token chunks and runs one prefill chunk alongside active decode tokens in the same step, keeping inter-token latency (ITL) predictable for streaming users.

### 03. Memory management: PagedAttention

Batch size on a GPU is capped by how many requests' KV caches fit in HBM at once. Early serving stacks allocated one contiguous tensor of size `max_model_len` per request at arrival time because the engine did not know in advance whether a prompt would generate 20 tokens or 8,192 tokens. Between internal over-reservation and external memory fragmentation, 60% to 80% of KV memory sat unused.

**[PagedAttention](https://arxiv.org/abs/2309.06180)** applies operating-system virtual memory paging to the KV cache:

1. `vLLM` carves available GPU HBM into fixed-size **physical KV blocks** (typically 16 tokens per block).
2. Each request holds a lightweight **block table** mapping its logical token positions to physical blocks anywhere in HBM.
3. New physical blocks are allocated only as a sequence grows, and freed the instant the sequence finishes.

By eliminating contiguous reservation waste, `PagedAttention` packs 2x to 4x more concurrent requests onto the same GPU. Higher concurrency feeds larger batches into the GEMM kernels, driving throughput up. `vLLM` also layers hash-based automatic prefix caching (`--enable-prefix-caching`) on top of these block tables, allowing requests that start with the exact same block-aligned prefix to share physical pages via copy-on-write.

### 04. Response and ecosystem breadth

`vLLM` exposes an OpenAI-compatible HTTP server, distributes large checkpoints across multi-GPU nodes via tensor parallelism (`--tensor-parallel-size`) and pipeline parallelism, supports GPU-native quantizations (`FP8`, `AWQ`, `GPTQ`, `Marlin`), and ships day-zero support for almost every new Hugging Face transformer, MoE, and vision-language architecture.

```bash
# Serve a 32B model across two GPUs with tensor parallelism,
# chunked prefill, and block-level prefix caching enabled
vllm serve Qwen/Qwen2.5-32B-Instruct \
  --tensor-parallel-size 2 \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.92 \
  --enable-chunked-prefill \
  --enable-prefix-caching \
  --port 8000
```

**Best for:**

- High-traffic multi-tenant API serving
- Maximizing aggregate GPU throughput (tokens per second per GPU)
- Broadest model architecture and hardware accelerator support (NVIDIA, AMD ROCm, Intel, TPU)

## 3. SGLang: RadixAttention, cache-aware routing, and agent workflows

**[SGLang](https://github.com/sgl-project/sglang)** targets workloads where requests are not isolated one-shot completions. Modern AI applications run multi-turn conversations, ReAct and MCP tool loops, few-shot extraction, and retrieval-augmented generation (RAG).

### 01. Agents and multi-turn chats

Consider what happens when a coding or operations agent resolves one user ticket:

1. Turn 1 sends a 4,000-token system prompt + tool definitions + user request, and generates a 60-token tool call.
2. Turn 2 sends those 4,060 tokens + 1,500 tokens of tool output, and generates the next 80-token tool call.
3. By Turn 10, the agent has sent over 100,000 cumulative input tokens and generated fewer than 1,000 output tokens.

Across those ten calls, over 90% of every prompt was already processed on the previous turn. On a naive server, or on a multi-replica cluster where a load balancer scatters turns across workers, the GPU recomputes that shared prefix on every single turn.

### 02. Request routing: cache-aware router

When you scale past one GPU worker, prefix caching inside a single process is only half the fix. If Worker 1 holds the KV blocks for a user's 12,000-token conversation history and a round-robin load balancer sends Turn 6 to Worker 2, you suffer a cache miss and pay full prefill latency.

`SGLang` pairs its runtime with a **cache-aware router** (`sglang-router`). The router maintains a prefix tree of the token sequences currently cached on each worker and scores incoming requests by combining prefix match length with worker queue depth. Requests flow to the worker that already holds their prefix in HBM, avoiding both redundant prefill compute and cross-node KV memory copies. (I use the same KV-affinity routing principle in [Cognitora](https://www.fratepietro.com/2026/cognitora-inference-update-v0.9/) across mixed engine fleets, and Google built it into the [GKE Inference Gateway](https://www.fratepietro.com/2026/google-cloud-agentic-ai-architecture-private-inference-networking/).)

### 03. Memory and computation reuse: RadixAttention

While `vLLM` treats prefix caching as a hash table over fixed KV pages, `SGLang` organizes its entire KV memory manager around **[RadixAttention](https://arxiv.org/abs/2312.07104)**.

Instead of freeing KV memory or indexing only system prompts, `SGLang` retains the KV cache of both prompts *and* generated outputs inside a **radix tree** (a space-optimized prefix tree where each edge represents a sequence of tokens):

- **Automatic multi-turn and branch reuse.** When a request completes, its token path remains in the radix tree backed by paged KV memory. When the next turn of the chat arrives, `SGLang` walks the tree, matches the entire prior conversation (including the assistant's previous reply), and computes prefill only on the new user message or tool output.
- **Tree-structured agent fan-out.** If an agent spawns four parallel sub-tasks or tree-of-thought branches from the same state, all four branches attach as child nodes under the shared parent node in the radix tree, reading the parent's KV pages without duplication.
- **LRU eviction and cache-locality scheduling.** Unused leaf nodes stay in HBM until memory pressure triggers Least Recently Used (LRU) eviction. Furthermore, `SGLang`'s scheduler reorders waiting requests that share a hot prefix so they execute together before that prefix is evicted.

### 04. Response: structured outputs and jump-forward decoding

Agent loops depend on valid JSON schemas and typed tool calls. Traditional constrained decoding applies a vocabulary token mask at each generation step: even when the JSON schema forces the next twelve characters to be `{"status": "`, the model still runs multiple memory-bound decode forward passes to emit those boilerplate tokens one by one.

`SGLang` pairs its grammar backend (`xgrammar`) with **compressed finite-state machines (FSM)** and **jump-forward decoding**. When the schema's state machine allows only one deterministic sequence of tokens (such as fixed JSON keys, punctuation, or closing brackets), `SGLang` bypasses step-by-step decode, appends all forced tokens at once, and advances the KV state in a single prefill pass. You get guaranteed schema compliance with *lower* latency than unconstrained generation.

```bash
# Start two SGLang workers with RadixAttention enabled by default,
# fronted by SGLang's cache-aware router
python -m sglang.launch_server \
  --model-path Qwen/Qwen2.5-32B-Instruct \
  --tp 1 --port 30001 &

python -m sglang.launch_server \
  --model-path Qwen/Qwen2.5-32B-Instruct \
  --tp 1 --port 30002 &

python -m sglang_router.launch_router \
  --worker-urls http://127.0.0.1:30001 http://127.0.0.1:30002 \
  --policy cache_aware \
  --port 30000
```

**Best for:**

- AI agents, MCP tool loops, and tree-of-thought workflows
- Multi-turn chat and RAG pipelines with heavy prefix overlap
- High-speed structured JSON and schema-constrained outputs

## 4. How the three engines differ across the stack

Putting the four internal layers side by side clarifies why each tool behaves differently under load:

| Dimension | llama.cpp | vLLM | SGLang |
| :--- | :--- | :--- | :--- |
| **Primary target** | Single user, local CLI, edge, and workstation | High-concurrency multi-tenant API serving | Multi-turn agents, RAG, and shared-prefix workflows |
| **Model loading & weights** | Single-file `GGUF` via `mmap()`, block quantizations (`Q4_K`, `Q5_K`, `Q8_0`, `IQ4`) | Hugging Face `safetensors`, GPU weight loading (`BF16`, `FP8`, `AWQ`, `GPTQ`) | Hugging Face `safetensors`, GPU weight loading (`BF16`, `FP8`, `AWQ`, `GPTQ`) |
| **KV memory management** | Pre-allocated context buffer split into fixed slots (`-np`), optional `q8_0`/`q4_0` KV | `PagedAttention`: fixed-size physical KV blocks + per-request block tables | `RadixAttention`: radix prefix tree retaining prompts + completions with LRU eviction |
| **Request scheduling & routing** | Static slot assignment (`-np`), first-come queue | Iteration-level continuous batching + chunked prefill | Prefix-locality batch scheduling + cache-aware multi-worker router |
| **Inference & output layer** | Fused dequant-matvec kernels (`CPU`, `Metal`, `CUDA`, `Vulkan`) + GBNF token masking | Batched Tensor Core GEMMs + FlashAttention + guided decoding | FlashInfer / Triton kernels + compressed FSM jump-forward structured JSON |
| **Runtime footprint** | Single native C/C++ binary, zero Python dependencies | Python + PyTorch + CUDA / ROCm serving stack | Python + PyTorch + FlashInfer + Rust router (`sglang-router`) |

Notice how each layer reinforces the next:

- **Model loading sets your hardware floor.** `llama.cpp`'s `mmap` + `GGUF` block quantization lets you fit a model into consumer RAM or unified memory and start in under a second. `vLLM` and `SGLang` pay a longer startup cost (loading `safetensors` into GPU HBM, compiling CUDA graphs, profiling free KV blocks) in exchange for layouts optimized for batched GPU Tensor Core GEMMs.
- **Memory layout sets your concurrency ceiling.** A static context buffer (`llama.cpp`) is simple and predictable for 1 to 4 local streams, and wastes memory if you provision 64 slots for 32k context. `PagedAttention` (`vLLM`) turns slack KV capacity into active batch slots. `RadixAttention` (`SGLang`) turns past requests into a persistent in-memory cache tree so future turns skip prefill.
- **Scheduling sets your tail latency.** Continuous batching and chunked prefill (`vLLM` and `SGLang`) ensure a 20-token request never waits behind a 2,000-token generation or a 20,000-token prompt prefill. Cache-aware scheduling and routing (`SGLang`) ensure multi-turn sessions stay pinned to the GPU holding their state.

## 5. Comparing performance, resource usage, and serving cost

When you translate these mechanics into capacity planning and cloud bills, three rules hold up across workloads:

### 1. Low concurrency (1 to 4 concurrent users): optimize for memory bandwidth and zero idle cost

If you are running a local coding assistant, a desktop app, or an internal tool with sporadic traffic, a dedicated datacenter GPU running `vLLM` sits idle 95% of the day while billing by the hour. At batch size 1, token generation speed is governed strictly by memory bandwidth divided by model size:

```text
tokens/sec ≈ memory_bandwidth (GB/s) / model_weights (GB)
```

A 4-bit `GGUF` checkpoint on `llama.cpp` (or [Frink](https://github.com/antonellof/frink)) moves ~3.5x fewer bytes per token than a 16-bit checkpoint, fits on a Mac Studio or a single consumer GPU, and costs nothing when idle. (If you want to automate picking the right checkpoint, quantization, and context flags for your machine's exact RAM or VRAM, use [Rondine](https://github.com/antonellof/rondine).)

### 2. High-volume independent requests: optimize for batch density (`vLLM`)

Once your service handles 20 to 200 concurrent requests with little shared context (for example, summarizing distinct customer documents or handling independent API calls), single-stream latency matters less than **aggregate tokens per second per GPU**.

Here, `vLLM`'s `PagedAttention` and continuous batching dominate serving economics. Packing 64 concurrent sequences onto an H100 or L40S amortizes every weight read across 64 tokens, raising total GPU throughput by an order of magnitude over single-stream execution and cutting your cost per million output tokens proportionally.

### 3. Agent loops, multi-turn chat, and heavy structured JSON: optimize for prefill avoidance (`SGLang`)

In agentic systems, your bill and your user-perceived latency are dominated by **input tokens (TTFT)** and **schema formatting**, not unconstrained essay generation.

When an agent executes a 12-step tool loop over a 10,000-token context, `SGLang`'s `RadixAttention` and cache-aware router turn steps 2 through 12 from 10,000-token prefills into 200-token delta prefills. Combined with jump-forward FSM decoding on JSON tool arguments, a single GPU replica serves 3x to 5x more agent sessions within the same latency SLA than an engine that recomputes prefixes or decodes JSON boilerplate token by token.

*(And if your step only needs a calibrated probability or routing choice over a fixed set of outcomes rather than generated text, skip autoregressive decoding altogether and use a single-pass [decision model endpoint (`/v1/systemone`)](https://www.fratepietro.com/2026/how-to-build-a-decision-model-like-jev/).)*

---

*Related reading on this blog: [LLM Inference: a learning roadmap](https://www.fratepietro.com/2026/llm-inference-learning-roadmap/), [Frink Inference: the Rust alternative to llama.cpp](https://www.fratepietro.com/2026/frink-rust-alternative-to-llama-cpp/), [Rondine: Hardware-Aware Local LLM Serving](https://www.fratepietro.com/2026/rondine-hardware-aware-local-llm-launcher/), [Cognitora v0.9.1: gossip discovery, live KV prefix, and a native engine](https://www.fratepietro.com/2026/cognitora-inference-update-v0.9/), and [How to Build a Decision Model Like Jev](https://www.fratepietro.com/2026/how-to-build-a-decision-model-like-jev/).*

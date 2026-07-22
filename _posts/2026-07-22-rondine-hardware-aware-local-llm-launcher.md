---
layout: post
title: "Rondine: Hardware-Aware Local LLM Serving Without the Flag Archaeology"
date: 2026-07-22
categories: [AI Infrastructure]
tags: [Rondine, Local LLM, llama.cpp, MLX, vLLM, Apple Silicon, NVIDIA, DGX Spark, Coding Agents, OpenAI API]
excerpt: "Rondine detects the hardware you have, recommends open models that fit, applies tuned llama.cpp, MLX-LM, or vLLM settings, and exposes an OpenAI-compatible endpoint for local coding tools."
---

Running a local language model is easy right up until you want it to run *well*. Downloading weights is only the beginning. You still have to choose an inference engine, pick a quantization that fits, reserve enough memory for the KV cache, decide on a useful context length, and translate all of that into a collection of backend-specific flags.

Those choices change with every machine. A good setup for a 24 GB MacBook is not a good setup for a 256 GB Mac Studio. An RTX 4090 should not be configured like an H100, and a DGX Spark has its own Blackwell-specific path.

[**Rondine**](https://github.com/antonellof/rondine) is an open-source, hardware-aware control plane for this problem. It detects the machine, recommends models that fit, builds an optimized serving plan, downloads the selected weights, and starts an OpenAI-compatible local server.

It does not implement another inference engine. Rondine drives the mature engines that already exist:

- **MLX-LM** or **llama.cpp** on Apple Silicon
- **llama.cpp** or **vLLM** on discrete NVIDIA GPUs
- **vLLM** or **llama.cpp** on DGX Spark / GB10
- Native engine launchers for homogeneous multi-node experiments

The goal is simple: go from *"which model and which flags?"* to a repeatable local endpoint without hiding the decisions being made.

## The workflow

A complete setup is a short sequence of commands:

```bash
git clone https://github.com/antonellof/rondine.git
cd rondine
uv tool install .

rondine doctor
rondine suggest --profile coding
rondine suggest --configure 1 --save-as coding
rondine setup
rondine pull
rondine serve --preset coding
rondine verify --profile coding
```

`doctor` probes the host: operating system, architecture, RAM, GPU VRAM, CUDA capability, and installed engines. `suggest` combines that inventory with Rondine's model catalog and hardware profiles. The selected plan can be saved as a named preset, so restarting the same configuration later is one command:

```bash
rondine serve --preset coding
```

Every suggestion includes the resolved engine settings. Rondine is automation, not a black box: the model, quantization, context, batch sizes, memory settings, and launch command remain inspectable.

## Recommendations based on the hardware you actually have

Model selection starts with fit. On NVIDIA systems, Rondine sizes against **GPU VRAM**, not total system RAM. On Apple Silicon, it accounts for unified memory. It then ranks viable variants using the requested profile, provider preference, quantization quality, and available headroom.

The current catalog includes a practical range of coding models:

| Hardware class | Example recommendation |
| --- | --- |
| Apple Silicon, 24–48 GB | Qwen3.6 27B or Gemma 4 12B |
| Apple Silicon, 36 GB+ | Qwen3.6 35B-A3B |
| NVIDIA, 24 GB VRAM | Qwen3.6 35B-A3B or Qwen3.6 27B |
| Apple Silicon, 128 GB | DeepSeek-V4-Flash at 3-bit, opt-in |
| Apple Silicon, 256 GB | GLM-5.2 `UD-IQ2_M`, opt-in |
| DGX Spark / GB10 | NVFP4 models through vLLM where available |

These are starting points rather than universal declarations of the "best" model. A coding workload, an interactive chat session, and a long-context document task have different latency and memory requirements. Rondine makes that trade-off explicit through profiles and dry runs.

You can inspect a launch without downloading or starting anything:

```bash
rondine serve qwen3.6-27b --profile coding --dry-run
```

If the curated catalog does not contain what you need, Hub discovery is built into the workflow:

```bash
rondine search "Qwen3.6 35B GGUF"
rondine inspect org/model-repo
rondine plan org/model-repo --quant Q4_K_M --save-as custom-model
```

## GLM-5.2: an example where configuration matters

GLM-5.2 illustrates why a hardware-aware launcher is useful. It is a frontier-scale Mixture-of-Experts coding model: roughly 744B total parameters with about 40B active per token. The active parameter count helps compute efficiency, but the complete quantized weights still have to live somewhere.

Rondine's preferred single-machine variant is Unsloth's `UD-IQ2_M` GGUF:

- Approximately **239 GB** of model weights
- At least **245 GB** of usable unified memory recommended
- **llama.cpp** as the serving engine
- A practical **32K coding context** by default
- Thinking enabled with model-specific sampling
- Intended for a **256 GB Mac Studio-class machine**

There is also a smaller `UD-IQ1_S` option at roughly 223 GB, but the more aggressive quantization is a quality trade-off. Official BF16 weights belong on a large multi-GPU or multi-node system, not a single workstation.

Rondine marks GLM-5.2 as opt-in. A 48 GB Mac will not receive a recommendation merely because the model is fashionable, and a plan that does not fit is rejected rather than launched into an avoidable out-of-memory failure.

The same logic applies at smaller scales. On a 24 GB machine, choosing a model with enough headroom for context and cache is usually more useful than loading the largest possible file and leaving no memory for real work.

## Engine-specific tuning

The user-facing plan is consistent, but the settings under it are specific to each backend.

For **llama.cpp**, Rondine can configure:

- GPU layer offload
- Flash attention
- Batch and micro-batch sizes
- KV-cache quantization
- Parallel request slots
- Context length and sampling options

For **MLX-LM**, it selects MLX model variants and applies Apple Silicon-specific runtime settings, including Metal synchronization behavior.

For **vLLM**, it manages settings such as:

- GPU memory utilization
- Maximum model length
- Prefix caching
- Tensor parallelism when explicitly enabled
- Blackwell / DGX Spark-oriented model formats such as NVFP4

Configuration is resolved from layered templates: engine defaults, the requested usage profile, and the detected hardware class. This keeps the policy understandable while avoiding a separate hand-written command for every model and machine combination.

## A local OpenAI-compatible endpoint

Once `rondine serve` starts the backend, clients connect through the familiar OpenAI API format:

```text
http://127.0.0.1:8080/v1
```

That makes the server usable from existing applications and coding clients without introducing a Rondine-specific protocol. A basic request looks like this:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "rondine/qwen3.6-35b-a3b",
    "messages": [
      {"role": "user", "content": "Review this Python function for race conditions."}
    ]
  }'
```

You can point Cursor, Continue, Aider, Codex CLI, Claude Code with a custom base URL, or another OpenAI-compatible tool at the same endpoint. Rondine owns the model-serving lifecycle; the coding client remains replaceable.

Binding to `127.0.0.1` also keeps the default exposure local. If you deliberately make an inference server reachable over a LAN, treat it as a network service: use a trusted network, authentication or a reverse proxy, and an appropriate firewall policy.

## A coding profile, not a coding-agent lock-in

Rondine's `coding` profile is scoped to inference. It applies a practical context length and model-specific sampling, enables reasoning where supported, and tunes the engine for sustained code-oriented requests.

The profile currently includes model-aware behavior such as:

- Qwen3.6 thinking mode and coding sampling defaults
- GLM-5.2 maximum reasoning effort
- DeepSeek-V4-Flash high reasoning effort
- Engine-level batching, cache, and memory settings appropriate to the host

After launch, `rondine verify --profile coding` checks server health and runs coding-oriented smoke tests. This catches the frustrating class of failure where a process is listening on a port but the loaded model, chat template, or generation path is not actually usable.

Rondine deliberately does **not** ship a proprietary agent loop. Repository access, tool execution, approvals, edits, and planning belong to the coding client. The server remains a standard local model endpoint rather than coupling inference to one editor or one agent framework.

## Presets make experiments repeatable

Local inference experiments often end with an excellent command buried in shell history. Rondine presets preserve the complete plan:

```bash
rondine preset list
rondine preset show coding
rondine preset serve coding
```

That matters when comparing models. A coding preset can favor reasoning and a larger context, while a chat preset can use a smaller context and disable thinking for lower latency. Both remain named, inspectable, and reproducible.

It also makes the setup easier to explain to another developer. Instead of sharing a multi-line backend command with hardware assumptions embedded in it, you can share the model plan and let Rondine resolve the appropriate engine configuration on the target machine.

## What Rondine is—and is not

Rondine is intentionally a thin layer:

1. Detect the host.
2. Match it to a hardware profile.
3. Rank compatible model variants.
4. Resolve engine-specific settings.
5. Download, serve, save, and verify the plan.

It is not a replacement for llama.cpp, MLX-LM, or vLLM. It is not a model manager that pretends every backend has identical capabilities. It is not a distributed inference orchestrator for a heterogeneous datacenter, and it is not another coding agent.

That limited scope is the design. Local inference already has excellent engines and clients. The missing layer is often the small, boring, hardware-specific control plane between them.

## Try it

Rondine requires Python 3.11+ and is released under Apache-2.0:

```bash
git clone https://github.com/antonellof/rondine.git
cd rondine
uv tool install .
rondine doctor
rondine suggest --profile coding
```

The repository includes the model catalog, hardware templates, coding-client documentation, and engine-tuning notes:

- [Rondine on GitHub](https://github.com/antonellof/rondine)
- [Coding client guide](https://github.com/antonellof/rondine/blob/main/docs/coding.md)
- [Engine tuning](https://github.com/antonellof/rondine/blob/main/docs/engine-tuning.md)

I am particularly interested in feedback from people running unusual configurations: high-memory Macs, 24–80 GB NVIDIA workstations, DGX Spark, and homogeneous two-node setups. Model catalogs age quickly; transparent hardware profiles and reproducible serving plans are the parts intended to last.


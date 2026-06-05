---
layout: post
title: "DwarfStar 4: antirez Bets the Farm on Local Inference Done Right"
date: 2026-06-05
categories: [Deep Dive]
tags: [DwarfStar, DS4, Local Inference, DeepSeek, antirez, Metal, LLM, MoE, Distributed Inference]
excerpt: "Salvatore Sanfilippo — the mind behind Redis — shipped DwarfStar 4, a purpose-built inference engine for DeepSeek V4 on Apple Silicon. Not another GGUF wrapper: a finished local-AI stack with asymmetric quants, disk-backed KV cache, a native coding agent, and distributed inference across MacBooks. Here's why 13k GitHub stars showed up in a week."
---

Salvatore Sanfilippo — [antirez](https://antirez.com), the person who gave us Redis — has a habit of building things that look obvious in retrospect and impossible before they exist. His latest project, [**DwarfStar 4**](https://github.com/antirez/ds4) (DS4), is no exception: a small, native inference engine laser-focused on running **DeepSeek V4 Flash** (and PRO on monster machines) locally, end to end, without duct tape.

I did not expect it to hit **13,000+ GitHub stars** in roughly a week either. But after reading [antirez's own words on the launch](https://antirez.com/news/165) and his follow-up on [distributed inference](https://antirez.com/news/167), the hype makes sense. Three things converged at once: a quasi-frontier open-weights model fast enough to matter on a laptop, an asymmetric 2/8-bit quantization recipe that actually works, and a decade of local-AI experimentation finally paying off — accelerated, as antirez openly admits, by heavy use of GPT 5.5 during development.

This is not a generic GGUF runner. It is a deliberate bet that **local inference should feel finished**, not merely possible.

## The problem DS4 refuses to solve

The local LLM landscape is a graveyard of half-integrated projects. A new model drops. Someone ports it to [llama.cpp](https://github.com/ggml-org/llama.cpp). Tool calling breaks. Context windows shrink mysteriously. KV cache eats all your RAM. You wire up Ollama, then Open WebUI, then a coding agent, then wonder why the 284B-parameter MoE feels dumber than the 27B dense model you replaced.

DS4 takes the opposite approach, stated plainly in the [README](https://github.com/antirez/ds4):

> *Not a generic GGUF runner, not a wrapper around another runtime — completely self-contained.*

The vision is three pieces working together out of the box:

1. **Inference engine** with HTTP API and CLI
2. **GGUF files crafted for that engine** — validated against official logits, not "close enough"
3. **Testing and agent integration** so you know it works before you trust it with your codebase

The model may change over time — antirez expects future DeepSeek checkpoints, maybe `ds4-coding`, `ds4-legal`, `ds4-medical` variants — but the constraint stays: **one best open-weights model at a time, practically fast on high-end personal hardware**.

That narrowness is the feature. Redis did not try to be a general-purpose database. DS4 does not try to be a general-purpose inference server.

## Why DeepSeek V4 Flash, specifically?

After weeks of comparisons, the DS4 team argues Flash deserves its own engine for reasons that matter in daily use, not just on benchmarks:

- **Thinking mode that scales with problem complexity.** Enable thinking on many models and watch them monologue for 8,000 tokens about a two-line bug. Flash's thinking section is often ~1/5 the length of competitors and proportional to actual difficulty — making thinking mode usable locally where it was previously a curiosity.
- **A 1-million-token context window** with aggressively compressed KV cache — and DS4 treats that cache as a **first-class disk citizen**, not something that must live in RAM until your MacBook fans sound like a jet engine.
- **Edge-of-knowledge sampling.** Ask niche political or cultural questions and 284B routed MoE parameters show up. Dense 27B–35B models feel smaller in ways that are hard to benchmark but obvious in conversation.
- **Asymmetric 2-bit quantization that is not a joke.** Only routed MoE experts get crushed to 2-bit (`IQ2_XXS` up/gate, `Q2_K` down). Shared experts, projections, routing, and attention stay at higher precision. Result: Flash runs on **96–128 GB** MacBooks; PRO fits on **512 GB** Mac Studio class machines.

antirez's blunt assessment in [news/165](https://antirez.com/news/165): if you imagine local models as experience **A** and frontier cloud models as **B**, DS4 is **a lot more B than A**. For the first time in his years of local inference experiments, he uses it for work he'd normally send to Claude or GPT.

I have been running similar experiments on my own hardware. The gap between "toy local model" and "I would actually ship code reviewed by this" has never been smaller.

## What's in the box

DS4 ships as a handful of native binaries — no Python runtime holding the critical path hostage:

| Binary | Role |
|--------|------|
| `./ds4` | Interactive CLI — chat, `/read`, session management |
| `./ds4-server` | OpenAI-compatible HTTP API for external agents |
| `./ds4-agent` | Native coding agent with on-disk KV sessions |
| `./ds4-bench` | Throughput measurement at context frontiers |
| `./ds4-eval` | 92-item integration regression suite with TUI |

**Backends:** Metal is the primary target (MacBook Pro/Studio). CUDA builds target the [NVIDIA DGX Spark](https://www.nvidia.com/en-us/data-center/dgx-spark/) and generic Linux GPUs. AMD ROCm lives on a separate community-maintained branch — antirez does not have the hardware to gatekeep it on main.

The engine borrows quant layouts, GGUF ecosystem knowledge, and kernel ideas from llama.cpp/GGML (acknowledged prominently in the LICENSE), but `ds4.c` is its own inference path — not a fork you `./llama-cli` your way through.

### Getting started

Download the imatrix-tuned quant that matches your RAM, build, run:

```bash
git clone https://github.com/antirez/ds4.git
cd ds4

# 96/128 GB machines — imatrix-tuned 2-bit (recommended starting point)
./download_model.sh q2-imatrix

# macOS Metal build
make

# Interactive session
./ds4 -m ds4flash.gguf --ctx 32768

# OpenAI-compatible server for Cursor, Cline, etc.
./ds4-server --ctx 100000 --kv-disk-dir /tmp/ds4-kv --kv-disk-space-mb 8192
```

Weights live on [Hugging Face (`antirez/deepseek-v4-gguf`)](https://huggingface.co/antirez/deepseek-v4-gguf). The download script resumes partial transfers and symlinks `./ds4flash.gguf` to your chosen variant. Do not feed it arbitrary GGUF files — tensor layout, quant mix, and optional MTP state are all DS4-specific.

**Status:** beta. antirez worked ~14 hours/day the first week (reminiscent of early Redis, he notes). The `ds4-agent` is explicitly alpha. Use `--trace` and file issues with full session logs when something breaks.

## Speed: the numbers that matter locally

Published [Metal benchmarks](https://github.com/antirez/ds4#speed) (greedy decode, `--nothink`, 32K context) tell a clear hardware story:

| Machine | Quant | Prefill (long prompt) | Generation |
|---------|-------|----------------------|------------|
| MacBook Pro **M5 Max**, 128 GB | q2 | **463 t/s** | **~35 t/s** |
| MacBook Pro M3 Max, 128 GB | q2 | 250 t/s | ~27 t/s |
| Mac Studio M3 Ultra, 512 GB | q2 | 468 t/s | ~36 t/s |
| Mac Studio M3 Ultra, 512 GB | **PRO** q2 | 139 t/s | ~10 t/s |
| DGX Spark GB10, 128 GB | q2 | 344 t/s | ~14 t/s |

The M5 Max numbers align with antirez's [hardware take](https://antirez.com/news/167): right now, the best local-inference **deal** might literally be a laptop — ~500 t/s prefill and ~35–40 t/s decode on 2-bit Flash for $6–7K. A Mac Studio M3 Ultra with 512 GB runs **PRO** at usable (if not thrilling) ~10–13 t/s decode and ~150 t/s prefill — frontier-class weights at home for ~$12K total spend.

Not cloud-fast. But no API bill, no data leaving your machine, and no "sorry, we're rate-limiting Pro users again" email.

For thermal sanity on long runs, `--power N` throttles GPU duty cycle (50 = half speed, less fan scream). Available on CLI, server, agent, and bench tools.

## Disk-backed KV cache: RAM is not the only tier

Most inference stacks assume KV lives in memory or dies. DS4's design thesis — spelled out in the README — is that **modern NVMe is fast enough to change the equation**, especially with DeepSeek's compressed cache format.

Practical effect:

```bash
./ds4-server \
  --ctx 100000 \
  --kv-disk-dir /tmp/ds4-kv \
  --kv-disk-space-mb 8192
```

You can run contexts that would evict you from RAM on lesser setups. The native agent stores sessions under `~/.ds4/kvcache` with `/save`, `/list`, `/switch` — resuming a saved session skips prefill entirely because the KV state *is* the session.

This is the kind of architectural choice that sounds incremental and feels revolutionary the first time you `/switch` back to a 200K-token debugging session instantly.

## The native coding agent

Most coding agents treat inference as a black-box HTTP call. DS4's agent inverts that: **inference is controlled from inside the agent**, no socket boundary on the hot path, tools and system prompt designed vertically for DeepSeek V4.

What that buys you:

- **Instant tool calling** — no DSML conversion layer; native model format end to end
- **KV truth** — session state cannot drift from cache state; they are the same object
- **Live prefill progress bar** — sounds cosmetic, matters when you're waiting on 100K tokens of repo context
- **Session switching without re-prefill** — `/switch` to another saved conversation and keep going

antirez plans to eventually split client/server with a stateful protocol once the agent matures. Today it is alpha — usable, opinionated, not yet "install and forget."

Pair it with **directional steering** ([`dir-steering/`](https://github.com/antirez/ds4/tree/main/dir-steering)) and you get something antirez highlights in [news/165](https://antirez.com/news/165): the first local setup where vector steering makes the model feel *less* constrained, not more gimmicky.

## Distributed inference: when one MacBook is not enough

The [distributed inference docs](https://github.com/antirez/ds4#distributed-inference) are where DS4 stops being a laptop toy and starts looking like infrastructure. antirez's [news/167](https://antirez.com/news/167) frames the macro picture: NVIDIA clusters are not getting cheaper, RAM shortages may delay the next Mac Studio Ultra, and tensor parallelism over Thunderbolt is a non-starter (go read NVLink speeds and weep).

DS4 implements **pipeline parallelism** today — split layers across machines, ship activations (small), keep KV shards local:

```bash
# Machine A — coordinator, layers 0–30
./ds4 \
  -m gguf/DeepSeek-V4-Pro-Q4K-Layers00-30.gguf \
  --role coordinator \
  --layers 0:30 \
  --listen 169.254.43.68 1234

# Machine B — worker, layers 31 through output head
./ds4 \
  -m gguf/DeepSeek-V4-Pro-Q4K-Layers-31-output.gguf \
  --role worker \
  --layers 31:output \
  --coordinator 169.254.43.68 1234
```

**Prefill** pipelines across the cluster like an assembly line — measured **1.38×–1.85×** speedup on two M5 Max MacBooks over Thunderbolt 5 for long prompts. **Decode** cannot pipeline (autoregression is sequential); expect ~15–20% *slowdown* vs single machine due to per-token network hops. Distributed inference is for **fitting bigger models** and **faster long prefills**, not faster token generation.

Real-world link comparison from the README (same two hosts, 8K prompt):

| Link | Ping | Prefill | Generation |
|------|------|---------|------------|
| Thunderbolt 5 | 0.45 ms | 583 t/s | 25 t/s |
| WiFi | 77 ms | 251 t/s | 11 t/s |
| Internet VPN | 152 ms | 115 t/s | 4 t/s |

WiFi works. It is not fun. VPN across continents is for "I need to run the model at all," not daily driving.

### What comes next: three paths, not one

antirez outlines three distributed strategies in [news/167](https://antirez.com/news/167):

1. **Pipeline / layer split** (shipped) — duplicate effective memory, accelerate prefill, accept slower decode.
2. **Expert-parallel vertical split** (experimental) — both machines load full 2-bit weights; route half the MoE experts to each box via Apple RDMA; viable for PRO's larger routed experts where activation traffic stays tiny.
3. **Model ensemble** (research) — completely shared-nothing: run *different* models on different machines, combine logits or pick the lower-perplexity continuation. [Recent work](https://arxiv.org/abs/2502.18036) shows ensembles can outperform either model alone — like an implicit two-expert MoE where routing is "who is more confident about the next token."

Tensor parallelism? antirez bets **no** on Apple Thunderbolt vs NVLink. The winning patterns all minimize bytes on the wire.

Two Mac Studio 512 GB machines could run full-size **PRO Q4** today with the split GGUF workflow — antirez demoed ~11.5 t/s generation with balanced ~40 ms local / ~47 ms remote layer times. Frontier weights, no datacenter lease.

## Honest caveats (because antirez is honest)

A few things the README says out loud that most launch posts bury:

- **AI-assisted development.** Built with heavy GPT 5.5 help. If that offends you, DS4 is not your project. The ideas, testing, and debugging are human-led; the typing is not all hand-crafted C.
- **CPU path is for diagnostics only.** On macOS, running CPU inference can **kernel-panic** the machine due to a virtual memory bug. antirez's comment: *"Software sucks."* Metal or CUDA for real work.
- **PRO support is experimental** — naturally limited to 512 GB hardware unicorns.
- **Distributed protocol has no encryption or auth** — trusted network, same git commit on all nodes.
- **MTP speculative decoding** exists but is correctness-gated and currently a slight speedup at best.

This transparency is refreshing. Beta software that admits beta beats production software pretending it is done.

## How DS4 fits the wider local-AI stack

If you are running **datacenter-scale** orchestration — KV-aware routing across dozens of H100s, prefill/decode disaggregation, etcd cluster state — projects like [Cognitora](https://github.com/antonellof/cognitora-inference) (which I have written about separately) occupy that lane.

DS4 occupies a different lane entirely: **personal sovereignty**. One developer, one (or two) Apple Silicon boxes, one model family, everything from GGUF validation to coding agent in a single repo. The philosophical overlap with early Redis is striking — optimize one workload brutally well, ship the complete experience, ignore the rest.

| Dimension | Generic llama.cpp + Ollama | DwarfStar 4 |
|-----------|---------------------------|-------------|
| Model scope | Anything with a GGUF | DeepSeek V4 Flash/PRO only |
| Quant strategy | Bring your own | Asymmetric imatrix 2/8-bit, official-logit validated |
| KV cache | RAM-first | RAM + disk tier, session-native agent |
| Agent | External (Cursor, etc.) | Native `ds4-agent` + OpenAI-compatible server |
| Distribution | None built-in | Pipeline parallelism across Macs |
| Maturity | Production ecosystem | Beta, weeks old, moving fast |

Neither replaces the other. DS4 is the integrated appliance. The generic stack is the swiss army knife.

## What antirez is building toward

From [news/165](https://antirez.com/news/165), the roadmap reads like a product plan, not a science project:

- Quality benchmarks and regression gates (official continuation vectors, `ds4-eval`, `ds4-bench`)
- A coding agent that graduates from alpha to daily-driver
- Home hardware CI so releases do not depend on "works on Salvatore's MacBook"
- More ports and distributed modes — serial **and** parallel
- Model churn as DeepSeek ships new checkpoints

The closing line stuck with me: *"AI is too critical to be just a provided service."*

That is the whole argument for DS4 in one sentence. Cloud APIs are convenient. They are also someone else's computer, someone else's retention policy, and someone else's idea of what your prompt should cost this quarter.

## Bottom line

DwarfStar 4 is not the inference engine for everyone. It is the inference engine for people who looked at DeepSeek V4 Flash, checked their MacBook's RAM, and thought: *I want this to actually work — tools, cache, agent, benchmarks, distributed PRO across two Studios — without spending six weekends gluing pieces together.*

antirez built Redis because developers deserved a better in-memory data store. DS4 comes from the same instinct applied to local LLMs: stop shipping half-finished runtimes and call it progress.

Clone it. Download the imatrix quant. Run `./ds4`. See if you, too, end up asking a local model what you used to send to Claude — and getting an answer you can use.

---

*DwarfStar 4 is under active development. Pin a commit or watch [releases](https://github.com/antirez/ds4) if you are deploying beyond weekend experiments. Primary references: [antirez/ds4 on GitHub](https://github.com/antirez/ds4), [A few words on DS4](https://antirez.com/news/165), [Distributing LLM inference in DwarfStar](https://antirez.com/news/167).*

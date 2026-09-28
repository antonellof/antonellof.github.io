---
layout: post
title: "Frink Inference: the Rust alternative to llama.cpp"
date: 2026-09-28
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, llama.cpp, GGUF, Metal, CUDA, MoE, OpenAI API]
image: /assets/images/frink/frink-social.png
excerpt: "What changed in Frink from v0.24 to v0.49: 100 architectures checked against libllama's own logits, a serving stack with vLLM's sampling surface, and a list of where llama.cpp is still ahead."
---

<img src="/assets/images/frink/frink-logo.webp" alt="Frink Inference: pure-Rust GGUF inference engine" width="380" />

The project I have been writing about since August as **Ferrox** is now **[Frink](https://github.com/antonellof/frink)**. Same code, same history, new name, and a new logo: the mad scientist holding a GGUF chip in one hand and a flask in the other, with an MoE router on the screen behind him. It is a fair picture of the project. Half of it is careful measurement, the other half is enthusiasm.

This post covers the rename, what changed in the twenty-five releases since the [Bonsai post](/2026/frink-bonsai-ternary-27b-local/), the goal the project is now organised around, and where Frink already beats llama.cpp. The [first post](/2026/frink-rust-gguf-inference-engine/) covers the design and the [second](/2026/frink-metal-parity-llama-cpp/) the Metal backend. Old `/ferrox-*` links redirect.

## The rename

The rename landed in v0.26.0. It touched 722 files and about 11,000 occurrences. Every crate is `frink-*` now, the binaries are `frink` and `frink-server`, the environment variables are `FRINK_*`, and the repository is `antonellof/frink`. Directories and fixtures moved with `git mv`, so `git log --follow` still works through the change.

A few things deliberately stayed or changed in ways a rename normally would not:

- **The `ferrox-*` crates stay on crates.io at 0.25.0.** The `frink-*` crates start at the same version instead of pretending to continue them. The name `frink` on crates.io belongs to an unrelated project, so the facade crate is **`frink-inference`**.
- **Some test architecture strings still say `ferroxtest`.** They are values inside committed binary GGUF fixtures. GGUF strings are length-prefixed, so renaming them means regenerating the fixtures and their goldens. It is data, not branding.
- **The KV-block hash domain changed on purpose.** It went from `ferrox-kv-block-v1` to `frink-kv-block-v1`, so KV blocks written by an older build can no longer be found, rather than being read back under a name that no longer describes them.

The new mark is in the README. Studio, the web UI, keeps its own monochrome SVG logo, because a full-colour raster wordmark cannot also serve as a 16px favicon in both themes. In the terminal there is a small ASCII `frink` wordmark. The first version used half-block characters to match llama.cpp's banner, and at terminal aspect ratio it read as `FFIUHK`. Now it is thin box-drawing in its own style, the one place where looking like llama.cpp would be the wrong goal.

## The goal, stated once

The project now has a written north star, and every other plan is ranked against it:

> Frink should be what somebody reaches for **instead of** llama.cpp. Same models, same command shapes, same or better performance, on the hardware people actually own.

That is a bigger claim than "a fast Rust inference engine", so it comes with a bar you can check. For any GGUF you can run under llama.cpp:

1. It **loads**, or refuses with a sentence naming exactly what is missing. It never loads and then computes something else.
2. It produces the **same tokens** at temperature 0, checked against **llama.cpp's own logits**, not against a golden file this project wrote.
3. It is **not slower** on the same host, file and backend.
4. The **command you already know** works, or the difference is documented.

The first point is where Frink differs from llama.cpp on purpose, and I think it is the most important one. llama.cpp will often run something approximately right. Frink refuses instead. A refusal is a gap you can see, while a model that loads and quietly computes the wrong thing is a bug you only find after trusting it.

The route there is **recent, big models on consumer hardware**: MoE checkpoints, including ones too large for the machine's memory, because that is where llama.cpp is weakest and where a new engine can win on merit rather than on being written in Rust.

## What changed: v0.24 to v0.49

It has been a dense month: twenty-five releases, grouped here by theme.

### Architecture coverage: 100 models with evidence

The main number is **100 architectures running on the generic path, each with evidence**, plus four dedicated engines (MLA/DeepSeek, GLM, Kimi, Gemma 4). "Evidence" has a specific meaning here: a tiny synthetic GGUF of that architecture is run through **libllama** to produce reference logits, and Frink has to match them, typically to a KL divergence around 1e-13. An architecture without that evidence does not run on a guess. It refuses, and the refusal says which line of which llama.cpp graph it still needs.

Some of what closed this month:

- **The Mamba and state-space families**: Mamba-1 and Mamba-2, Jamba, Granite 4.0 hybrids (H-Micro / H-Tiny / H-Small), Nemotron-H including the 30B-A3B MoE, Falcon-H1, and PLaMo-2 with its own tokenizer.
- **Gated delta-net hybrids**: Qwen3.5 dense and MoE, and Qwen3-Next-80B-A3B.
- **LFM2 and LFM2-MoE**, with their short convolutions running on the ordinary layer rather than on a separate engine.
- **Llama 4 Scout and Maverick**, with chunked attention, the attention temperature on the no-RoPE layers, and the expert weight applied to the *input* of the expert. Llama 4 is the only graph that does that last one, and on the test fixture it moves the logits by 0.86.
- **MiniMax-Text-01** (456B-A45B) with lightning attention, **Spark-2.5**, **Maple-20B**, **Granite 4.1**, **DFM Mimir** and **muse-glimmer**: six of the eight architectures that arrived when I moved the llama.cpp reference pin forward 792 commits.
- **DeepSeek-V2/V3 attention**, finally with a libllama golden, in both the legacy and the current tensor layout, and with YaRN read the way llama.cpp reads it across three separate files.
- **The 2023 tail**: GPT-2, StarCoder, BLOOM, MPT, Falcon, GPT-NeoX/Pythia, Phi-2, Command-R, Cohere2, Arctic, Grok, DBRX and many more.
- **Embeddings, reranking and scoring**: nomic-bert, `llama-embed`, and a new `/v1/score` endpoint.

The refusal count briefly went *up* when I moved the pin, from 2 to 10. That is what keeping pace with a moving target looks like. A count that only ever fell would mean nobody was reading upstream.

### A serving stack with the full sampling surface

Most of the version numbers went to the server. Frink now accepts the whole OpenAI and vLLM sampling surface instead of a subset:

- `n` and `best_of` from **one shared prefill**, using copy-on-write on the paged KV store, and interleaved when streaming.
- `logprobs`, `prompt_logprobs`, `logit_bias`, `allowed_token_ids`, `bad_words`, `echo`, `truncate_prompt_tokens`, `skip_special_tokens: false`, `return_tokens_as_token_ids`.
- `cache_salt`, so each caller gets isolated prefix-cache pages. Identical prompt text under a different salt reuses nothing.
- **Sleep mode**: `POST /sleep`, `POST /wake_up`, `GET /is_sleeping`.
- **Speculative decoding in the server**, lossless at any temperature.
- **Cache-aware admission**: a queued request whose system prompt is already cached can be admitted first, with hard bounds so a large request cannot be starved.

One fix mattered more than any single feature. v0.30.0 found **eleven request fields that changed the answer but were being accepted and ignored**. Now any field the server does not implement is **refused by name**, because a dropped field looks exactly like one that was honoured.

Measured on an M2 Pro with Llama-3.2-1B, one build against itself: continuous batching takes aggregate throughput from **37.8 tok/s at one client to 67.0 at sixteen**, and a shared 757-token system prompt reuses **736 tokens** from the prefix cache, cutting time to first answer from 938 ms to 410 ms.

### The engine

- **4-bit KV cache with a Hadamard rotation** (`--ctk q4_0`). K is rotated when written and Q goes through the same rotation when read, so `q·k` is unchanged. Against an f16 cache, next-token agreement over sixty long-context windows went from 45/60 to 52/60. The more useful finding came by accident: two builds that differed only in an arbitrary sign pattern scored 48 and 52, so a four-window difference is the *noise of the metric*. A KV comparison is only worth believing when the difference is wider than that.
- **Bonsai 27B got faster, and its decode speed no longer drops with context length**: 11.17 / 11.19 / 11.16 tok/s at 32 / 300 / 600 tokens of context on an M2 Pro, against the reference's 11.46. The per-token command-buffer waits went from 192 to 69 to 20. A four-layer group on a hybrid model is now one GPU submission.
- **`--ctk` takes llama.cpp's value names** and refuses the ones it does not implement.
- **The CLI and server logs follow llama.cpp's format**: the same launcher, the same colours on the prompt echo and the timing line, and startup lines in the same timestamped, levelled format, so the output you are used to reading reads the same way.

## Where Frink is already better than llama.cpp

I want to be precise here, because "better" is easy to say and hard to check.

**It refuses instead of guessing.** This is the design difference everything else rests on. When an architecture, a GGUF key or a request field is not implemented, Frink stops and names it. Along the way, the libllama comparisons turned up several places where llama.cpp itself runs something wrong or does not run at all:

- libllama runs every current **PLaMo-2** export **without RoPE**, because it takes the rotary dimension from layer 0, which is a state-space layer. On the one public PLaMo-2 GGUF, libllama returns all-NaN logits. Frink answers "Paris. Paris is the capital of France."
- libllama **segfaults** on a Granite-4.0 hybrid file that omits an optional convolution bias, because it adds that bias unconditionally. Frink treats it as required.
- No interleaved **ERNIE-4.5 MoE** checkpoint can load in llama.cpp: the tensor loader and the graph disagree about the interleave step. Frink refuses the case by name.
- A **DeciLM** layer with attention but no FFN has its attention output silently discarded by llama.cpp. Frink refuses rather than copy that behaviour.

**It runs models mainline llama.cpp does not.** PrismML's **Ternary-Bonsai-2-27B** (`PTQ1_0`, 1.75 bits per weight, 5.95 GB) needs PrismML's fork of llama.cpp. Frink runs it as released, matched against that fork to a first-token KL of 2e-5.

**It decodes faster on Apple Silicon.** On the M2 Pro, Frink decodes faster than llama.cpp on **every one of the 15 comparable Metal rows**, from 4% ahead on OLMoE to 1.67x on the smallest models: Qwen3-0.6B at 191 tok/s against 116, SmolLM2-135M at 363 against 217, Gemma-3-1B at 122 against 83. Llama-3.1-8B is 32.0 against 30.4. Prefill is within 9% of llama.cpp on every row, level on most. (Those rows were measured on v0.20; the ledger marks them as such.)

**Its server does more.** llama-server is a good server. Frink's has the vLLM-style surface on top of it: `n`/`best_of` from one prefill, prompt log-probabilities, per-caller cache isolation, sleep/wake, runtime model swap, resumable streams, slot save/restore that refuses a mismatched checkpoint, and Anthropic Messages plus the Responses API on the same port. Structured output is enforced per token, whether from a GBNF grammar, a forced `tool_choice`, or a tool's own JSON schema, so an invalid answer cannot be generated at all. Tool calls are parsed in the eleven formats real checkpoints emit.

**It is one Rust binary.** 23 MB on macOS arm64, with the server, `download`, `bench`, `quantize`, `imatrix`, `gguf-split` and `verify` all included. No Python, no CUDA userspace to match against your driver. The engine is published as ordinary crates too: `frink-inference` as a facade, or `frink-gguf`, `frink-quant`, `frink-core` and `frink-models` individually if you want to embed it.

**It checks itself against llama.cpp.** `frink parity` runs both engines on the same token ids and compares the full logit distribution. `frink bench --compare` runs `llama-bench` beside it on the same file. Every benchmark row now records which build measured it, and the tables mark outdated rows instead of mixing them in. The tools that would catch Frink being wrong are part of Frink.

**And where it matches, it matches exactly.** `frink quantize` writes Q8_0 and the K-quants **byte-identically** to `llama-quantize`, with or without an importance matrix. Tokenization is checked against libllama on twenty checkpoints. The flags are llama.cpp's flags: `-m`, `-p`, `-n`, `-ngl`, `-c`, `-hf`, `--jinja`, `--alias`, `--api-key`.

## Where llama.cpp is still ahead

A post comparing itself to llama.cpp without this section would not be worth reading.

- **CUDA is far behind.** On an RTX 3090, Frink's prefill is 25x to 43x slower and decode 2.7x to 9x slower, from rows measured on v0.21. Newer work (a resident prefill and a tensor-core GEMM) has not been re-measured on that box yet. Today CUDA is correct but not fast.
- **CPU is behind.** On a Ryzen 9 3900X, decode is 1.04x to 1.34x slower and prefill up to 4.45x. The gap is largest on the smallest models, which points at fixed per-matmul overhead rather than slow kernels.
- **No Vulkan.** That means no AMD or Intel GPUs, which llama.cpp covers with one backend. This is the largest hardware gap.
- **Coverage is not complete.** llama.cpp has 155 hand-written graphs. Frink runs 100 architectures with evidence plus four on dedicated engines, and the rest refuse with a reason.
- **K-quant logits drift slightly** because llama.cpp quantizes activations to `Q8_K` before the dot product and Frink keeps them in f32. That is a documented difference, not a bug, and on `Q8_0` and `IQ4_NL` the logits match.

Those are the next priorities, in roughly that order, along with the item that would do most to justify choosing Frink: **running an MoE larger than the machine's memory** by keeping the experts that actually fire resident and streaming the rest. The residency policy is written. Wiring it into the engine is next.

## Try it

```bash
curl -fsSL https://raw.githubusercontent.com/antonellof/frink/main/scripts/install.sh | bash

# Fetch and serve in one step, llama-server style
frink serve -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 8192 --alias local

# Or check it against llama.cpp on your own machine
frink bench -m model.gguf -p 512 -n 128 -r 3 --compare
```

That installs `frink` and `frink-server` into `~/.local/bin`. The prebuilt binaries are macOS arm64 with Metal and Linux x86_64 for CPU. `cargo install frink-cli --features metal` (or `--features cuda`) builds the same thing from source.

If you run a model that Frink refuses, the error message is the bug report. Open an issue with it and the GGUF's architecture string: that is usually everything needed to add the model.

*None of this would exist without [llama.cpp](https://github.com/ggml-org/llama.cpp) and GGML. Frink does not link against them, but their kernels, formats and years of openly shared engineering were the reference for every line of it.*

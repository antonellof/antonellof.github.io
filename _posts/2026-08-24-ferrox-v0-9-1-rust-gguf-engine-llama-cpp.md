---
layout: post
title: "Ferrox v0.9.1: a Rust GGUF engine, measured against llama.cpp"
date: 2026-08-24
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Performance, Metal, MoE]
excerpt: "Ferrox runs GGUF models on CPU, Apple Metal, or CUDA in pure Rust. MoE prefill 2.4x faster on Metal, correct rotary embeddings for 24 more architectures, a standalone web UI, and twelve crates on crates.io."
---

[Ferrox](https://github.com/antonellof/ferrox) is a pure-Rust inference engine for GGUF models. Dense and mixture-of-experts, on CPU, Apple Metal, or CUDA. No bindings to llama.cpp, no wrapper around ggml. You get a CLI with llama.cpp-style flags and an OpenAI-compatible HTTP server you point your existing tools at.

I wrote it for one reason. I want mixture-of-experts models running on machines too small to hold them in VRAM, with expert-level residency rather than layer offload: watch which experts fire, keep those resident, evict the rest. Doing that well means designing the router, the KV cache, and the memory manager together. Every speed claim gets pinned against llama.cpp on the same machine, same file, same backend.

The [first post](/2026/ferrox-rust-gguf-inference-engine/) covers the design. This one covers what changed since. [v0.9.1](https://github.com/antonellof/ferrox/releases/tag/v0.9.1) shipped today.

## MoE prefill on Metal got 2.4x faster

OLMoE-1B-7B went from 587 tok/s to 1402 tok/s on 512-token prefill. Against llama.cpp on the same machine and the same file, the gap closed from 2.62x behind to 1.11x.

Ferrox runs a whole transformer layer inside one Metal command encoder. Dense layers already joined this fused stack. MoE layers did not, so each one paid host-side projections, a separate command buffer for attention, a round trip to the CPU to pick experts, and another command buffer to run them. Roughly 112 command buffers per prefill.

MoE layers now live in the same stack. Two kernels were missing and are new: a router GEMM for F32 weights, which every MoE GGUF ships, and a batched top-k softmax. The old one handled a single token at a time, which suits decode and wastes a 512-token prompt.

Decode improved too. Profiling found the expert router taking 3.6 ms of 8.5 ms per token, more than the experts it selects. Two of my own kernels ran serial work on a chip with thousands of lanes. Rewriting them dropped GPU time per token by 25 percent.

The same work extended the flash-attention kernel to 256-dimension heads. The biggest single winner was Qwen3-0.6B: 1936 tok/s to 3400 tok/s.

## The measurement I was most wrong about

The decode work left a note in my plan saying the remaining 2.4 ms per token went on barriers, roughly eight per layer. So I replaced the blanket barriers with a hazard tracker that synchronises only the memory ranges a kernel touches, ported from ggml.

Worth about 1 percent. The reason is the useful part.

Barrier counts came out at 0.99 per tracked operation before and after. A single-token decode layer is a strict dependency chain, so a range tracker has nothing to overlap and only narrows each barrier's scope. The arithmetic agrees: Llama-3.2-1B at Q4_K_M is 0.8 GB, and 6.1 ms per token works out to 130 GB/s against the M2 Pro's 200 GB/s. Decode is already limited by weight bandwidth, not by synchronisation.

My own earlier note was wrong. I wrote that into the plan so the next attempt captures the attention kernel instead of touching synchronisation again.

Verifying the change took 54 runs of the CPU-versus-Metal check across dense, MoE, sliding-window and QK-norm models at four prompt lengths. A missing barrier is a race. One green run proves nothing.

## Try it

```bash
cargo install ferrox-cli --features metal

hf download bartowski/Llama-3.2-3B-Instruct-GGUF \
  Llama-3.2-3B-Instruct-Q4_K_M.gguf --local-dir models

# Chat model. Ferrox applies the checkpoint's own chat template.
ferrox -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  -p "Explain quantization in two sentences" -n 128 -dev metal -ngl all

# Raw completion, no chat wrapping.
ferrox -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  -p "The capital of France is" -n 32 --temp 0 --no-cnv

# OpenAI-compatible server on 127.0.0.1:8383.
ferrox-server -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf -dev metal -ngl all

# Benchmark against llama-bench, side by side.
ferrox bench -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf -p 512 -n 128 -r 3 --compare
```

Point any OpenAI client at `http://127.0.0.1:8383/v1` and it works.

The engine publishes as `ferrox-inference`, since the name `ferrox` belongs to an unrelated crate. Twelve crates, all live, all sharing one version. Take the facade for the whole stack, or `ferrox-gguf` alone if you only want to read GGUF files.

```toml
[dependencies]
ferrox-inference = "0.9"
```

## Where Ferrox beats llama.cpp

Decode on Metal, same M2 Pro, same GGUF, both engines measured in the same session. Ratio is llama divided by ferrox, so under 1.0 means Ferrox is faster.

| Model | ferrox tok/s | llama.cpp tok/s | Ratio |
|---|---|---|---|
| SmolLM2-135M Q8_0 | 321.17 | 214.59 | 0.67x |
| Qwen2.5-0.5B Q8_0 | 171.63 | 120.03 | 0.70x |
| Qwen3-0.6B Q8_0 | 163.85 | 115.99 | 0.71x |
| TinyLlama-1.1B Q8_0 | 128.84 | 109.93 | 0.85x |
| Gemma-3-1B Q8_0 | 94.63 | 82.91 | 0.88x |
| Llama-3.2-1B IQ4_XS | 156.56 | 147.58 | 0.94x |
| Llama-3.2-3B Q4_K_M | 63.89 | 61.21 | 0.96x |

SmolLM2 runs 50 percent faster than llama.cpp. Small models gain most, because the per-token fixed cost dominates and that is where the fused Metal stack pays off.

CPU decode is the other story, and Ferrox loses there. The cause is measured and the fix is written, waiting on a clean benchmark window. Full table either way in [benchmarks/RESULTS.md](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md).

## New model support

gpt-oss runs on CPU, with attention sinks, alternating sliding-window attention, a biased router, and the swiglu clamp. I checked every layer against reference logits from llama.cpp rather than against my reading of the spec.

The low-bit quantization tiers landed: IQ2_XS, IQ2_S, IQ3_S, and IQ1_M. IQ3_S matters most, since IQ3_M mixes are largely made of it. All four decode bit-exact against llama.cpp's own dequantization. F16 checkpoints load now as well, which they never did before.

Phi-4-mini runs correctly on CPU and Metal. Partial rotary, LongRoPE factor sets and rope attention scaling all work, and the Metal RoPE kernels took `rot_dim` and `mscale` uniforms so the GPU path stopped being refused. A second bug turned up on the way: `rope_freqs` was sized by the head width instead of by `n_rot`.

Rotary embeddings now use the right layout for 24 more architectures, including exaone, nemotron, starcoder2, minicpm3, openelm, plamo, and dots1. Getting this wrong produces plausible text with subtly wrong attention, so I pinned the whole table against llama.cpp's reference with a test. Measured against golden logits, error dropped from 1.1e-2 to 1e-6.

## Chat templates come from the checkpoint

Ferrox used to sniff a model into one of six families and render an approximation. Anything outside those six fell back to plain text, and tool-calling formats were unreachable.

Every GGUF already carries its chat template as a Jinja string, so Ferrox evaluates that instead. Four real templates lifted from actual checkpoints are pinned in tests with exact expected output.

Half of this shipped. The evaluator exists and passes its tests, and neither the CLI nor the server calls it yet, so the serving path still sniffs. Switching the call sites is the remaining work.

One consequence I had not thought about: plenty of templates emit the BOS token themselves, and Unsloth strips it from the ones it bakes into a GGUF. Whether a loader double-adds BOS becomes a property of the checkpoint rather than of the code. I measured it across 26 local checkpoints instead of reasoning about it. Zero doubled today, but only because every prepend site had a guard. Remove the guard and 6 of the 26 double.

## Ferrox Studio

A web UI ships alongside the server, rebuilt this week on React, Tailwind, and assistant-ui: streaming chat with markdown and code blocks, a model manager, a live request log, and a Connect screen generating curl and Python snippets from your running server.

It runs as its own app rather than inside the server binary. `npm run dev` in `ui/` proxies to the API, so the server serves the API and nothing else.

Every screen goes through the public HTTP API, so anything the UI does, your own client does too. The stats under each answer come from the server's own timings rather than a browser stopwatch, so time-to-first-token and decode rate are the real numbers: `TTFT 2.29 s · prefill 12.3 tok/s · decode 54.7 tok/s`.

Model output never becomes markup. I seeded an answer containing a script tag, an image with an onerror handler, and a javascript: link, then checked the DOM: zero script or image elements, no globals set, the link href emptied, all three shown as text.

## Serving under real load

The parts deciding whether a server behaves with several clients at once:

- Chunked prefill as a resumable state machine, so a long prompt stops stalling replies already in flight.
- Admission on an integer KV block budget rather than a byte watermark.
- Cancellation drained at a step boundary, so a cancelled request leaves cleanly instead of being ripped out mid-batch.
- Stop sequences in two layers, matching single tokens by id before detokenization.
- A disk tier for the prefix cache, so a warm prefix survives a restart.
- Admission on an integer KV block budget instead of a byte watermark, with strict FIFO so a large request cannot starve behind small ones.
- Cancellation drained at a step boundary, so a cancelled row leaves through the same exit every row uses rather than being ripped out mid-batch.
- Queue depth capped with a 503 and a Retry-After, so retry storms cannot grow memory without bound.

Models load, unload, and swap at runtime. A request already running finishes against the weights it started with.

## Two tools worth stealing

`ferrox parity` compares first-token logit distributions against llama.cpp's own library. Greedy text comparison does not work for this, because ordinary floating-point drift flips one near-tied token and everything after it differs. Comparing distributions separates a wrong graph from a rounding difference.

`ferrox bench` refuses to time a run on a busy machine. Known-good rows read 25 to 45 percent low under load, wider than most gaps worth chasing. The load average now goes into every receipt, and a run above the bar stops rather than publishing noise.

The loader also refuses checkpoints it cannot compute. It records every tensor name a loader reads and fails the load on leftovers, so a model needing a graph feature Ferrox lacks gets a clear refusal instead of confident wrong tokens.

## What is next

Ranked, with measurements attached, in [docs/plans](https://github.com/antonellof/ferrox/tree/main/docs/plans):

- CPU decode, the widest remaining gap. The cause is measured: Rayon forks and joins per operation while llama.cpp runs a persistent thread pool. A replacement pool is written and waiting on a clean benchmark window.
- Folding the server into the CLI as `ferrox serve`, so there is one binary to install. It sits behind an optional feature, because the server drags in 98 crates the CLI does not need, including a C crypto library. A plain merge would make `cargo install` slower for everyone wanting only the CLI.
- [dFlash](https://inco.ai/blog/dflash2/) speculative decoding, where a drafter emits a whole block of tokens in one pass instead of one at a time.
- AMD Strix Halo, where a large unified memory pool suits keeping MoE experts resident.

Every speed number gets measured against llama.cpp on the same host, same file, same backend. If there is no receipt, the table says so. I do not invent numbers.

## AI full disclosure

This software is developed with strong assistance from Cursor, Grok 4.5, GPT 5.6, and Claude Fable 5, with humans leading the ideas, testing, and debugging. We say this openly because it shaped how the project was built. If you are not happy with AI-developed code, this software is not for you. The acknowledgement below is equally important: this would not exist without [llama.cpp](https://github.com/ggerganov/llama.cpp) and GGML, largely written by hand.

## Acknowledgements to llama.cpp and GGML

Ferrox does not link against GGML, but exists thanks to the path opened by the llama.cpp project and the kernels, quantization formats, GGUF ecosystem, and hard-won engineering knowledge developed there. Half of this work is "I read how llama.cpp did it and ported the idea", which is deliberate and is the project's default method. We are thankful and indebted to llama.cpp and its contributors. Some source-level pieces are retained or adapted here under the MIT license, notably IQ quantization codebook tables, and many other pieces were written independently against that public design. We keep the GGML authors' copyright notice in [docs/THIRD_PARTY_NOTICES.md](https://github.com/antonellof/ferrox/blob/main/docs/THIRD_PARTY_NOTICES.md).

## Closing

Ferrox is Apache-2.0. Try it, and open an issue with the GGUF name, the backend, and your `ferrox bench` output if something runs slow or wrong.

- [github.com/antonellof/ferrox](https://github.com/antonellof/ferrox)
- [v0.9.1 release](https://github.com/antonellof/ferrox/releases/tag/v0.9.1)
- [ferrox-inference on crates.io](https://crates.io/crates/ferrox-inference)

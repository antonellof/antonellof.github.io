---
layout: post
title: "Ferrox on Metal: at parity with llama.cpp, and past it"
date: 2026-08-24
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Performance, Metal, MoE]
excerpt: "How the Metal backend in my pure-Rust GGUF engine caught llama.cpp and went past it: MoE prefill 2.4x faster, a fused command encoder, and the measurement I was most wrong about."
---

<img src="/assets/images/ferrox/ferrox-logo.webp" alt="Ferrox" width="380" />

[Ferrox](https://github.com/antonellof/ferrox) is a pure-Rust inference engine for GGUF models. Dense and mixture-of-experts, on CPU, Apple Metal, or CUDA. No bindings to llama.cpp, no wrapper around ggml. You get a CLI with llama.cpp-style flags and an OpenAI-compatible HTTP server you point your existing tools at.

I wrote it for one reason. I want mixture-of-experts models running on machines too small to hold them in VRAM, with expert-level residency rather than layer offload: watch which experts fire, keep those resident, evict the rest. Doing that well means designing the router, the KV cache, and the memory manager together. Every speed claim gets pinned against llama.cpp on the same machine, same file, same backend.

The [first post](/2026/ferrox-rust-gguf-inference-engine/) covers the design. This one covers what changed since.

*Kept current with the [latest release](https://github.com/antonellof/ferrox/releases/latest). Since this went up: Metal passed llama.cpp on decode as well as prefill, speculative decoding stays lossless at any temperature, streams survive a dropped connection, and one binary now does every job. Those are at the end.*

## MoE prefill on Metal got 2.4x faster

OLMoE-1B-7B went from 587 tok/s to 1402 tok/s on 512-token prefill. Against llama.cpp on the same machine and the same file, the gap closed from 2.62x behind to 1.11x.

*Where it stands at v0.12.0, re-measured in one session with a warmup rep: OLMoE prefill is 1.09x and its decode is at parity.*

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

The only build flag you need is your GPU. Everything else is in the binary, and that binary is 19 MB with no interpreter or wheels under it.

```bash
cargo install ferrox-cli --features metal

# Same argument shape as `hf download`, and no Python involved.
ferrox download bartowski/Llama-3.2-3B-Instruct-GGUF \
  Llama-3.2-3B-Instruct-Q4_K_M.gguf --local-dir models

# Chat model. Ferrox applies the checkpoint's own chat template.
ferrox -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  -p "Explain quantization in two sentences" -n 128 -dev metal -ngl all

# Raw completion, no chat wrapping.
ferrox -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  -p "The capital of France is" -n 32 --temp 0 --no-cnv

# OpenAI-compatible server on 127.0.0.1:8383.
ferrox serve -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf -dev metal -ngl all

# Benchmark against llama-bench, side by side.
ferrox bench -m models/Llama-3.2-3B-Instruct-Q4_K_M.gguf -p 512 -n 128 -r 3 --compare
```

Point any OpenAI client at `http://127.0.0.1:8383/v1` and it works. Anthropic Messages and Responses live on the same server, so `codex` and Anthropic-shaped clients work without a shim.

The engine publishes as `ferrox-inference`, since the name `ferrox` belongs to an unrelated crate. Twelve crates, all live, all sharing one version. Take the facade for the whole stack, or `ferrox-gguf` alone if you only want to read GGUF files.

```toml
[dependencies]
ferrox-inference = "0.13"
```

## Where Ferrox beats llama.cpp

Decode on Metal at v0.12.0, same M2 Pro, same GGUF, both engines measured in one session with a warmup rep and the host load recorded at both ends. Ratio is llama divided by ferrox, so under 1.0 means Ferrox is faster.

| Model | ferrox tok/s | llama.cpp tok/s | Ratio |
|---|---|---|---|
| Qwen2.5-0.5B Q8_0 | 212.92 | 131.24 | 0.62x |
| SmolLM2-135M Q8_0 | 332.37 | 219.63 | 0.66x |
| Qwen3-0.6B Q8_0 | 165.68 | 116.92 | 0.71x |
| TinyLlama-1.1B Q8_0 | 127.49 | 98.89 | 0.78x |
| Gemma-3-1B Q8_0 | 96.51 | 83.36 | 0.86x |
| Phi-4-mini Q4_K_M | 51.97 | 47.98 | 0.92x |
| Llama-3.2-1B IQ4_XS | 160.14 | 148.44 | 0.93x |

Eight of the twelve Metal decode rows are ahead of llama.cpp and the other four sit within 3 percent of it, so no Metal row is red any more. Qwen2.5-0.5B runs 62 percent faster. Small models gain most, because the per-token fixed cost dominates and that is where the fused Metal stack pays off. Prefill closed too: every dense `pp512` row lands between 0.98x and 1.10x.

CPU is the other story, and Ferrox loses across it: all 16 comparable rows land between 1.41x and 5.06x. The cause is measured and the fix is written, waiting on a clean benchmark window. Full table either way in [benchmarks/RESULTS.md](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md), generated from checked-in raw timings rather than typed by hand.

## New model support

gpt-oss runs on CPU, with attention sinks, alternating sliding-window attention, a biased router, and the swiglu clamp. I checked every layer against reference logits from llama.cpp rather than against my reading of the spec.

The low-bit quantization tiers landed: IQ2_XS, IQ2_S, IQ3_S, and IQ1_M. IQ3_S matters most, since IQ3_M mixes are largely made of it. All four decode bit-exact against llama.cpp's own dequantization. F16 checkpoints load now as well, which they never did before.

Phi-4-mini runs correctly on CPU and Metal. Partial rotary, LongRoPE factor sets and rope attention scaling all work, and the Metal RoPE kernels took `rot_dim` and `mscale` uniforms so the GPU path stopped being refused. A second bug turned up on the way: `rope_freqs` was sized by the head width instead of by `n_rot`.

Rotary embeddings now use the right layout for 24 more architectures, including exaone, nemotron, starcoder2, minicpm3, openelm, plamo, and dots1. Getting this wrong produces plausible text with subtly wrong attention, so I pinned the whole table against llama.cpp's reference with a test. Measured against golden logits, error dropped from 1.1e-2 to 1e-6.

## Chat templates come from the checkpoint

Ferrox used to sniff a model into one of six families and render an approximation. Anything outside those six fell back to plain text, and tool-calling formats were unreachable.

Every GGUF already carries its chat template as a Jinja string, so Ferrox evaluates that instead. Four real templates lifted from actual checkpoints are pinned in tests with exact expected output.

*Update: this section originally said half of it shipped, with the evaluator written and no call site using it. Both front ends run it now. A checkpoint whose family nobody hand-wrote a renderer for is framed the way it was trained, and `chat_template_kwargs` and `reasoning_effort` pass through to it. The effort is quantized onto the gears that checkpoint actually grades, probed from its own template at load rather than read from a table keyed by model name.*

One consequence I had not thought about: plenty of templates emit the BOS token themselves, and Unsloth strips it from the ones it bakes into a GGUF. Whether a loader double-adds BOS becomes a property of the checkpoint rather than of the code. I measured it across 26 local checkpoints instead of reasoning about it. Zero doubled today, but only because every prepend site had a guard. Remove the guard and 6 of the 26 double.

## Ferrox Studio

![Ferrox Studio chat screen: a sidebar with Chat, Models, Activity and Connect, a model selector reading Llama 3.2 3B Instruct, and an answer about KV caching with a stat line underneath reading TTFT 889 ms, prefill 17 tok at 19.2 tok/s, decode 99 tok at 47.2 tok/s](/assets/images/ferrox/ferrox-studio-chat.png)


A web UI ships alongside the server, rebuilt this week on React, Tailwind, and assistant-ui: streaming chat with markdown and code blocks, a model manager, a live request log, and a Connect screen generating curl and Python snippets from your running server.

It runs as its own app rather than inside the server binary. `npm run dev` in `ui/` proxies to the API, so the server serves the API and nothing else.

Every screen goes through the public HTTP API, so anything the UI does, your own client does too. The stats under each answer come from the server's own timings rather than a browser stopwatch, so time-to-first-token and decode rate are the real numbers. That is the grey line under the answer above: `TTFT 889 ms · prefill 17 tok · 19.2 tok/s · decode 99 tok · 47.2 tok/s`, from a 3B on Metal.

Model output never becomes markup. I seeded an answer containing a script tag, an image with an onerror handler, and a javascript: link, then checked the DOM: zero script or image elements, no globals set, the link href emptied, all three shown as text.

## Serving under real load

The parts deciding whether a server behaves with several clients at once:

- Chunked prefill as a resumable state machine, so a long prompt stops stalling replies already in flight.
- Admission on an integer KV block budget instead of a byte watermark, with strict FIFO so a large request cannot starve behind small ones.
- Cancellation drained at a step boundary, so a cancelled row leaves through the same exit every row uses rather than being ripped out mid-batch.
- Stop sequences in two layers, matching single tokens by id before detokenization.
- A radix tree over reference-counted KV pages, so two conversations sharing a system prompt share its pages instead of copying them per request.
- Queue depth capped with a 503 and a Retry-After, so retry storms cannot grow memory without bound.

Models load, unload, and swap at runtime. A request already running finishes against the weights it started with.

## Two tools worth stealing

`ferrox parity` compares first-token logit distributions against llama.cpp's own library. Greedy text comparison does not work for this, because ordinary floating-point drift flips one near-tied token and everything after it differs. Comparing distributions separates a wrong graph from a rounding difference.

`ferrox bench` refuses to time a run on a busy machine. Known-good rows read 25 to 45 percent low under load, wider than most gaps worth chasing. The load average now goes into every receipt, and a run above the bar stops rather than publishing noise.

The loader also refuses checkpoints it cannot compute. It records every tensor name a loader reads and fails the load on leftovers, so a model needing a graph feature Ferrox lacks gets a clear refusal instead of confident wrong tokens.

## What is next

Ranked, with measurements attached, in [docs/plans](https://github.com/antonellof/ferrox/tree/main/docs/plans):

- CPU decode, the widest remaining gap. The cause is measured: Rayon forks and joins per operation while llama.cpp runs a persistent thread pool. A replacement pool is written and waiting on a clean benchmark window.
- CPU prefill. The blocked attention kernel is 53 percent of non-idle samples on SmolLM2 against roughly 8 percent of the model's FLOPs, because pass one does a dot product per query per KV position with no K reuse across the query block.
- [dFlash](https://inco.ai/blog/dflash2/) speculative decoding, where a drafter emits a whole block of tokens in one pass instead of one at a time.
- AMD Strix Halo, where a large unified memory pool suits keeping MoE experts resident.

Every speed number gets measured against llama.cpp on the same host, same file, same backend. If there is no receipt, the table says so. I do not invent numbers.

## Shipped since this was written

Six things landed after this post went up.

**Speculative decoding is lossless at any temperature.** It used to accept a draft token only when the target's argmax matched, which is correct at temperature 0 and quietly wrong above it. Verification now uses the speculative-sampling rejection rule. Drafters plug in through a `Drafter` trait, and acceptance length plus the per-position accept rate are reported, so a drafter that decays toward the end of a block shows up instead of being averaged away.

**Streams survive a dropped connection.** `GET /v1/stream/{request_id}` replays with Last-Event-ID, and there is a polling sibling for proxies that buffer SSE. Two features collided here and only one of them wins: an orphan deadline cancels generation when nobody has read for 30 seconds, and a resumable stream exists precisely so a dropped socket does not cancel. The deadline still detects and logs, and only cancels streams that are not resumable.

**The server prices its KV budget before loading.** Weights plus context times per-token KV against the device budget, with `FERROX_CB_MAX_CONTEXT` and `FERROX_CB_KV_BLOCKS` derived when unset. A request that cannot fit gets a typed 400 naming which ceiling binds, rather than an OOM later.

**One binary does every job.** `cargo install ferrox-cli --features metal` now gives you completions, `ferrox serve`, `ferrox download`, `ferrox bench` and `ferrox verify`. There is no feature flag to discover beyond your GPU. I had kept `serve` behind a flag to spare a completion-only user 98 crates and a C crypto library, and that rule was costing more than it saved: it had already put a false claim in the README, and it was hiding a headline capability where nobody would find it. `ferrox-server` stays published for anyone who wants the server alone.

**Fetching a model needs no Python.** `ferrox download` takes `hf download`'s exact argument shape, so a command copied off a model card runs unchanged. It resolves IPv4 first, because Hugging Face publishes AAAA records that black-hole on some networks, reads `HF_TOKEN` for gated repos, and asks for a byte range so an interrupted download resumes. Bytes land on a `.partial` name and are renamed only after the last one arrives, so the loader never opens a truncated file as a whole GGUF.

**A model too large for the machine is refused before it loads,** naming the checkpoint's size, the memory available, and what expert streaming would cost. I shipped the opposite first: streaming turned itself on when the weights did not fit. Then OLMoE answered "Paris." resident and "amongst amongst, and of" streamed, deterministically, at temperature 0. Auto-enabling was withdrawn the same day. Streaming stays an explicit opt-in until it returns the right tokens, because "your model does not fit" is a bad outcome and "your model answers nonsense" is a much worse one.

## AI full disclosure

This software is developed with strong assistance from Cursor, Grok 4.5, GPT 5.6, and Claude Fable 5, with humans leading the ideas, testing, and debugging. We say this openly because it shaped how the project was built. If you are not happy with AI-developed code, this software is not for you. The acknowledgement below is equally important: this would not exist without [llama.cpp](https://github.com/ggerganov/llama.cpp) and GGML, largely written by hand.

## Acknowledgements to llama.cpp and GGML

Ferrox does not link against GGML, but exists thanks to the path opened by the llama.cpp project and the kernels, quantization formats, GGUF ecosystem, and hard-won engineering knowledge developed there. Half of this work is "I read how llama.cpp did it and ported the idea", which is deliberate and is the project's default method. We are thankful and indebted to llama.cpp and its contributors. Some source-level pieces are retained or adapted here under the MIT license, notably IQ quantization codebook tables, and many other pieces were written independently against that public design. We keep the GGML authors' copyright notice in [docs/THIRD_PARTY_NOTICES.md](https://github.com/antonellof/ferrox/blob/main/docs/THIRD_PARTY_NOTICES.md).

## Closing

Ferrox is Apache-2.0. Try it, and open an issue with the GGUF name, the backend, and your `ferrox bench` output if something runs slow or wrong.

- [github.com/antonellof/ferrox](https://github.com/antonellof/ferrox)
- [latest release](https://github.com/antonellof/ferrox/releases/latest)
- [ferrox-inference on crates.io](https://crates.io/crates/ferrox-inference)
- [benchmarks/RESULTS.md](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md)
- [the first post](/2026/ferrox-rust-gguf-inference-engine/), on why the engine exists

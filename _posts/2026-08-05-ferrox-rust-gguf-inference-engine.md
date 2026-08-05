---
layout: post
title: "Ferrox: Building a Rust Inference Engine That Matches llama.cpp"
date: 2026-08-05
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Performance]
excerpt: "Why I built Ferrox, a pure-Rust GGUF inference engine, and what it took to match llama.cpp's performance on real models — with receipts, not vibes."
---

I've spent the last few months building [Ferrox](https://github.com/antonellof/ferrox), a pure-Rust inference engine for running open LLMs locally — dense models and Mixture-of-Experts, on CPU, Apple Metal, or CUDA. No bindings to llama.cpp or ggml, no wrapping an existing runtime. Every kernel, every loader, every scheduling decision written from scratch.

The obvious question is "why, when llama.cpp already exists and is excellent." The honest answer: I wanted to understand inference at a level deeper than "run the binary," and I wanted a project where every performance claim had to be earned against a real, well-known baseline rather than asserted.

## What Ferrox actually is

At its core, Ferrox loads a [GGUF](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md) file — the same quantized model format llama.cpp uses — and runs inference on it. Two ways to use it:

- **A CLI**, `ferrox`, with llama.cpp-compatible flags. Point it at a model, get a completion.
- **A server**, `ferrox-server`, that speaks the OpenAI chat-completions API. Anything built against ChatGPT's API — a chat UI, an agent framework, a test harness — works against it unchanged, just pointed at `localhost`.

```bash
# One-shot completion
./ferrox -m llama-3.1-8b-q4_k_m.gguf -p "The capital of France is" -n 32 --temp 0 --no-cnv

# OpenAI-compatible server
./ferrox-server -m llama-3.1-8b-q4_k_m.gguf --host 127.0.0.1 --port 8383 -dev metal -ngl all

curl -s http://127.0.0.1:8383/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"m","messages":[{"role":"user","content":"Hi"}],"max_tokens":32}'
```

Under the hood, model weights are memory-mapped straight off disk and never fully decompressed into RAM — dequantization happens fused into the dot product, at the moment the weight is actually needed. That's the same trick llama.cpp uses, and it's a big part of why both engines can run an 8B-parameter model on a laptop with a few gigabytes of memory instead of thirty.

## Why performance had to be provable, not claimed

Every local-inference project claims to be fast. Almost none show the methodology. I didn't want to add noise to that pile, so the whole benchmarking setup in Ferrox is built to make claims falsifiable:

- Same machine, same GGUF file, same backend, for both engines, back to back.
- Warm runs, greedy decoding, multiple reps, median reported.
- Every headline number is pinned to a JSON receipt in the repo — regenerate it and the numbers either hold or they don't.

That discipline turned up real results, on an Apple M2 Pro:

| Model | Backend | Ferrox | llama.cpp | Result |
|---|---|---|---|---|
| Llama-3.1-8B Q4_K_M | Metal | 26.9 tok/s | 27.8 tok/s | ~parity |
| Qwen2.5-0.5B Q8_0 | Metal | 192 tok/s | 123 tok/s | ~1.56× faster |
| SmolLM2-135M Q8_0 | Metal | 284 tok/s | 193 tok/s | ~1.47× faster |
| TinyLlama-1.1B Q8_0 | CPU | 44.6 tok/s | 38.2 tok/s | ~1.17× faster |
| OLMoE-1B-7B (MoE) | CPU/CUDA | — | — | parity |

Full methodology and every raw pin: [`benchmarks/RESULTS.md`](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md). Being roughly tied with llama.cpp on an 8B dense model — a project this team has spent years tuning — was the moment I felt the engine had earned its existence, rather than just being an academic exercise.

## Where the wins came from

Two architectural choices did most of the work:

**Fusing dequantization into the matmul.** Quantized weights (4-bit, 8-bit) never get expanded into a full-precision buffer. The dequant math happens inline as part of the dot product, so you pay for it once, in cache, rather than as a separate memory-bound pass.

**Architecture-specific GPU paths.** Models aren't structurally identical — Qwen has per-head QK-normalization, Gemma-3 uses sliding-window attention and GeGLU, Phi-3 fuses its QKV and FFN projections. Ferrox implements dedicated Metal kernels for each of these instead of forcing every model through one generic attention path. That's precisely why small Qwen and SmolLM2 models beat llama.cpp on Metal by 50%+ — the kernel matches the actual computation shape instead of paying overhead for generality it doesn't need.

## Utility: why this is more than a benchmark exercise

Beyond the numbers, Ferrox is a genuinely practical way to run models locally:

1. **Single static binary.** No Python environment, no CUDA-toolkit version roulette, no `pip install` dependency resolution. Copy the binary, point it at a `.gguf` file, run.
2. **Drop-in for existing tooling.** The OpenAI-compatible server means any app already wired for ChatGPT's API — LangChain scripts, custom chat frontends, eval harnesses — works against a fully local model with a one-line base-URL change.
3. **MoE support, not just dense models.** [OLMoE-1B-7B](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md) runs and matches llama.cpp, which matters because Mixture-of-Experts is where a lot of frontier-model efficiency gains are coming from — an inference engine that only handles dense transformers is increasingly incomplete.
4. **Backend flexibility for the hardware you actually own.** CPU-only laptop, Apple Silicon, Nvidia GPU — one codebase covers all three, rather than three separate tools.

## What isn't done yet

I'd rather undersell this than oversell it:

- **CUDA performance work is paused.** It compiles and runs correctly, but the fair-chat tuning that got Metal to parity hasn't been done for CUDA yet.
- **Metal prefill still trails llama.cpp** on larger models — decode is where the parity numbers live; time-to-first-token has more room.
- **Frontier-scale MoE models** — Kimi K3, GLM-5.2, DeepSeek V4 — have dedicated primitives and synthetic decoder stacks in the codebase, but no real multi-hundred-billion-parameter checkpoint has been run end-to-end. Kimi K3 alone is roughly 1.56 TB of weights; that's a hardware problem as much as a software one.

## Conclusion

Ferrox started as a way to actually understand inference internals instead of treating them as a black box behind a `pip install`. It turned into something I'd genuinely reach for: a single binary that loads a GGUF file and either chats in the terminal or serves an OpenAI-compatible API, at speeds that hold up against the reference implementation on real hardware, with the receipts to prove it.

If you're curious how quantized inference works under the hood, want a dependency-free way to run open models locally, or just want to poke holes in the benchmark methodology, the repo is Apache-2.0 and open for issues and PRs.

**Further resources:**
- [Ferrox on GitHub](https://github.com/antonellof/ferrox)
- [`benchmarks/RESULTS.md`](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md) — full pinned benchmark suite
- [`docs/MODELS.md`](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md) — supported architectures and verification status
- [GGUF format spec](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — the reference this project measures itself against

---

*Building Ferrox from August 2026, on why performance claims should come with receipts.*

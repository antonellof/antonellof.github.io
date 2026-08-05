---
layout: post
title: "Ferrox: Building a Rust Inference Engine That Matches llama.cpp"
date: 2026-08-05
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Performance]
excerpt: "Why I built Ferrox, a pure-Rust GGUF inference engine, and what it took to match llama.cpp's performance on real models — with receipts, not vibes."
---

I've spent the last few days building [Ferrox](https://github.com/antonellof/ferrox), a pure-Rust inference engine for running open LLMs locally — dense models and Mixture-of-Experts, on CPU, Apple Metal, or CUDA. No bindings to llama.cpp or ggml, no wrapping an existing runtime. Every kernel, every loader, every scheduling decision written from scratch.

The obvious question is "why, when llama.cpp already exists and is excellent." The honest answer: I wanted to understand inference at a level deeper than "run the binary," and I wanted a project where every performance claim had to be earned against a real, well-known baseline rather than asserted.

## What Ferrox actually is

At its core, Ferrox loads a [GGUF](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md) file — the same quantized model format llama.cpp uses — and runs inference on it. Two ways to use it:

- **A CLI**, `ferrox`, with llama.cpp-compatible flags. Point it at a model, get a completion.
- **A server**, `ferrox-server`, that speaks the OpenAI chat-completions API. Anything built against ChatGPT's API — a chat UI, an agent framework, a test harness — works against it unchanged, just pointed at `localhost`.

Under the hood, model weights are memory-mapped straight off disk and never fully decompressed into RAM — dequantization happens fused into the dot product, at the moment the weight is actually needed. That's the same trick llama.cpp uses, and it's a big part of why both engines can run an 8B-parameter model on a laptop with a few gigabytes of memory instead of thirty.

## Try it: build, download a GGUF, run

Ferrox does not ship weights. You download a local `.gguf` the same way you would for llama.cpp — I recommend the [Hugging Face CLI](https://huggingface.co/docs/huggingface_hub/guides/cli) (`pip install -U huggingface_hub`):

```bash
git clone https://github.com/antonellof/ferrox.git
cd ferrox
cargo build --release -p ferrox-cli -p ferrox-server --features metal

mkdir -p models

# ~1.2 GB smoke test
hf download TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF \
  tinyllama-1.1b-chat-v1.0.Q8_0.gguf --local-dir models

# Optional: small instruct chat model (~0.8 GB)
hf download bartowski/Llama-3.2-1B-Instruct-GGUF \
  Llama-3.2-1B-Instruct-Q4_K_M.gguf --local-dir models
```

Handy starting points from the [README](https://github.com/antonellof/ferrox):

| Model | Hugging Face repo | File |
|---|---|---|
| TinyLlama 1.1B Chat Q8_0 | [TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF](https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF) | `tinyllama-1.1b-chat-v1.0.Q8_0.gguf` |
| Llama 3.2 1B Instruct Q4_K_M | [bartowski/Llama-3.2-1B-Instruct-GGUF](https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF) | `Llama-3.2-1B-Instruct-Q4_K_M.gguf` |
| Llama 3.1 8B Instruct Q4_K_M | [bartowski/Meta-Llama-3.1-8B-Instruct-GGUF](https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF) | `Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf` |
| SmolLM2 135M Instruct Q8_0 | [bartowski/SmolLM2-135M-Instruct-GGUF](https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF) | `SmolLM2-135M-Instruct-Q8_0.gguf` |

Prefer `Q4_K_M` for everyday use, `Q8_0` for tiny smoke tests. More GGUFs: [llama.cpp-compatible models on Hugging Face](https://huggingface.co/models?apps=llama.cpp&sort=trending). What Ferrox verifies today: [`docs/MODELS.md`](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md).

Then:

```bash
# One-shot completion
./target/release/ferrox -m models/tinyllama-1.1b-chat-v1.0.Q8_0.gguf \
  -p "The capital of France is" -n 32 --temp 0 --no-cnv

# Chat on Metal (default when the GGUF ships a chat template)
./target/release/ferrox -m models/Llama-3.2-1B-Instruct-Q4_K_M.gguf \
  -p "What is 2+2?" -n 64 --temp 0 -dev metal -ngl all

# OpenAI-compatible server
./target/release/ferrox-server \
  -m models/tinyllama-1.1b-chat-v1.0.Q8_0.gguf \
  --host 127.0.0.1 --port 8383 -dev metal -ngl all

curl -s -X POST http://127.0.0.1:8383/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"m","messages":[{"role":"user","content":"Hi"}],"max_tokens":32,"temperature":0}'
```

Flags mirror llama.cpp (`-m`, `-p`, `-n`, `-t`, `--temp`, `-ngl`, …) — full reference in [`docs/CLI.md`](https://github.com/antonellof/ferrox/blob/main/docs/CLI.md). One Ferrox-specific knob worth knowing: `--ctk q8_0` (or `FERROX_CTK=q8_0`) stores the KV cache as Q8_0 on Metal instead of the default `f16`, which trades a bit of precision for a smaller KV footprint on longer contexts.

## Why performance had to be provable, not claimed

Every local-inference project claims to be fast. Almost none show the methodology. I didn't want to add noise to that pile, so the whole benchmarking setup in Ferrox is built to make claims falsifiable:

- Same machine, same GGUF file, same backend, for both engines, back to back.
- Warm runs, greedy decoding, multiple reps, median reported.
- Every headline number is pinned to a JSON receipt in the repo — regenerate it and the numbers either hold or they don't.

That discipline turned up real results on an Apple M2 Pro (Host B). Headline numbers below are **predicted tok/s** from the fair-chat suite in [`benchmarks/RESULTS.md`](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md) — Gap is `llama / ferrox` (under 1.0 means Ferrox is faster; near-parity is within ~5%):

| Model | Backend | Ferrox | llama.cpp | Gap |
|---|---|---|---|---|
| Llama-3.1-8B Q4_K_M | Metal | 28.3 tok/s | 27.6 tok/s | ~0.97× (parity / Ferrox) |
| Llama-3.2-1B Q4_K_M | Metal | 140.8 tok/s | 140.8 tok/s | 1.00× (parity) |
| TinyLlama-1.1B Q8_0 | Metal | 117.9 tok/s | 113.7 tok/s | ~0.96× (parity) |
| Qwen2.5-0.5B Q8_0 | Metal | 196.1 tok/s | 132.8 tok/s | ~0.68× (Ferrox) |
| SmolLM2-135M Q8_0 | Metal | 290.2 tok/s | 241.2 tok/s | ~0.83× (Ferrox) |
| Gemma-3-1B Q8_0 | Metal | 94.1 tok/s | 81.7 tok/s | ~0.87× (Ferrox) |
| OLMoE-1B-7B Q4_0 | Metal | 88.4 tok/s | 156.8 tok/s | ~1.77× (llama) |
| Mistral-7B Q4_K_M | Metal | 31.4 tok/s | 33.3 tok/s | ~1.06× (near parity) |
| Phi-4-mini Q4_K_M | Metal | 50.0 tok/s | 53.1 tok/s | ~1.06× (near parity) |

The north-star pin is the one that matters most to me: **Llama-3.1-8B on Metal** is now **~0.97×** — Ferrox slightly ahead of llama.cpp on the same host and GGUF (28.27 vs 27.55 pred). On the CLI one-shot path it is an exact **1.00×** tie (28.85 vs 28.64). That is the moment the engine stopped feeling like an academic exercise.

The other big movement since the first pins: **OLMoE on Metal**. Early receipts were roughly **~15×** behind llama.cpp (~10 tok/s). After Metal expert-placement work it sits at **88.4 vs 156.8** (~1.77×) — still trailing, but in a completely different league. Gemma-3 Metal flipped from trailing to ahead. Full methodology and every raw pin live in the RESULTS file.

### Re-running the suite

If you want to regenerate the receipts yourself (same host, same GGUFs, both engines):

```bash
python3 benchmarks/run_suite.py --skip-missing --fit-host
# optional CLI mode pins:
python3 benchmarks/run_suite.py --skip-missing --fit-host --mode cli
```

That overwrites pins under `benchmarks/receipts/pins/` and regenerates `RESULTS.md` via `render_results.py`. No invented numbers — if a pin is missing, the table says so. `--fit-host` skips models that do not fit the machine (and skips CUDA on darwin).

## Where the wins came from

Two architectural choices did most of the work:

**Fusing dequantization into the matmul.** Quantized weights (4-bit, 8-bit) never get expanded into a full-precision buffer. The dequant math happens inline as part of the dot product, so you pay for it once, in cache, rather than as a separate memory-bound pass.

**Architecture-specific GPU paths.** Models aren't structurally identical — Qwen has per-head QK-normalization, Gemma-3 uses sliding-window attention and GeGLU, Phi-3 fuses its QKV and FFN projections. Ferrox implements dedicated Metal kernels for each of these instead of forcing every model through one generic attention path. That's precisely why small Qwen and SmolLM2 models beat llama.cpp on Metal by a wide margin — the kernel matches the actual computation shape instead of paying overhead for generality it doesn't need. The same idea drove the OLMoE Metal jump: expert placement on GPU, not a generic dense path wearing a MoE costume.

## Utility: why this is more than a benchmark exercise

Beyond the numbers, Ferrox is a genuinely practical way to run models locally:

1. **Single static binary.** No Python environment, no CUDA-toolkit version roulette, no `pip install` dependency resolution. Copy the binary, point it at a `.gguf` file, run.
2. **Drop-in for existing tooling.** The OpenAI-compatible server means any app already wired for ChatGPT's API — LangChain scripts, custom chat frontends, eval harnesses — works against a fully local model with a one-line base-URL change.
3. **MoE support, not just dense models.** [OLMoE-1B-7B](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md) runs on CPU and Metal with verified pins. Metal MoE still trails llama.cpp, but the gap is closing. That matters because Mixture-of-Experts is where a lot of frontier-model efficiency gains are coming from — an inference engine that only handles dense transformers is increasingly incomplete.
4. **Backend flexibility for the hardware you actually own.** CPU-only laptop, Apple Silicon, Nvidia GPU — one codebase covers all three, rather than three separate tools. Quantized KV (`--ctk q8_0` on Metal) helps when context length starts eating unified memory.

## What isn't done yet

I'd rather undersell this than oversell it:

- **CUDA performance work is paused.** The suite supports `--backend cuda`, but there is no current CUDA pin — needs a GPU host.
- **Metal prefill** still needs watching against llama.cpp on larger models — decode is where the parity numbers live; `prompt_per_second` has more room.
- **MoE on Metal** improved a lot, but OLMoE is still ~1.8× behind llama.cpp. Qwen2-MoE / Mixtral pins are missing on Host B (GGUF / RAM).
- **Gemma-4-E2B** is explicitly refused today (needs a dedicated engine path) — both Ferrox and Homebrew llama.cpp reject it.
- **Frontier-scale MoE / MLA** — Kimi, GLM, DeepSeek — have primitives and synthetic stacks, but no real multi-hundred-billion-parameter checkpoint has been run end-to-end. That is a hardware problem as much as a software one.

## Conclusion

Ferrox started as a way to actually understand inference internals instead of treating them as a black box behind a `pip install`. It turned into something I'd genuinely reach for: a single binary that loads a GGUF file and either chats in the terminal or serves an OpenAI-compatible API, at speeds that hold up against the reference implementation on real hardware, with the receipts to prove it.

If you're curious how quantized inference works under the hood, want a dependency-free way to run open models locally, or just want to poke holes in the benchmark methodology, the repo is Apache-2.0 and open for issues and PRs.

**Further resources:**
- [Ferrox on GitHub](https://github.com/antonellof/ferrox)
- [`benchmarks/RESULTS.md`](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md) — full pinned benchmark suite
- [`docs/MODELS.md`](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md) — supported architectures and verification status
- [`docs/CLI.md`](https://github.com/antonellof/ferrox/blob/main/docs/CLI.md) — CLI flags
- [GGUF format spec](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — the reference this project measures itself against

---

*Building Ferrox from August 2026, on why performance claims should come with receipts.*

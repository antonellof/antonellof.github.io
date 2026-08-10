---
layout: post
title: "Ferrox: a Rust GGUF engine, measured against llama.cpp"
date: 2026-08-05
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Performance]
excerpt: "I built Ferrox, a pure-Rust GGUF inference engine. Not to replace llama.cpp, but to get MoE expert residency right — and every speed claim is pinned against llama.cpp on the same machine."
---

I built [Ferrox](https://github.com/antonellof/ferrox) over the last couple of weeks. It is a pure-Rust inference engine for GGUF models: dense and MoE, on CPU, Apple Metal, or CUDA. No bindings to llama.cpp. No wrapper around ggml.

## Why another engine

llama.cpp is excellent. I am not trying to catch up with every feature it has.

What I want is MoE on machines that cannot fit the whole model in VRAM. Not layer offload. Expert-level residency: watch which experts fire during decode, keep those resident, evict the rest. To do that well the router, the KV cache and the memory manager have to be designed together. That is about the only good reason to write a runtime from scratch. If you just need "run a Llama GGUF on my Mac", use llama.cpp.

## What it does today

Two binaries:

- `ferrox` — CLI with flags close to llama.cpp (`-m`, `-p`, `-n`, `-ngl`, `--ctk`, …)
- `ferrox-server` — OpenAI-compatible HTTP (`/v1/chat/completions`, plus a few extras)

Weights stay quantized on mmap. Dequant happens inside the matmul, not as a separate pass. Same idea as llama.cpp, which is why an 8B model fits on a laptop without thirty gigabytes of RAM.

Supported families (verified pins, not just "it loads"): Llama 3.x, TinyLlama, SmolLM2, Qwen2.5/Qwen3, Gemma-2/3, Phi-3/4, Mistral-7B, OLMoE. Gemma-4 has a dedicated path. MLA / DeepSeek-style stacks are partial. Details: [`docs/MODELS.md`](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md) and [`docs/FEATURES.md`](https://github.com/antonellof/ferrox/blob/main/docs/FEATURES.md).

## Build, download, run

```bash
git clone https://github.com/antonellof/ferrox.git
cd ferrox
cargo build --release -p ferrox-cli -p ferrox-server --features metal

mkdir -p models
hf download TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF \
  tinyllama-1.1b-chat-v1.0.Q8_0.gguf --local-dir models

./target/release/ferrox -m models/tinyllama-1.1b-chat-v1.0.Q8_0.gguf \
  -p "The capital of France is" -n 32 --temp 0 --no-cnv

# chat template + Metal
./target/release/ferrox -m models/Llama-3.2-1B-Instruct-Q4_K_M.gguf \
  -p "What is 2+2?" -n 64 --temp 0 -dev metal -ngl all

./target/release/ferrox-server \
  -m models/tinyllama-1.1b-chat-v1.0.Q8_0.gguf \
  --host 127.0.0.1 --port 8383 -dev metal -ngl all
```

Useful GGUFs from the [README](https://github.com/antonellof/ferrox):

| Model | Repo | File |
|---|---|---|
| TinyLlama 1.1B Chat Q8_0 | [TheBloke/…](https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF) | `tinyllama-1.1b-chat-v1.0.Q8_0.gguf` |
| Llama 3.2 1B Instruct Q4_K_M | [bartowski/…](https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF) | `Llama-3.2-1B-Instruct-Q4_K_M.gguf` |
| Llama 3.1 8B Instruct Q4_K_M | [bartowski/…](https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF) | `Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf` |
| SmolLM2 135M Instruct Q8_0 | [bartowski/…](https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF) | `SmolLM2-135M-Instruct-Q8_0.gguf` |

Prefer `Q4_K_M` day to day. `Q8_0` for tiny tests. On Metal, `--ctk q8_0` shrinks the KV cache if you need longer context.

There is also `ferrox pull` for Hugging Face downloads, and `ferrox bench` if you want llama-bench-style numbers without going through HTTP.

## Numbers, with receipts

I do not trust speed claims without a method. Ferrox pins every comparison: same Mac (M2 Pro), same GGUF, same backend, both engines, median of warm runs. Full file: [`benchmarks/RESULTS.md`](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md).

There are now two tracks:

1. **Engine** — `ferrox bench` vs `llama-bench` (no HTTP, no chat template). `pp512` = prefill, `tg128` = decode.
2. **Serving** — HTTP fair-chat via `python3 benchmarks/run_suite.py`

Gap = `llama / ferrox`. Under 1.0 means Ferrox is faster. Near-parity means within ~5%.

Engine decode on Metal (what I care about for chat):

| Model | tg128 Ferrox | tg128 llama.cpp | Gap |
|---|---|---|---|
| Llama-3.1-8B Q4_K_M | 27.4 | 26.9 | ~0.98× |
| Llama-3.2-1B Q4_K_M | 59.5 | 57.9 | ~0.97× |
| Llama-3.2-3B Q4_K_M | 59.8 | 58.4 | ~0.98× |
| Mistral-7B Q4_K_M | 19.7 | 18.0 | ~0.91× |
| Gemma-3-1B Q8_0 | 58.3 | 52.8 | ~0.91× |

So on decode for these dense models, we are at parity or a bit ahead. That took a lot of Metal work: porting llama.cpp-style `mul_mm` across quants, FA-vec attention, batched FFN during prefill, scratch buffer pooling.

Prefill is still behind. On Llama-3.1-8B Metal, `pp512` is **~1.47×** slower than llama.cpp (170 vs 251 tok/s). CPU decode is behind almost everywhere. OLMoE Metal decode improved a lot from the first pins (we were ~15× off; now closer to ~1.3–1.8× depending on the track) but MoE is not "done".

Re-run it yourself:

```bash
# engine table
ferrox bench --suite

# serving / fair-chat pins
python3 benchmarks/run_suite.py --skip-missing --fit-host
```

If there is no pin, the table says so. I do not invent numbers.

## What I learned so far

A few things that stuck, after many evenings staring at tok/s:

- **Decode and prefill are different problems.** Getting tg128 to parity does not mean pp512 follows. Batched Metal GEMM and FA-vec prefill helped, but llama.cpp still wins big on long prompt throughput.
- **MoE Metal needs its own path.** A dense kernel wearing a MoE costume loses. Expert placement, `mul_mm_id`, fused groups: that is where the OLMoE gap went from embarrassing to merely bad.
- **Fair comparison is harder than it looks.** Forcing both engines to the same thread count made llama.cpp look worse on this Mac, because it already prefers performance cores. The suite no longer forces `-t`.
- **CUDA was quietly broken.** `--features cuda` on the CLI did not enable CUDA in `ferrox-core`. Prefill never hit the GPU. Fixed now; tuning is still ahead.

None of this is glamorous. It is the work.

## What is next

From the [roadmap](https://github.com/antonellof/ferrox/blob/main/docs/ROADMAP.md):

1. Run bigger models on the same hardware (Qwen3 35B-A3B-class on a box that today only likes 8B).
2. Act on residency plans: stream cold MoE experts, tighter KV (`turbo3`, quantized CTK).
3. Hybrid CPU/GPU expert placement.
4. CUDA tuning (it builds and runs; no serious pass yet).
5. Tool calling / fuller OpenAI surface, Docker images.

If you want to point an IDE or agent at the local server, there is a short cookbook: [`docs/AGENTS_COOKBOOK.md`](https://github.com/antonellof/ferrox/blob/main/docs/AGENTS_COOKBOOK.md).

## Closing

Ferrox is Apache-2.0. Stars are nice; PRs and failed pins are more useful. If you try it and something is slow or wrong, open an issue with the GGUF name, backend, and the `ferrox bench` output.

I am a coder, not a blogger. I will keep writing these myself.

**Links**
- [github.com/antonellof/ferrox](https://github.com/antonellof/ferrox)
- [benchmarks/RESULTS.md](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md)
- [docs/FEATURES.md](https://github.com/antonellof/ferrox/blob/main/docs/FEATURES.md)
- [docs/MODELS.md](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md)
- [HN discussion](https://news.ycombinator.com/item?id=49180302)

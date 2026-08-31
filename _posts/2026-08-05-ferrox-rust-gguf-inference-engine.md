---
layout: post
title: "Ferrox: a Rust GGUF engine, measured against llama.cpp"
date: 2026-08-05
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Performance]
excerpt: "I built Ferrox, a pure-Rust GGUF inference engine. Not to replace llama.cpp, but to get MoE expert residency right, and every speed claim is pinned against llama.cpp on the same machine."
---

<img src="/assets/images/ferrox/ferrox-logo.webp" alt="Ferrox" width="380" />

*Written August 2026, at v0.4. Ferrox has moved a long way since, so the sections below carry update notes where the numbers changed.*

I built [Ferrox](https://github.com/antonellof/ferrox) over the last couple of weeks. It is a pure-Rust inference engine for GGUF models: dense and MoE, on CPU, Apple Metal, or CUDA. No bindings to llama.cpp. No wrapper around ggml.

## Where Ferrox is now

Many releases later, the [current one](https://github.com/antonellof/ferrox/releases/latest) is published on [crates.io](https://crates.io/crates/ferrox-inference). The short version:

- **Metal caught llama.cpp and went past it.** Every dense `pp512` row sits between 0.98× and 1.10×, and 8 of the 12 `tg128` rows are faster. CPU is still behind on all 16 comparable rows, 1.41× to 5.06×.
- One binary does everything: completions, `ferrox serve` for the OpenAI and Anthropic compatible API, `ferrox download`, `ferrox bench`, `ferrox verify`. The only build flag you need is your GPU.
- `ferrox download` fetches a model with `hf download`'s exact syntax, so a command copied off a model card runs unchanged. No Python.
- Twelve real checkpoints answer correctly on Metal, two of them MoE.
- A web UI, Ferrox Studio, running as its own app against the same public API any other client uses.
- Published as `ferrox-inference`, with every layer available on its own if you want the GGUF reader and nothing else.

The middle of that stretch has its own post: [Ferrox on Metal](/2026/ferrox-metal-parity-llama-cpp/).

## Why another engine

llama.cpp is excellent. I am not trying to catch up with every feature it has.

What I want is MoE on machines that cannot fit the whole model in VRAM. Not layer offload. Expert-level residency: watch which experts fire during decode, keep those resident, evict the rest. To do that well the router, the KV cache and the memory manager have to be designed together. That is about the only good reason to write a runtime from scratch. If you only need "run a Llama GGUF on my Mac", use llama.cpp.

## What it does today

One binary with flags close to llama.cpp (`-m`, `-p`, `-n`, `-ngl`, `--ctk`, …). `ferrox serve` starts the HTTP server from the same executable, and `ferrox-server` still ships on its own for anyone who prefers two.

*Update: this originally listed two binaries. `serve` is a default feature now, so one `cargo install` gets completions, the server, the downloader, bench and verify. The server answers Anthropic Messages and Responses beside the OpenAI routes.*

That binary is 19 MB, or 14 MB stripped, with no runtime under it. No interpreter, no virtualenv, no wheels to resolve, nothing to activate before you can run a model. It sits in the same ballpark as llama.cpp's own core, which is 14 MB of executables and shared libraries on this Mac. Against the Python serving stacks it is a different category: PyTorch alone measures 402 MB here, and vLLM sits on top of that.

Weights stay quantized on mmap. Dequant happens inside the matmul, not as a separate pass. Same idea as llama.cpp, which is why an 8B model fits on a laptop without thirty gigabytes of RAM.

Verified families, meaning a real checkpoint answered correctly and stopped, not merely "it loads": Llama 3.x, TinyLlama, SmolLM2, Qwen2.5/Qwen3, Gemma-2/3/4, Phi-4-mini, Mistral-7B, Yi, DeepSeek-R1 distills, OLMoE and Qwen1.5-MoE. gpt-oss runs on CPU. MLA / DeepSeek-style stacks are partial.

That is about twelve architectures with evidence behind them, out of 150 rows in the catalog. The rest refuse to load, naming the tensor or the hyperparameter they need, or are marked unproven. I chose that. llama.cpp hand-writes 140 per-architecture graphs, and that hand-written work is the whole reason its coverage is wider than mine. Until Ferrox has done the same work for a family, it stops with an error rather than running a graph that is merely close enough to compile and handing back fluent text computed the wrong way. A refusal you can read is coverage. Confident wrong tokens are not.

## Build, download, run

```bash
# --features metal on Apple silicon, cuda on Linux + NVIDIA, nothing on CPU.
cargo install ferrox-cli --features metal

# Same argument shape as `hf download`, without the Python.
ferrox download bartowski/Llama-3.2-1B-Instruct-GGUF \
  Llama-3.2-1B-Instruct-Q4_K_M.gguf --local-dir models

# Ferrox wraps the prompt in the checkpoint's own chat template.
ferrox -m models/Llama-3.2-1B-Instruct-Q4_K_M.gguf \
  -p "What is 2+2?" -n 64 --temp 0 -dev metal -ngl all

# Serve on 127.0.0.1:8383 and point any OpenAI client at /v1.
ferrox serve -m models/Llama-3.2-1B-Instruct-Q4_K_M.gguf -dev metal -ngl all
```

The [README](https://github.com/antonellof/ferrox) lists known-good GGUFs to start from. Prefer `Q4_K_M` day to day, `Q8_0` for tiny tests. On Metal, `--ctk q8_0` shrinks the KV cache if you need longer context.

A model too large for the machine is refused before it loads, naming the checkpoint's size, the memory you have, and what expert streaming would cost. Streaming is opt-in: it is slower than keeping experts resident, and it still returns wrong tokens on real MoE checkpoints. Running out of memory is a bad outcome. Answering nonsense is a worse one.

## Numbers, with receipts

I do not trust speed claims without a method. `ferrox bench` runs the same `pp512` prefill and `tg128` decode workloads as `llama-bench`, on the same Mac (M2 Pro), the same GGUF and the same backend. Every run writes a JSON file of raw timings, those files are checked into the repo, and [`benchmarks/RESULTS.md`](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md) is generated from them rather than typed by hand. Gap = `llama / ferrox`. Under 1.0 means Ferrox is faster.

Engine decode on Metal, M2 Pro, measured at v0.12.0 in a single session:

| Model | tg128 Ferrox | tg128 llama.cpp | Gap |
|---|---|---|---|
| Llama-3.2-3B Q4_K_M | 62.7 | 64.7 | 1.03× |
| Llama-3.2-1B Q4_K_M | 149.4 | 149.7 | 1.00× |
| OLMoE-1B-7B Q4_0 | 152.0 | 151.6 | 1.00× |
| Mistral-7B Q4_K_M | 32.9 | 32.4 | 0.99× |
| Gemma-3-1B Q8_0 | 96.5 | 83.4 | 0.86× |
| Qwen2.5-0.5B Q8_0 | 212.9 | 131.2 | 0.62× |

Metal is at or past llama.cpp on both tests. Every dense `pp512` row lands between 0.98× and 1.10×, 8 of the 12 `tg128` rows are ahead, and no Metal row is red. OLMoE reaches parity on prefill and decode as well, so MoE is no longer the column I did not want to publish.

CPU is the whole remaining gap, and Ferrox loses across it: all 16 comparable rows land between 1.41× and 5.06×. The cause is measured. Rayon forks and joins per operation while llama.cpp runs a persistent thread pool, and Ferrox is ahead at a single thread on Mistral-7B, so it scales badly rather than computing slowly. A replacement pool is written and waiting on a clean benchmark window.

Re-run it yourself:

```bash
ferrox bench --suite --fit-host --skip-missing
```

It stops rather than time a run on a machine too busy, too hot, or too short on memory for the number to mean anything. If there is no receipt, the table says so. I do not invent numbers.

## What I learned so far

A few things that stuck, after many evenings staring at tok/s:

- **Decode and prefill are different problems.** Getting tg128 to parity did not make pp512 follow. Prefill needed its own answer: simdgroup-MMA flash attention, batched GEMM, and a fused command encoder that runs a whole layer without returning to the host.
- **MoE Metal needs its own path.** A dense kernel wearing a MoE costume loses. Expert placement, `mul_mm_id` and fused encode groups took OLMoE to parity on both tests.
- **Fair comparison is harder than it looks.** Forcing both engines to the same thread count made llama.cpp look worse on this Mac, because it already prefers performance cores. The suite no longer forces `-t`.
- **CUDA was quietly broken.** `--features cuda` on the CLI did not enable CUDA in `ferrox-core`. Prefill never hit the GPU.

*Update: CUDA compiles and runs, and nobody has benchmarked it. No pinned host, no receipts, so treat a Windows or Linux install as CPU-only in practice. Saying that plainly in the docs was easier than pretending otherwise.*

None of this is glamorous. It is the work.

## What is next

From the [roadmap](https://github.com/antonellof/ferrox/blob/main/docs/ROADMAP.md):

1. CPU, the widest remaining gap, with the persistent thread pool ready to measure.
2. Run bigger models on the same hardware (Qwen3 35B-A3B-class on a box that today only likes 8B). Expert streaming has to return the right tokens first.
3. Hybrid CPU/GPU expert placement, and tighter KV.
4. CUDA tuning. It builds and runs, with no serious pass yet.
5. Grammar and JSON-schema constrained decoding, Docker images.

If you want to point an IDE or agent at the local server, there is a short cookbook: [`docs/AGENTS_COOKBOOK.md`](https://github.com/antonellof/ferrox/blob/main/docs/AGENTS_COOKBOOK.md).

## AI full disclosure

This software is developed with strong assistance from Cursor, Grok 4.5, GPT 5.6, and Claude Fable 5, with humans leading the ideas, testing, and debugging. We say this openly because it shaped how the project was built. If you are not happy with AI-developed code, this software is not for you.

The acknowledgement below is equally important: this would not exist without llama.cpp and GGML, largely written by hand.

## Acknowledgements to llama.cpp and GGML

Ferrox does not link against GGML, but it exists thanks to the path opened by the [llama.cpp](https://github.com/ggml-org/llama.cpp) project and the kernels, quantization formats, GGUF ecosystem, and hard-won engineering knowledge developed there. We are thankful and indebted to llama.cpp and its contributors. Their implementation, kernels, tests, and design choices were an essential reference while building this pure-Rust GGUF / MoE inference path.

Some source-level pieces are retained or adapted here under the MIT license, notably IQ quantization codebook tables, and many other pieces (GGUF layouts, quant/dot semantics, CLI and server conventions) were written independently against that public design. For this reason, and because we are genuinely grateful, we keep the GGML authors' copyright notice in [`docs/THIRD_PARTY_NOTICES.md`](https://github.com/antonellof/ferrox/blob/main/docs/THIRD_PARTY_NOTICES.md).

## Closing

Ferrox is Apache-2.0. Stars are nice. PRs and failed pins are more useful. If you try it and something is slow or wrong, open an issue with the GGUF name, backend, and the `ferrox bench` output.

**Links**
- [github.com/antonellof/ferrox](https://github.com/antonellof/ferrox)
- [ferrox-inference on crates.io](https://crates.io/crates/ferrox-inference)
- [benchmarks/RESULTS.md](https://github.com/antonellof/ferrox/blob/main/benchmarks/RESULTS.md)
- [docs/FEATURES.md](https://github.com/antonellof/ferrox/blob/main/docs/FEATURES.md)
- [docs/MODELS.md](https://github.com/antonellof/ferrox/blob/main/docs/MODELS.md)
- [docs/THIRD_PARTY_NOTICES.md](https://github.com/antonellof/ferrox/blob/main/docs/THIRD_PARTY_NOTICES.md)
- [HN discussion](https://news.ycombinator.com/item?id=49180302)

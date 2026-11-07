---
layout: post
title: "Rust Inference Engine: How to Run AI Models in Rust"
date: 2026-11-07
categories: [Deep Dive]
tags: [Rust, Inference, LLM Inference, ONNX, Candle, GGUF, llama.cpp, RAG, MLOps, AI Engineering]
image: /assets/images/posts/rust-inference-engine-header.jpg
description: "What a Rust inference engine does, when to use one, and how ort, Candle, mistral.rs, llama.cpp bindings and Frink compare for LLM, RAG and embedding work."
excerpt: "A practical guide to model inference in Rust: what a Rust inference engine does, what the language really buys you, and how ort, Candle, tch-rs, llama.cpp bindings, mistral.rs and Frink compare for LLMs, embeddings and RAG."
---

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-engine-header.jpg' | absolute_url }}" alt="Rust Inference Engine. Model weights in ONNX, GGUF or safetensors format flow into an engine, which produces tokens, vectors and scores.">
</figure>

A **Rust inference engine** runs a trained model from Rust code: an LLM, an embedding model, a classifier or a recommender. You give it weights and input, and it gives you tokens, vectors or scores back. (This post is about machine learning inference. If you came here for the compiler's type inference, that is a different topic.)

Rust has become a common choice for this layer. Most teams still train in Python, then look for something faster, smaller and easier to deploy to serve the result. I spend most of my time on that serving side, and I have been building [Frink](https://github.com/antonellof/frink), a pure-Rust LLM inference engine, since the summer. Building one taught me which of the usual claims about Rust hold up and which need a footnote.

This post covers what an inference engine does, where Rust helps, the main ways to run models in Rust today, and how to choose between them.

## What an inference engine does

Whatever the model, a call goes through the same stages. For an LLM behind an API, it looks like this:

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-request-path.png' | absolute_url }}" alt="One inference call through a Rust serving stack. A user query reaches an API server built with Axum or Actix, then the tokenizer, then inference on ONNX, GGUF or Candle, where the engine handles weights, the forward pass, the KV cache, sampling and batching. Vector search with pgvector or Qdrant is optional. The LLM response streams back token by token.">
  <figcaption>The path of one request through a Rust inference stack.</figcaption>
</figure>

The engine is the part in the middle. It loads the weights, runs the forward pass, and for an LLM manages the KV cache and the sampling loop. A serious one also handles what happens when many requests arrive at once: batching, queueing and memory. If you want the mechanics of a single LLM call, I wrote them up in the [LLM inference roadmap](/2026/llm-inference-learning-roadmap/).

## Python for training, Rust for inference

The typical split looks like this:

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-training-vs-serving.png' | absolute_url }}" alt="Python trains and Rust serves. Training needs the ecosystem: PyTorch, TensorFlow, CUDA tooling and research code. Inference and serving need efficiency: latency, throughput per dollar, RAM, startup time and easy deployment.">
  <figcaption>Training and serving optimise for different things.</figcaption>
</figure>

Training depends on an ecosystem that Rust won't replace any time soon: PyTorch, TensorFlow, CUDA tooling, and years of research code. Serving has different needs. You care about latency, throughput per dollar, RAM, startup time, and how easily the thing deploys, and Rust is strong on all of those.

## What Rust buys you, and what it doesn't

The usual list says Rust is fast, memory efficient, safe, concurrent and easy to deploy. All of that is broadly true, but each item has conditions.

**Speed comes from the kernels.** Writing an engine in Rust doesn't make it fast. Most inference time is spent in tight loops over matrices, and those run as fast as the SIMD, Metal or CUDA code behind them. PyTorch's kernels aren't written in Python either. Frink shows this well. On an M2 Pro (v0.20) it [decodes faster than llama.cpp](https://github.com/antonellof/frink/blob/main/benchmarks/RESULTS.md) on the same file, because Metal is where the kernel work went first. On CUDA, in the last run on an RTX 3090 (v0.21), it was 25x to 43x slower at prefill, in the same language.

**Memory and overhead are real wins.** There is no garbage collector, no interpreter and no large runtime sitting beside the model. The weights still take what they take, but everything around them shrinks. That matters most on edge devices and in services that scale to many small replicas.

**Concurrency is where serving gets better.** Async Rust handles thousands of open streams on a few threads, and the type system rejects data races at compile time. Python's GIL is the usual limit on the other side. Native code can release it during a forward pass, so the limit mostly hits the request handling around the model. Python 3.14 also made the [free-threaded build officially supported](https://peps.python.org/pep-0779/), although it is optional and the GIL is still the default. One Rust-specific trap: inference blocks the CPU, so keep it off the async workers, with `spawn_blocking` or a dedicated thread, or your other streams will stall.

**Safety stops at the FFI boundary.** Safe Rust rules out use-after-free and data races. It can't protect you inside a C++ library you call, so `ort`, `tch-rs` and llama.cpp bindings can all still segfault. GPU kernels also need `unsafe` code in any language, and in a pure-Rust engine that code is yours to get right. Rust won't catch a model that computes the wrong answer either, and that was the bug I worried about most in Frink. Each architecture there is checked against llama.cpp's own logits, and anything without that evidence refuses to load.

**The single binary is a big deal, with one condition.** Copying one file to a server and running it beats matching Python wheels against CUDA drivers. Frink ships as a 23 MB binary on macOS arm64, including the server. PyTorch alone is 402 MB. That only holds if you avoid large native dependencies, though. `tch-rs` still needs libtorch, and `ort` needs ONNX Runtime.

## How to run AI models in Rust

There are six main routes, and the first thing to compare is what each one brings along at runtime.

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-six-routes.png' | absolute_url }}" alt="Six ways to run a model in Rust. ort: embeddings, classifiers, BERT and production APIs, ONNX format, needs ONNX Runtime. Candle: transformers in a pure Rust stack, safetensors and GGUF, no native runtime. tch-rs: reusing PyTorch models and code, TorchScript, needs libtorch. llama.cpp bindings: local LLMs from a Rust app, GGUF, needs llama.cpp. mistral.rs: LLMs and multimodal models ready to serve, safetensors and GGUF, no native runtime. Frink: GGUF models as a llama.cpp replacement, no native runtime.">
  <figcaption>The main Rust inference options, by what they load and what they depend on.</figcaption>
</figure>

### ONNX inference in Rust with ort

For anything that isn't a large LLM, this is my default. You export the model once and run it from Rust:

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-onnx-flow.png' | absolute_url }}" alt="ONNX inference in Rust in three steps: train the model in PyTorch, export a fixed graph to an ONNX file, then load it with ort on ONNX Runtime. A good fit for embeddings, BERT, classifiers and rerankers.">
  <figcaption>Export once, then every inference call runs from Rust.</figcaption>
</figure>

[ONNX Runtime](https://onnxruntime.ai) is mature, and `ort` wraps it with execution providers for CUDA, CoreML and others. It fits embeddings, BERT, classifiers and rerankers, where the graph is fixed and the job is a single forward pass. Make sure the GPU provider is really enabled, because a missing Cargo feature can leave you on the CPU without an obvious error. Also note that `ort` 2.0 is still published as a release candidate.

If you want ONNX with no native dependency at all, [tract](https://github.com/sonos/tract) is the small, self-contained option.

### Candle: pure Rust from Hugging Face

[Candle](https://github.com/huggingface/candle) is Hugging Face's minimalist ML framework, with native Rust tensors and no Python dependency. It is lightweight, it pairs naturally with the `tokenizers` crate, and it runs Llama, Mistral, Phi and Gemma models. Choose it when you want to write the model code yourself in Rust, or embed a transformer in an application. It is a framework more than a server, so batching and an API are up to you.

If you also want training in Rust, look at [Burn](https://github.com/tracel-ai/burn), which covers both.

### tch-rs: PyTorch bindings

[tch-rs](https://github.com/LaurentMazare/tch-rs) gives you Rust bindings to PyTorch's C++ API. It makes sense when a model only exists in PyTorch form and you want it behind a Rust service without re-implementing it. The price is libtorch, which is exactly the dependency many teams are trying to leave behind.

### llama.cpp bindings

[llama.cpp](https://github.com/ggml-org/llama.cpp) has the widest model and hardware coverage of any local engine, and crates like [llama-cpp-rs](https://github.com/utilityai/llama-cpp-rs) bring it into Rust. This is the low-risk way to run local LLMs today: you get a proven engine and keep your application in Rust. You also keep a C++ build and its FFI boundary. I compared it with vLLM and SGLang in [three approaches to LLM inference](/2026/llama-cpp-vllm-sglang-inference-tools/).

### Pure-Rust LLM inference engines

The last group reimplements the whole engine in Rust. [mistral.rs](https://github.com/EricLBuehler/mistral.rs) is the biggest project here by GitHub stars, with broad multimodal support and an OpenAI-compatible server. Google results for "Rust inference engine" also turn up newer projects like [Atlas](https://github.com/Avarok-Cybersecurity/atlas), [xinfer](https://github.com/guoqingbao/xinfer) and [Crane](https://github.com/lucasjinreal/Crane), so this space is moving quickly.

One item you will still see in older tutorials: the [`llm` crate from rustformers](https://github.com/rustformers/llm) was archived in June 2024 and is unmaintained. Skip it for new work.

## Frink: a Rust inference engine for GGUF models

[Frink](https://github.com/antonellof/frink) (first released as Ferrox) is my entry in that last group. It loads GGUF checkpoints and runs them on CPU, Apple Metal or CUDA, with no bindings to llama.cpp and no ggml wrapper. I want it to be what you run instead of llama.cpp, with the same models and the same commands.

```bash
curl -fsSL https://raw.githubusercontent.com/antonellof/frink/main/scripts/install.sh | bash

# Fetch a model and serve an OpenAI-compatible API
frink serve -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 8192 --alias local

# Compare it with llama.cpp on your own machine
frink bench -m model.gguf -p 512 -n 128 -r 3 --compare
```

Your existing OpenAI client can point at it unchanged. The server also answers Anthropic Messages and the Responses API, does continuous batching, and shares a prefix cache across conversations. On an M2 Pro, a shared 757-token system prompt reuses 736 tokens from that cache, which took time to first answer from 938 ms to 410 ms. If you want the engine as a library, it is on crates.io as [`frink-inference`](https://crates.io/crates/frink-inference).

It isn't the right pick for everything. As of the [latest benchmarks](https://github.com/antonellof/frink/blob/main/benchmarks/RESULTS.md), Metal is where it is strongest, while CPU trails llama.cpp and CUDA trails it by a lot, and those CUDA rows are overdue for a re-run. There is no Vulkan backend yet, so AMD and Intel GPUs are out. 101 architectures run with evidence behind them, and any other architecture stops with an error saying what is missing. The [full comparison with llama.cpp](/2026/frink-rust-alternative-to-llama-cpp/) has the details, and [the first post](/2026/frink-rust-gguf-inference-engine/) covers why I started it.

Building an engine yourself is a good way to learn, but most teams shouldn't. Pick an existing one unless you have a problem they can't solve. Mine was running mixture-of-experts models that don't fit in memory.

## RAG architecture in Rust

RAG is one of the best fits for Rust, because most of the request is concurrent I/O around a few inference calls:

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-rag-architecture.png' | absolute_url }}" alt="RAG architecture in Rust. A frontend calls a Rust API built with Axum, then embedding inference with fastembed, ort, Text Embeddings Inference or Frink, then vector search with pgvector or Qdrant, then retrieved chunks build the prompt, then LLM inference produces a streamed response. Embedding and LLM steps are inference, the others are I/O.">
  <figcaption>Two inference calls, with concurrent I/O around them.</figcaption>
</figure>

The pieces already exist. [Axum](https://github.com/tokio-rs/axum) for the API, [tokenizers](https://github.com/huggingface/tokenizers) for tokenization, and [fastembed](https://github.com/Anush008/fastembed-rs) for local embeddings. [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) covers embeddings as a separate service, and [qdrant-client](https://github.com/qdrant/rust-client) talks to [Qdrant](https://github.com/qdrant/qdrant), which is written in Rust as well.

Frink can cover the model side of this too. Point it at a BGE, E5 or GTE checkpoint and `/v1/embeddings` serves it, and a cross-encoder answers `/v1/rerank`.

## Rust vs Python for inference

<figure>
  <img src="{{ '/assets/images/posts/rust-vs-python-inference.png' | absolute_url }}" alt="Rust vs Python for inference. Python has faster development with a huge ecosystem and usually supports new models first. Rust has lower memory overhead, excellent concurrency where Python is limited by the GIL by default, often deploys as a single binary, and catches more failures at compile time.">
  <figcaption>Python wins on speed of development, Rust on running it in production.</figcaption>
</figure>

The kernels are native on both sides, so Python is often not the bottleneck during the forward pass. [vLLM](https://github.com/vllm-project/vllm) and [SGLang](https://github.com/sgl-project/sglang) are mostly Python, and both are built for large GPU fleets. Rust earns its place in the layers around the model, and on hardware where a Python stack is too heavy.

## A good stack for production RAG

If I were starting a RAG product today:

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-rag-stack.png' | absolute_url }}" alt="A production RAG stack by layer. Training and fine-tuning: Python and PyTorch. API, gateway and orchestration: Rust and Axum. Embeddings and reranking: ort or Text Embeddings Inference. Vector search: Qdrant or pgvector. LLM on a GPU fleet: vLLM or SGLang. LLM on your own hardware: llama.cpp or Frink.">
</figure>

The GPU fleet row stays outside Rust on purpose. At that scale what matters is scheduling and KV cache management, and the mature engines have a long lead there. Everything around that model is a good candidate for Rust.

## When to use a Rust inference engine

Rust is a strong fit for:

- RAG pipelines and embedding APIs
- AI gateways and streaming APIs
- High-QPS inference and low-latency systems
- Edge AI, and anywhere a small binary matters
- Apps that embed a model, like desktop tools and CLIs

I'd stay with Python if you change models every week, depend on research code, or have a small team that doesn't already know Rust.

## What big companies do

Many production AI systems follow the same split: Python for training, and C++, Rust or Go for serving. When you serve millions of requests, efficiency starts to matter more than training ergonomics.

You can see this in the projects themselves. [NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo) describes itself as "Built in Rust for performance, Python for extensibility". Hugging Face's `tokenizers` has a Rust core under its Python package, and Text Embeddings Inference has [Candle and ONNX Runtime backends](https://github.com/huggingface/text-embeddings-inference/tree/main/backends). Rust is usually one layer of the stack, working next to Python and C++, and that seems to me the sensible way to adopt it.

## FAQ

### Is Rust good for LLM inference?

Yes, particularly for the server, scheduling and application layers, and for local inference on consumer hardware. The speed depends on the engine's kernels, so benchmark the engine itself on your hardware.

### What is the best Rust inference engine?

It depends on the workload. I'd use `ort` for embeddings and classifiers, Candle to write model code in Rust, llama.cpp bindings for the widest local coverage, mistral.rs for multimodal serving, and Frink for GGUF models on Apple Silicon or a llama.cpp replacement with no C++.

### Can Rust run GGUF models?

Yes. llama.cpp bindings, Candle, mistral.rs and Frink all load GGUF. Frink is built around it, and uses llama.cpp's flags, so commands from a model card work unchanged.

### Can you run LLM inference in Rust without Python?

Yes. Candle, mistral.rs and Frink all run without a Python runtime. You may still use Python once to export or convert the model.

### Should you rewrite your Python inference service in Rust?

Usually not all of it. Measure first. If the time goes to the model, a rewrite won't help much. If it goes to request handling, tokenization or memory overhead, move those parts first.

## Where this is heading

The AI stack may settle into something like this:

<figure>
  <img src="{{ '/assets/images/posts/rust-inference-future-stack.png' | absolute_url }}" alt="A possible future AI stack: Python for training, Rust for inference, and Go for distributed systems.">
</figure>

Rust is becoming one of the most important languages in AI infrastructure, mostly in that middle line. If you want to try it on a model you already use, [Frink](https://github.com/antonellof/frink) installs in one command, and `frink bench --compare` will show you how it does on your own machine.

---
layout: post
title: "LLM Inference: a learning roadmap"
date: 2026-09-23
categories: [Deep Dive]
tags: [LLM, Inference, Transformers, GPU, KV Cache, vLLM, SGLang, llama.cpp]
excerpt: "What a call actually does, the transformer math underneath, why the GPU is the constraint, the optimizations that exist because of that, and the engines that ship them — in the order I teach them."
---

Most conversations I have about language models are not about training. They are about what happens after you hit send: where the time goes, why the second token is a different problem from the first, and why a fast GPU can still feel slow. I have rebuilt that explanation enough times that I wanted a durable version of it.

This post is that version. Five layers, in the order I walk people through them: the call itself, the transformer computation, the hardware that bounds it, the optimizations that exist because of those bounds, and the engines that ship the optimizations. Each section has a goal, a handful of concepts, and the resources I keep sending.

I used AI to help organize the structure. The concepts and the links are the ones I use when I explain this myself.

![LLM Inference Learning Roadmap, in five parts: foundations of a call, transformer concepts, GPU and hardware, optimization techniques, and inference engines](/assets/images/posts/llm-inference-roadmap.jpg)

## 1. Foundations of LLM inference

The goal here is simple: understand what happens when you make an LLM call.

![Prefill builds the KV cache in parallel, then decode generates one token at a time using that cache](/assets/images/posts/llm-inference-01-foundations.png)

You send text. The tokenizer turns it into integer ids, the embedding table turns those ids into vectors, and a forward pass turns the vectors into a distribution over the next token. Sampling picks one. That token is appended, and the model runs again. That loop is autoregressive generation. The model emits one token, then another, until it stops.

The loop has two phases, and they are different problems.

**Prefill** runs the prompt. Those tokens can be processed together, and this pass builds the KV cache: the keys and values attention will need later. Prefill is what you wait through before the first word appears.

**Decode** runs one new token at a time. The model computes a query for that token and attends against keys and values it already stored. It appends one new key and one new value, then repeats. This is the phase that streams.

The **KV cache** is why decode is affordable. Keys and values of earlier tokens do not change when a new token arrives, so keeping them avoids recomputing attention over the whole history at every step. The cache still grows with layers, heads, and context. On a long prompt it can be larger than the weights, and it is often what runs you out of memory.

Two latency numbers fall out of the two phases.

- **TTFT**, time to first token. Queueing plus prefill. A long prompt shows up here.
- **ITL**, inter-token latency. The gap between tokens once generation has started, which is one decode step. **TPOT**, time per output token, is the same idea averaged over the reply.

**Throughput** is tokens per second across the server, usually with many requests in flight. **Latency** is how long one of those requests feels. A server can post a great throughput number and still make a single user wait, and the optimizations later in this post exist to move one of those without wrecking the other.

Two resources cover this ground well:

- Mark Moyou, [Mastering LLM Inference Optimization From Theory to Cost Effective Deployment](https://www.youtube.com/watch?v=9tvJ_GYJA-o). An AI Engineer talk from NVIDIA, and the one I send first.
- Hugging Face, [LLM Inference at scale with TGI](https://huggingface.co/blog/martinigoyanes/llm-inference-at-scale-with-tgi).

## 2. Basic transformer concepts

The goal: understand the computation happening during inference.

![Self-attention takes input tokens, projects them into Q, K, and V, and produces output tokens](/assets/images/posts/llm-inference-02-transformer.png)

A transformer block is the same function stacked many times. Attention, then a feed-forward network, with a residual connection and a normalization around each. Embeddings are the lookup that turns token ids into the vectors the first block consumes. The last projection turns the final vectors back into logits over the vocabulary.

The piece worth actually seeing is self-attention. Each token is projected into a **query**, a **key**, and a **value**. The query of one token is compared with the keys of the tokens it is allowed to see, those scores become weights, and the output is a weighted sum of the values. The causal mask means a token only sees itself and the past.

That is the KV cache in computation form. Decode projects Q, K, and V for the new token only, and reuses the keys and values already stored for the prefix.

[Brendan Bycroft's LLM Visualizer](https://bbycroft.net/llm) is the resource for this section. Watch one token move through one block. The formulas stick once you have seen the shapes.

## 3. GPU and hardware fundamentals

The goal: understand the hardware constraints behind inference performance.

![GPU memory hierarchy: SM talking to SRAM talking to HBM](/assets/images/posts/llm-inference-03-gpu.png)

A GPU is a grid of streaming multiprocessors. Each **SM** runs a large number of threads against a small amount of fast on-chip memory, **SRAM**. The big memory, **HBM**, sits off-chip. It holds the weights and the KV cache. It is large, and it is slow next to SRAM and next to how fast the SMs can do arithmetic.

**FLOPS** is how much math the chip can issue per second. **Bandwidth** is how many bytes of HBM it can read per second. Which ceiling you hit depends on arithmetic intensity: operations per byte you had to move. High intensity is **compute-bound**. Low intensity is **memory-bound**.

A single-token decode step reads essentially the whole weight matrix to produce one token. A lot of bytes, not much math, so decode is memory-bound and bandwidth sets tokens per second. A long prefill reuses each loaded weight across many tokens, so the same matmul can be compute-bound. A kernel that speeds up prefill can leave decode untouched. A number measured on one phase says little about the other.

Read these before any optimization writeup:

- Horace He, [Making Deep Learning Go Brrrr From First Principles](https://horace.io/brrr_intro.html). This is the one that turns "memory-bound" into a calculation.
- Damek Davis, [Basic facts about GPUs](https://damek.github.io/random/basic-facts-about-gpus/).

## 4. Inference optimization

The goal: learn how modern systems make inference faster and more efficient.

![Inference optimization as a speedometer: fewer bytes moved, less wasted memory, a fuller GPU](/assets/images/posts/llm-inference-04-optimization.png)

Every technique here is a response to the constraints above. Fewer bytes of weights, less wasted KV memory, less traffic to HBM, and a scheduler that keeps one request from blocking the rest.

**Quantization.** Store the weights in fewer bits. A memory-bound decode moves fewer bytes per token and gets faster, up to the point where the model gets worse. The implementations worth using dequantize inside the matmul. Expanding the weights back to FP16 first spends the memory you just saved.

**PagedAttention.** Allocate the KV cache in fixed-size pages instead of one contiguous slab per request. Same idea as virtual memory. A request that generated forty tokens no longer reserves a max-context buffer, and the rest of the GPU stops fragmenting around those reservations.

**KV cache optimization.** Paging is one move in a larger family. Quantize the cache, share pages across requests that start with the same prefix, and drop tokens you can show you do not need. On a long context the cache is the memory budget, so this is where long-context serving is won or lost.

**FlashAttention.** Exact attention that never writes the full score matrix to HBM. The limit is that traffic, and tiling keeps the working set in SRAM.

**Chunked prefill.** A long prompt can occupy the GPU long enough to freeze everyone else's decode. Split the prefill into chunks and interleave them with decode steps, so inter-token latency stays bounded while the long prompt is still being read.

**Speculative decoding.** A cheap drafter proposes several tokens. The target model checks that block in one forward pass and keeps the prefix it agrees with, then samples the following token itself. When the drafter is often right, one target pass yields several tokens. When it is wrong, that pass still yields one. With the right rejection rule, the samples match ordinary decoding.

**Prompt caching.** Agents, tools, and RAG keep sending the same prefix: a system prompt, a tool list, a retrieved document. Compute that prefix's KV once and reuse the pages. The cost that remains is the new suffix.

**Continuous batching.** A static batch waits for the longest sequence in it. Iteration-level batching admits a new request as soon as another finishes a token, so a short request is not stuck behind a long one and the GPU stays full.

NVIDIA's [Mastering LLM Techniques: Inference Optimization](https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/) covers the set in one place. For the mechanism, read the paper behind the technique you are about to touch:

- Quantization: [GPTQ](https://arxiv.org/abs/2210.17323), [AWQ](https://arxiv.org/abs/2306.00978)
- PagedAttention: [Kwon et al.](https://arxiv.org/abs/2309.06180)
- FlashAttention: [Dao et al.](https://arxiv.org/abs/2205.14135)
- Chunked prefill: [Sarathi-Serve](https://arxiv.org/abs/2403.02310)
- Speculative decoding: [Leviathan, Kalman, and Matias](https://arxiv.org/abs/2211.17192)
- Prompt caching: [Prompt Cache](https://arxiv.org/abs/2311.04934)
- Continuous batching: [Orca](https://www.usenix.org/conference/osdi22/presentation/yu)

## 5. Inference engines and serving systems

The goal: understand how the engines work, and where each one excels.

![Inference engines: vLLM, SGLang, TensorRT-LLM, llama.cpp, and more](/assets/images/posts/llm-inference-05-engines.png)

The techniques above are papers until an engine ships them. Three cover most of the conversations I have, and the fourth is the one I am writing.

**[vLLM](https://github.com/vllm-project/vllm)** is the general-purpose, high-throughput server. PagedAttention, continuous batching, a wide model list. For serving traffic, start here. It is the most battle-tested of the three.

**[SGLang](https://github.com/sgl-project/sglang)** is the one that fits shared context. Multi-turn chat, agents, tool calls, RAG. Its radix cache treats prompt caching as the design, which is why a workload that repeats a long prefix behaves differently here than it does on a server that recomputes that prefix every call.

**[llama.cpp](https://github.com/ggml-org/llama.cpp)** is the go-to for CPU and edge deployment. GGUF, quantizations sized for a workstation, and a single binary.

**[Frink](https://github.com/antonellof/frink)** is my own pure-Rust GGUF engine in that same space: dense and MoE, on CPU, Metal, or CUDA, with an OpenAI-compatible server and every speed claim pinned against llama.cpp on the same machine. Building it is why a lot of the earlier sections are concrete for me. I wrote about the design [here](/2026/frink-rust-gguf-inference-engine/) and about catching llama.cpp on Metal [here](/2026/frink-metal-parity-llama-cpp/).

TensorRT-LLM and the hosted stacks sit beside these. Same concepts, different packaging. Once the model does not fit on one GPU, the problem changes shape: you split weights, move activations, and the KV cache has to be partitioned too. [The Shift to Distributed LLM Inference](https://www.bentoml.com/blog/the-shift-to-distributed-llm-inference) is the overview I use for that step.

Two reads for this section:

- Aleksa Gordić, [Inside vLLM: Anatomy of a High-Throughput LLM Inference System](https://www.aleksagordic.com/blog/vllm). The best walk through what the server is actually doing.
- BentoML, [The Shift to Distributed LLM Inference](https://www.bentoml.com/blog/the-shift-to-distributed-llm-inference).

## How to walk it

Section 1, until prefill, decode, and the KV cache are obvious. Then the visualizer, so the attention formulas have shapes. Then Horace, before any optimization post, because those techniques answer a bandwidth question. The NVIDIA overview next, then the paper for the technique you are about to implement. Engines last, once you can picture what their flags are turning on.

## AI full disclosure

I used AI to help organize the structure of this article. The concepts, the order, and the resources are the ones I keep recommending when I explain inference.

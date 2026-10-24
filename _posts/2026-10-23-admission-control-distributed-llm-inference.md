---
layout: post
title: "Admission Control for Distributed LLM Inference"
date: 2026-10-23
categories: [Deep Dive]
image: /assets/images/posts/admission-control-header.jpg
description: "Routing picks a GPU. Admission control decides whether to take the request at all. How vLLM, SGLang, Dynamo, llm-d and others accept, queue, or shed load."
tags: [LLM Inference, Admission Control, Load Shedding, KV Cache, AI Agents, vLLM, SGLang, TensorRT-LLM, NVIDIA Dynamo, llm-d, Ray Serve, Mooncake, Distributed Systems, GPU Orchestration]
excerpt: "Most writing on distributed LLM inference is about routing: which GPU should take a request. The other half is admission control: whether to take it at all. How vLLM, SGLang, TensorRT-LLM, TGI, Dynamo, llm-d, Ray Serve, Mooncake, and Cognitora decide to accept, queue, or shed requests, and why agents need a different approach."
---

<figure>
  <img src="{{ '/assets/images/posts/admission-control-header.jpg' | absolute_url }}" alt="Admission Control for Distributed LLM Inference. Incoming requests of different sizes reach an admission gate that either accepts them onto GPUs with partly filled KV caches, holds them in a bounded queue, or sheds them with 429 and Retry-After.">
</figure>

Most of what I read about distributed LLM inference is about routing. Which GPU should take this request? Ideally the one that already has the prompt's prefix in its KV cache and isn't drowning in work. [SGLang](https://github.com/sgl-project/sglang), [NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo), [llm-d](https://llm-d.ai), the [GKE Inference Gateway](https://cloud.google.com/kubernetes-engine/docs/concepts/about-gke-inference-gateway), and [Cognitora](https://inference.cognitora.dev) all do some form of cache-aware routing now.

Routing has a blind spot, though. It assumes the request can be served somewhere.

On a normal day that stops being true a few times: a batch job kicks off, an agent fans out forty calls, a launch triples traffic. At that point the useful question isn't where to send the request. It's whether to take it at all.

That's admission control. For each incoming request it decides to accept it now, queue it, or shed it, based on free KV cache memory, remaining compute, and concurrency limits. Skip it and queues grow without bound. Tail latency blows up, memory runs out, and clients time out and retry into a system that's already on its knees.

This post covers how admission control works in LLM serving, how the main engines and orchestrators implement it, and why agents need something different.

## Where admission fits

<figure>
  <img src="{{ '/assets/images/posts/admission-control-three-decisions.png' | absolute_url }}" alt="Three decisions, three components. A client request is admitted by the gateway (validation, context budget, KV and token budget, queue capacity, priority), routed by the router (KV prefix overlap, load, power, VRAM, prefill or decode role), and scheduled by the inference engine (continuous batching, token budget, KV block allocation) before reaching the GPU. The gateway sees tenants, priorities, and SLOs but not which GPU holds which prefix. The router sees the whole fleet with telemetry hundreds of milliseconds old. The engine sees its own KV blocks exactly but not the rest of the fleet.">
  <figcaption>Admit, route, schedule: three decisions made by three components, each with a partial view.</figcaption>
</figure>

Every request goes through three decisions. The gateway decides whether to admit it, the router decides which replica gets it, and the engine decides which batch it joins.

Each of those components sees only part of the picture. The engine knows its own KV blocks exactly but nothing about the rest of the fleet. The router sees the fleet, but its numbers are a few hundred milliseconds old. The gateway knows tenants and SLOs but not which GPU holds which prefix.

So admission control ends up as a series of checks spread across all three, not a single gate.

## Why LLMs are harder than web services

For a stateless web service this is mostly solved: a concurrency limit per replica, a rate limit per client, and retries. LLM traffic breaks those tools in four ways.

**Requests vary wildly in cost.** A 50-token chat turn and a 120,000-token repository prompt are both "one request", but the second needs thousands of times more prefill compute and KV memory. A limit of 64 concurrent requests tells you very little.

**You don't know the output length up front.** KV memory grows with every generated token until the model stops, so the engine has to decide before it knows how much memory the request will need. It can reserve for the worst case and waste memory, or overcommit and evict later.

**Replicas aren't interchangeable.** The one that served turn 5 of an agent session holds 30,000 tokens of reusable cache. Send turn 6 somewhere else and you recompute all of it. Cache affinity is great for efficiency, and it also piles load onto the same few nodes.

**Queued work goes stale.** A request that has waited 40 seconds has probably been abandoned by its client, so if the GPU runs it anyway, nobody reads the output. When [TGI](https://github.com/huggingface/text-generation-inference) users asked why they kept getting "Model is overloaded", the maintainers [explained](https://github.com/huggingface/text-generation-inference/issues/439) that refusing early beats serving old requests that are going to time out anyway.

Put together, you get a goodput cliff. Past saturation, tokens per second hold steady or even rise, but the share of requests that meet their latency target collapses, because everyone is waiting behind everyone else. Admission control keeps you on the right side of that cliff.

## Cache-aware routing needs a way to say no

<figure>
  <img src="{{ '/assets/images/posts/admission-control-prefix-state.png' | absolute_url }}" alt="Cache-aware routing: the longest contiguous prefix wins. Against a request split into five chained blocks, replica A holds B0 to B3 and scores 4, replica B holds B0 and B1 and scores 2, and replica C holds only B3 and B4, which are unusable without B0, so it scores 0. SGLang, Dynamo, llm-d, and Cognitora each get prefix state from a different source. Every router then blends prefix overlap with load, and under saturation still returns the least-bad node.">
  <figcaption>Only the longest unbroken prefix counts. Replica C holds two blocks but can reuse none of them.</figcaption>
</figure>

A quick recap. The router splits the prompt into token blocks and chains their hashes, so each block's hash covers everything before it. Attention is causal, so a replica can reuse block *i* only if it also holds every block before it. What counts is the longest unbroken prefix, not how many blocks match.

Every router then mixes that prefix score with load. In Cognitora it's a weighted sum:

<figure>
  <img src="{{ '/assets/images/posts/admission-control-score-formula.png' | absolute_url }}" alt="Cognitora routing score: score = 0.55 O + 0.25 (1 − q/64) + 0.10 (1 − P/P_max) + 0.10 F, where O is the KV prefix overlap from 0 to 1, q the engine queue depth, P the power draw against its cap P_max, and F the share of KV cache that is free.">
  <figcaption>Prefix overlap carries most of the weight, but load, power, and free memory pull traffic away from hot nodes.</figcaption>
</figure>

llm-d does something similar with weighted scorers, plus an affinity filter that breaks stickiness when the sticky pods get much slower than the rest.

That handles moderate imbalance. Under saturation, though, the weighted sum still picks a winner, the least-bad node, and the request lands in yet another long queue.

> Routing always returns a node. Only admission control can return none.

## What "busy" means on a GPU

Admission is only as good as its load signal, and request count is the worst one available. The signals that work measure what actually runs out:

- **KV cache utilization**, the closest proxy for the memory limit. llm-d treats 0.8 as saturated by default, and Dynamo deployments often use about 0.85.
- **KV cache hit rate.** A full cache with a falling hit rate is churning, not working. This one comes back in the agent section.
- **Queued prefill tokens**, which predict time to first token far better than request count. [vLLM](https://github.com/vllm-project/vllm)'s `max_num_queued_tokens` and Dynamo's prefill-token threshold use it.
- **In-flight tokens**, which llm-d's token-load scorer uses in place of request counts.
- **Engine queue depth**: cheap and fast to read, but blind to request size.
- **Power draw and hardware fit**, so a node near its watt cap, or a 24 GB card, doesn't get a 70B model's traffic.

## Five layers of admission

<figure>
  <img src="{{ '/assets/images/posts/admission-control-five-layers.png' | absolute_url }}" alt="The five layers of an admission pipeline, cheapest first. 1, request validation: reject malformed, unauthorized, or out-of-range requests with 400 to 422. 2, context and budget: does input_tokens plus max_output_tokens fit the context window? 3, token budget and KV cache: can GPU memory hold the request now? Wait, preempt, or skip busy nodes. 4, queue capacity: is the waiting room full? Shed fast with 429, 503, or 529 and Retry-After. 5, priority and flow control: shed sheddable tiers first to protect high-priority traffic.">
  <figcaption>The five checks, cheapest first. Most systems implement some of them, few implement all five.</figcaption>
</figure>

In practice admission control is a sequence of checks, cheapest first. Products order them a little differently, but the same five keep showing up.

### 1. Validation

Reject anything that should never reach a GPU: bad JSON, unknown models, missing credentials, oversized bodies, out-of-range parameters. TGI bounds things like `--max-best-of` and `--max-stop-sequences` and returns 422, Dynamo caps body size, and per-key rate limits belong here too. It costs microseconds.

### 2. Context and budget

Check that the request fits the model's context window: *input tokens + max output tokens ≤ context window*. vLLM returns 400 when it doesn't, TGI 422.

This layer matters more than it looks, because `max_tokens` is the worst-case KV reservation. A client that asks for 32,000 tokens and stops after 200 makes conservative schedulers hold memory for nothing. SGLang's [tuning guide](https://docs.sglang.io/docs/advanced_features/hyperparameter_tuning) points at exactly this when KV usage is low but requests are still queueing.

Sensible `max_tokens` defaults per route give you capacity for free.

### 3. KV and token budget

This is the check only LLM serving needs: can the GPU hold this request's KV cache right now without running out of memory or evicting someone? Engines answer it differently:

- **vLLM** caps `max_num_seqs` and `max_num_batched_tokens`, overcommits memory, and preempts and recomputes a request when it runs out.
- **SGLang** predicts how much running requests will grow (tunable with `--schedule-conservativeness`) and retracts requests when the guess turns out wrong.
- **[TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM)** lets you choose. `GUARANTEED_NO_EVICT`, the default, reserves enough for every admitted request to finish. `MAX_UTILIZATION` packs harder and pauses requests when memory runs out.

That last choice has a real cost. One [benchmark on v1.2.1](https://github.com/NVIDIA/TensorRT-LLM/issues/16827) saw `MAX_UTILIZATION` lose 40% of its throughput, with 9x worse p99 time per output token, under memory pressure. The gap mostly closed in 1.3.0rc22, but the point stands: overcommitting only pays while eviction stays rare.

At the fleet level, [Dynamo](https://docs.nvidia.com/dynamo/user-guides/fault-tolerance/request-rejection) marks a worker busy when its decode KV usage or active prefill tokens cross a threshold, and llm-d's saturation detector does the same with KV utilization and queue depth.

One gotcha from the Dynamo docs: decode-block thresholds only work if output tokens are counted (`--router-track-output-blocks`). The most common failure is a threshold that never fires because load events aren't reaching the frontend.

### 4. Queue capacity

The engine's memory check decides who runs next, not who waits, so something has to cap the waiting room. Here's how the main systems do it:

- **TGI** has done this since 2023 with `--max-concurrent-requests` (default 128) and a 429.
- **vLLM**'s queue was [unbounded for a long time](https://github.com/vllm-project/vllm/issues/18826). It now has `max_num_queued_reqs`, which returns 503, and `max_num_queued_tokens`, which caps the prompt tokens waiting for prefill.
- **SGLang** has `--max-queued-requests`.
- **[Ray Serve](https://docs.ray.io/en/latest/serve/index.html)** has `max_queued_requests`, with a 503 or 429 plus `Retry-After`.
- **Dynamo** returns 529 when every worker is busy, and can also hold requests in a router queue and route them later with fresher metrics.
- **Cognitora** counts in-flight requests per model and role (prefill, decode, or both), so a burst of long prompts can't eat the capacity short chat turns need.

The vLLM docs suggest sizing the token cap as *target TTFT × prefill throughput*. That turns a queue limit into a latency budget, and it's my favourite knob in this whole space.

### 5. Priority and flow control

The last layer decides who gets whatever capacity is left. llm-d and the [Gateway API Inference Extension](https://gateway-api-inference-extension.sigs.k8s.io/) go furthest here.

Requests wait in the gateway, sorted by tenant and priority band. A dispatcher picks by priority, then by fairness within a band, and nothing goes out while the saturation detector says the pool is full. Negative-priority requests are sheddable, protected ones are never displaced, and every queued request has a TTL that clients can shorten with a header.

Inside the engines, vLLM and SGLang both support priority scheduling. When SGLang's queue is full, it drops the lowest-priority waiting request instead of the new one if the new one outranks it. Cognitora can also shed low-priority traffic while grid carbon intensity is high, which pushes deferrable batch work to cleaner hours.

Under this layer sits a real design question: where should the queue live? Queue in each engine and batching stays efficient, but a request stuck in replica A's queue can't move when B frees up first. Queue centrally and you keep control over priority and placement.

The [llm-d flow control guide](https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/site-src/guides/flow-control.md) recommends a small "healthy buffer" on each engine to keep batches full, with everything else held in the gateway. I think that's the right default.

## Admitting only what can meet its SLO

The five layers ask whether there's room. A better question is whether this particular request can still meet its latency target. If it can't, rejecting it right away helps everyone, including the caller, who can retry elsewhere.

[Mooncake](https://github.com/kvcache-ai/Mooncake), the system behind Moonshot's Kimi, does this in production with separate prefill and decode pools. Two lessons from [the paper](https://arxiv.org/abs/2407.00079) stuck with me.

First, check decode capacity before prefill starts, or every request rejected at decode has wasted its prefill.

Second, use predicted load, not current load. Rejecting on current decode load made the two pools oscillate: prefill accepted a wave, decode filled up a few seconds later, everything got rejected, decode drained, and the cycle repeated. Predicting decode load for the moment the request would actually arrive fixed it.

Cognitora has a cruder version: estimate time to first token from the node's queue depth, and reject if that blows the deadline. Research goes much further:

- [SCORPIO](https://arxiv.org/abs/2505.23022) rejects requests whose deadlines can't be met and reports up to 14.4x more goodput.
- [SLOs-Serve](https://arxiv.org/abs/2504.08784) reroutes them or serves them best-effort instead.
- [JITServe](https://www.usenix.org/conference/nsdi26/presentation/zhang-wei) and [Cascade](https://arxiv.org/abs/2608.06557) give each request just enough capacity to hit its target.

Utilization tells you the GPU is busy. Feasibility tells you whether a request is worth starting.

## Agents change the unit of admission

Everything so far treats each request as independent. Agents don't work that way.

An agent generates, calls a tool, waits, and comes back with a longer context. While the tool runs, its KV cache sits idle, and request-level admission has no idea that the idle 40,000-token prefix belongs to someone who'll be back in two seconds.

<figure>
  <img src="{{ '/assets/images/posts/admission-control-concur-aimd.png' | absolute_url }}" alt="CONCUR agent-level admission. Left, schematic: through a long middle phase, KV cache usage stays near full while the hit rate collapses. Right: the active-agent window grows by alpha when KV usage is low, is multiplied by beta when usage is high and hit rate is low, and holds otherwise (defaults alpha 2, beta 0.5). Key numbers: over 90% of run time in the middle phase, 49.1% of latency spent on recomputation, hit rate falling to 35% for SGLang alone and 32% with a request-level cap, and throughput gains of 4.09x on Qwen3-32B and 1.9x on DeepSeek-V3.">
  <figcaption>CONCUR sizes the set of active agents like a TCP congestion window, driven by KV usage and hit rate.</figcaption>
</figure>

[CONCUR](https://arxiv.org/abs/2601.22705) (PMLR 2026) calls the result middle-phase thrashing. In traces of DeepSeek-V3 agents, prefixes are shared early on and hit rates approach 90%. Then contexts grow, KV usage sits near full, and the hit rate collapses, because paused agents lose their cache while they wait and recompute it when they return.

Recomputation took 49.1% of end-to-end latency, and this phase lasted over 90% of the run. The GPU isn't out of memory in the usual sense. It's full of state that gets evicted just before it's needed. A request-level cap didn't help much either: the hit rate still fell to 32%.

CONCUR admits agents instead of requests. It grows the active set slowly while KV usage is low and halves it when usage is high and the hit rate is low. Agents only pause between steps, so nothing is interrupted mid-generation. It reports up to 4.09x throughput on Qwen3-32B.

> Hit rate is an admission signal. The right number of concurrent agents is lower than what the KV pool can technically hold.

[TAPER](https://arxiv.org/abs/2605.06914), released as [PACE](https://github.com/Swapnil-Gandhi/pace), applies the same idea inside a single request. When a reasoning method splits its output into parallel branches, running them all at once slows the shared decode step for everyone in the batch. TAPER admits an extra branch on each step only if its predicted latency cost fits the batch's slack, and reports 1.48x more goodput than running every branch eagerly.

A naming note to avoid confusion: agent papers also use "memory admission control", as in [A-MAC](https://arxiv.org/abs/2603.04549), and it means something else entirely. It decides what an agent writes to long-term memory, scoring each candidate on utility, confidence, novelty, recency, and content type.

It has nothing to do with GPU queues, though the two are connected: every memory you store ends up in future prompts, so a noisy memory store means longer contexts and more KV pressure later.

## Side by side

Here's where each system puts its admission checks, from single engines up to fleet orchestrators and agent-level schedulers.

<figure>
  <img src="{{ '/assets/images/posts/admission-control-systems-compared.png' | absolute_url }}" alt="Admission control across the stack. vLLM and SGLang cover context, KV, queue, and priority. TensorRT-LLM covers KV through its reservation policy. TGI covers validation, context, and queue. Ray Serve covers queue. NVIDIA Dynamo covers validation, KV, queue, and priority and returns 529 when all workers are busy. llm-d covers KV, queue, and priority with gateway flow control. Cognitora covers validation, queue, priority, and SLO checks. Mooncake rejects early based on predicted SLO attainment. CONCUR admits at agent level using KV usage and hit rate. TAPER / PACE admits branches within a request against a latency slack budget.">
  <figcaption>No single system covers every layer. Most stacks combine an engine with a gateway or router.</figcaption>
</figure>

## What I'd take away

- **Run the cheap checks first**, and admit before you send the first byte of a stream. Once you've returned 200 and opened an event stream, you can't send a 429 anymore.
- **Cap `max_tokens`.** It's the cheapest capacity you'll ever get.
- **Measure load in tokens and KV blocks**, and watch hit rate as well as utilization.
- **Treat cache affinity as a source of load.** A sticky node at 95% KV usage should stop attracting traffic, even if it holds the perfect prefix.
- **Budget prefill and decode separately** in disaggregated setups, and check both before prefill starts.
- **Expect stale telemetry and oscillation.** Prediction, AIMD-style windows, and hysteresis all help.
- **Decide on purpose what happens when metrics disappear.** llm-d stops dispatching, while Cognitora's carbon check keeps serving. Either is fine, as long as it's a choice.
- **Make rejections easy to act on.** Tell "overloaded, retry" apart from "invalid, don't", send `Retry-After`, and back off with jitter in clients.
- **Let callers mark what can wait.** Batch and eval jobs should almost always be sheddable.

## Where I'd start

For a fleet of vLLM replicas behind a cache-aware router:

1. Authenticate, rate-limit per key, and cap request size at the gateway.
2. Set `max_model_len` deliberately, and use per-route `max_tokens` defaults well below it.
3. Tune `max_num_seqs` and `max_num_batched_tokens`, watch the preemption counter, and mark replicas busy at around 0.8 to 0.85 KV usage.
4. Set `max_num_queued_reqs`, size `max_num_queued_tokens` as *target TTFT × prefill throughput*, and return 429 or 529 with `Retry-After`.
5. Mark interactive traffic as protected and batch work as sheddable, with a queue TTL shorter than the client timeout.

If agents make up a lot of your traffic, also cap concurrent agents, and lower that cap when the hit rate drops.

Then alert on goodput, meaning the share of requests that hit their latency targets, rather than raw throughput. And load-test past saturation on purpose. How a system behaves at 150% of capacity tells you more than its peak tokens per second.

---

*Related reading: [LLM Inference: a learning roadmap](https://www.fratepietro.com/2026/llm-inference-learning-roadmap/), [llama.cpp, vLLM, and SGLang: Three Approaches to LLM Inference](https://www.fratepietro.com/2026/llama-cpp-vllm-sglang-inference-tools/), [Cognitora v0.9.1: gossip discovery, live KV prefix, and a native engine](https://www.fratepietro.com/2026/cognitora-inference-update-v0.9/), and [Google Cloud agentic AI architecture: private inference networking](https://www.fratepietro.com/2026/google-cloud-agentic-ai-architecture-private-inference-networking/).*

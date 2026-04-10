---
layout: post
title: "MARS: GPU-Resident Memory for Real-Time Embodied AI"
date: 2026-04-10
categories: [Systems]
tags: [CUDA, GPU, Real-Time Systems, Autonomous Vehicles, Robotics, Memory, Vector Search]
excerpt: "Why FAISS and cuVS fail at sensor-rate retrieval, and how a GPU-resident memory substrate with kernel-fused temporal decay meets sub-millisecond deadlines for autonomous vehicles, robots, and AR/VR."
---

Every real-time AI system -- autonomous vehicles, humanoid robots, AR/VR headsets -- needs to answer the same question thousands of times per second: *what do I already know that's relevant to what I'm seeing right now?*

That's a memory retrieval problem. And every production stack today solves it with a bespoke C++ circular buffer, hand-tuned per project, per modality, per deadline. Waymo has one. Figure has one. Apple Vision Pro has one. Tesla Optimus has one.

I built [MARS](https://github.com/antonellof/MARS) to investigate whether a general-purpose GPU-resident substrate can replace them.

**[Read the full paper (PDF)](https://www.fratepietro.com/papers/MARS/main.pdf)**

## The gap nobody talks about

FAISS GPU and cuVS CAGRA are excellent at what they do: find the K most similar vectors in a static corpus. But real-time perception isn't a static corpus. Sensor data streams in at 30-1000 Hz. Older detections become irrelevant. New ones must be queryable immediately.

I ran two experiments on an A100 SXM4 to quantify this:

**Experiment 1 -- Temporal relevance.** 9,000 memories across 200 tracked objects in an AV perception scenario. FAISS Flat returned results where 49.3% of top-10 entries were stale -- older than the current tracking window. Its Temporal Precision@10 was 0.218. MARS, with temporal decay fused directly into the retrieval kernel, scored 0.910.

**Experiment 2 -- Streaming insertion.** 60 Hz frame rate, 10 new detections per frame. FAISS (rebuilding every 1 second) missed 93.2% of recent detections because pending inserts remain invisible until index rebuild. MARS sees 100% immediately.

These aren't edge cases. They're the default behavior of every GPU search library when you put it in a sensor-rate loop.

## Four CUDA kernels, sub-millisecond

MARS stores text, audio, image, and sensor embeddings in a shared 768-D space as nodes in a Neural Shortcut Network (NSN) with cross-modal bridges. The retrieval pipeline runs entirely on GPU-resident data:

1. **cuBLAS SGEMV** -- cosine similarity via matrix-vector multiply
2. **Temporal rerank** -- `score * exp(-lambda * age)`, fused per-element
3. **CUB radix sort** -- parallel top-K selection
4. **Warp-cooperative BFS** -- cross-modal graph expansion via the NSN

The key insight: temporal decay and importance scoring happen *inside* the retrieval kernels, not as a post-processing step. This eliminates the extra round-trip that makes "FAISS + post-hoc rerank" impractical at 60 Hz.

## Measured results

Same-hardware comparison on A100 SXM4 80GB (D=768, K=10, single-query p99):

| System | N=2.4K | N=10K | N=50K | Temporal | Streaming |
|--------|--------|-------|-------|----------|-----------|
| FAISS GPU Flat | 0.10 ms | 0.12 ms | 0.35 ms | No | No |
| FAISS GPU IVF | 0.13 ms | 0.15 ms | 0.28 ms | No | No |
| cuVS CAGRA | 2.60 ms | 2.29 ms | 2.47 ms | No | No |
| **MARS** | **0.26 ms** | **0.34 ms** | **0.44 ms** | **Yes** | **Yes** |

MARS GPU kernel time (0.10 ms at N=2.4K) matches FAISS Flat. The wall-clock gap is kernel launch overhead from the additional temporal rerank and importance stages.

All four demonstrator p99 deadlines met:

| Workload | Rate | Budget | Measured p99 |
|----------|------|--------|-------------|
| AV perception | 60 Hz | 1 ms | 0.87 ms |
| Humanoid robot | 1 kHz | 1 ms | 0.76 ms |
| AR/VR spatial | 90 Hz | 5 ms | 1.56 ms |
| Voice agent | 30 Hz | 20 ms | 0.88 ms |

## The Neural Shortcut Network

What makes MARS more than "FAISS with a timestamp column" is the graph structure. Memories are nodes in a CSR-format graph built in five phases:

1. Ring lattice (k=6 local neighbors)
2. Hierarchical skip connections (powers of 2)
3. Hub supernodes at sqrt(N) intervals
4. Small-world rewiring (Watts-Strogatz, p=0.15)
5. **Cross-modal bridges** -- every node gets one edge to each other modality

Phase 5 is the critical one. It means a query that starts with an audio embedding can reach relevant visual and text memories through graph traversal, without maintaining separate per-modality indices. The warp-cooperative BFS kernel explores these bridges in the same sub-millisecond budget.

## What it's not

MARS is not a vector database. It's not competing with Pinecone or pgvector. Same conceptual layer -- indexing, similarity, retrieval -- but different latency envelope, different durability model, different deployment target. Think cuBLAS vs LAPACK: same operations, different hardware.

The working set is seconds to hours of recent sensor data, bounded to fit in GPU VRAM. For billion-record archives, use a vector DB. For the hot working memory of a system that needs to make decisions 60 times per second, that's what MARS is for.

## Scaling to 1M memories

The FP16 + CUDA Graph extension scales to 1M memories at 6.5 ms p99 on a $449 RTX 5060 Ti. At that point you're covering roughly 15 minutes of multi-sensor data at AV rates -- more than enough working memory for any real-time loop.

## Try it

```bash
git clone https://github.com/antonellof/MARS.git
cd MARS
make tests        # host-only unit tests, no GPU needed
make && make check  # full build + hardware validation on any CUDA GPU
```

The code is MIT licensed. The [paper](https://www.fratepietro.com/papers/MARS/main.pdf) has the full methodology, kernel pseudocode, and ablation studies.

I'm particularly interested in feedback from anyone building real-time perception pipelines. The hypothesis -- that a general-purpose GPU-resident substrate can replace bespoke circular buffers -- needs validation from people who've actually shipped those buffers.

**Links:**
- [Paper (PDF)](https://www.fratepietro.com/papers/MARS/main.pdf)
- [GitHub repository](https://github.com/antonellof/MARS)
- [Architecture deep dive](https://github.com/antonellof/MARS/blob/main/docs/ARCHITECTURE.md)
- [Benchmark results](https://github.com/antonellof/MARS/blob/main/docs/BENCHMARKS.md)

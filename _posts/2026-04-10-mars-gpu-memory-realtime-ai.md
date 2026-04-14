---
layout: post
title: "MARS: GPU-Resident Memory for Real-Time Embodied AI"
date: 2026-04-10
categories: [Systems]
tags: [CUDA, GPU, Real-Time Systems, Autonomous Vehicles, Robotics, Memory, Vector Search]
excerpt: "A child's ball rolls into the road. Vision sees only the ball — but 600 ms ago, microphones captured children's voices from that direction. MARS is a GPU-resident retrieval substrate that surfaces cross-modal, temporally relevant memories at sensor rate."
---

A child's ball rolls into the road from behind a parked van. The vehicle's camera sees only the ball. But 600 ms earlier, the microphones captured children's voices from that same direction — a memory that, if retrievable now, raises the prior that a child may follow the ball into the street.

The useful memory is 600 ms old, from a different modality than the query, and low in cosine similarity compared to countless irrelevant alternatives. No ranking by similarity alone can surface it.

I built [MARS](https://github.com/antonellof/MARS) to investigate whether a GPU-resident retrieval substrate can handle this kind of query at sensor rate — 60 Hz, sub-millisecond, across modalities.

**[Read the full paper (PDF)](https://www.fratepietro.com/papers/MARS/main.pdf)**

## What existing libraries do well — and where they stop

FAISS GPU and cuVS CAGRA are excellent at finding the K most similar vectors in a static corpus. For streaming perception, temporal awareness requires an additional post-hoc filter: fetch top-K by cosine, then re-rank by recency. This works — a 10-line temporal filter restores precision to 0.910 in our AV experiment.

MARS eliminates that second stage. The three-way comparison on A100 SXM4:

| System | Temporal Precision@10 | p99 latency |
|--------|----------------------|-------------|
| FAISS Flat (cosine only) | 0.218 | 0.13 ms |
| FAISS + post-hoc temporal filter | 0.910 | 0.25 ms |
| **MARS** (native temporal decay) | **0.910** | **0.26 ms** |
| Ring buffer + cuBLAS SGEMV | — | 0.12 ms |

MARS matches FAISS+filter at identical precision and essentially identical latency (0.26 vs 0.25 ms). A raw ring buffer is 3.2x faster (0.12 ms) but provides no temporal decay, cross-modal retrieval, or streaming insertion. The contribution is pipeline simplification, not a capability FAISS lacks.

## Three GPU stages, sub-millisecond

MARS stores text, audio, image, and sensor embeddings in a shared 768-D space as nodes in a Neural Shortcut Network (NSN) with cross-modal bridges. The retrieval pipeline runs entirely on GPU-resident data:

1. **cuBLAS SGEMV + temporal decay** — cosine similarity, then `score × exp(-λ·age)` applied before top-K
2. **CUB radix sort** — parallel top-K selection in O(N)
3. **Warp-cooperative BFS** — cross-modal graph expansion through NSN bridges

On the default path (cuBLAS SGEMV), temporal decay runs as a separate lightweight kernel immediately after SGEMV. On the custom-kernel fallback path, decay is fused directly into the similarity kernel. Both produce identical results. Zero per-query allocation — a pre-allocated `QueryContext` holds all scratch buffers.

## Scaling results

Measured on A100 SXM4 40GB (D=768, K=10, cuBLAS+CUB):

| Corpus | p99 | Status |
|--------|-----|--------|
| 1K | 0.31 ms | Sub-ms |
| 10K | 0.44 ms | Sub-ms |
| 50K | 0.56 ms | Sub-ms |
| 100K | 0.74 ms | Sub-ms |
| 1M | 2.67 ms | Real-time |
| 10M | 22.3 ms | Batch |
| 13M | 29.1 ms | VRAM limit |

All corpus sizes up to 50K pass the 1 ms AV perception deadline with zero misses. The temporal decay ablation: with decay (λ=0.5), p99=0.38 ms; without decay (λ=0), p99=0.28 ms. Temporal awareness costs ~0.10 ms — 32% overhead, leaving 62% headroom within the 1 ms budget.

All four demonstrators pass empirical p99 deadlines:

| Workload | Rate | Budget | Measured p99 | Headroom |
|----------|------|--------|-------------|----------|
| AV perception | 60 Hz | 1 ms | 0.87 ms | 13% |
| Humanoid robot | 1 kHz | 1 ms | 0.76 ms | 24% |
| AR/VR spatial | 90 Hz | 5 ms | 1.56 ms | 69% |
| Voice agent | 30 Hz | 20 ms | 0.88 ms | 96% |

## The Neural Shortcut Network

What makes MARS more than "cuBLAS with a timestamp column" is the graph structure. Memories are nodes in a CSR-format graph built in five phases:

1. Ring lattice (k=6 local neighbors)
2. Hierarchical skip connections (powers of 2)
3. Hub supernodes at √N intervals
4. Small-world rewiring (Watts-Strogatz, p=0.15)
5. **Cross-modal bridges** — every node gets one edge to each other modality

Phase 5 is critical: a query starting with an audio embedding reaches visual and text memories through graph traversal, without separate per-modality indices. The warp-cooperative BFS kernel explores these bridges in <0.04 ms. The ablation shows the NSN improves structural cross-modal diversity from 0.50 to 0.80 at N=50K — though we note this measures structural reachability, not semantic relevance.

## What it's not

MARS is not a vector database. Same conceptual layer — indexing, similarity, retrieval — but different latency envelope, different durability model, different deployment target. Think cuBLAS vs LAPACK: same operations, different hardware. The working set is seconds to hours of recent sensor data, bounded to fit in GPU VRAM.

This is also soft real-time, not hard real-time. The evaluation shows empirical p99 compliance with zero deadline misses over 30-second runs. True hard real-time (ISO-26262 ASIL-D) would require provable worst-case bounds, which MARS does not provide.

## Try it

```bash
git clone https://github.com/antonellof/MARS.git
cd MARS
make tests          # host-only unit tests (17/17, no GPU needed)
make && make check  # full build + hardware validation
make demo-av        # 60 Hz AV perception demo
```

The code is MIT licensed. The [paper](https://www.fratepietro.com/papers/MARS/main.pdf) has the full methodology, kernel pseudocode, ablation studies, and three rounds of reviewer feedback incorporated.

I'm particularly interested in feedback from anyone building real-time perception pipelines. The hypothesis — that a general-purpose GPU-resident substrate can replace bespoke circular buffers — needs validation from people who've actually shipped those buffers.

**Links:**
- [Paper (PDF)](https://www.fratepietro.com/papers/MARS/main.pdf)
- [GitHub repository](https://github.com/antonellof/MARS)
- [Architecture deep dive](https://github.com/antonellof/MARS/blob/main/docs/ARCHITECTURE.md)
- [Benchmark results](https://github.com/antonellof/MARS/blob/main/docs/BENCHMARKS.md)

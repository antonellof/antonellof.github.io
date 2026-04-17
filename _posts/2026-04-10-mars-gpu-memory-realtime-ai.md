---
layout: post
title: "MARS: GPU-Resident Memory for Real-Time Embodied AI"
date: 2026-04-10
modified_date: 2026-04-17
categories: [Systems]
tags: [CUDA, GPU, Real-Time Systems, Autonomous Vehicles, Robotics, Memory, Vector Search]
excerpt: "A child's ball rolls into the road. Vision sees only the ball — but 600 ms ago, microphones captured children's voices from that direction. MARS is a GPU-resident retrieval substrate that surfaces cross-modal, temporally relevant memories at sensor rate. Update 2026-04-17: episode-scoped retrieval delivers a perfect-recall multimodal answer in 200 µs at N=1M, 33× faster than FAISS-Flat-GPU."
---

A child's ball rolls into the road from behind a parked van. The vehicle's camera sees only the ball. But 600 ms earlier, the microphones captured children's voices from that same direction — a memory that, if retrievable now, raises the prior that a child may follow the ball into the street.

The useful memory is 600 ms old, from a different modality than the query, and low in cosine similarity compared to countless irrelevant alternatives. No ranking by similarity alone can surface it.

I built [MARS](https://github.com/antonellof/MARS) to investigate whether a GPU-resident retrieval substrate can handle this kind of query at sensor rate — 60 Hz, sub-millisecond, across modalities.

**[Read the full paper (PDF, 1.9 MB)](https://www.fratepietro.com/papers/MARS/main.pdf)** — last rebuilt 2026-04-17.

> **Update — 2026-04-17.** Two structural improvements landed since the original
> April-10 paper revision:
>
> 1. **Episode-scoped retrieval** (`RetrievalScope::EpisodeScoped`) restricts the
>    cosine sweep to the members of a known episode (a track id, a session id,
>    a sub-task id) and skips the cross-modal BFS altogether. Result: a
>    **near-flat 200 µs p99** from N=10K all the way to N=1M, with **perfect
>    cross-modal recall**.
> 2. **Hand-fused FP16 cosine kernel** (`--use-fp16` opt-in) — a 41 % speedup
>    at N=10K (memory-bound regime) but a 49 % regression at N=1M, because
>    cuBLAS `Sgemv` exploits Tensor-Core paths the hand-fused kernel cannot
>    match once the working set spills out of L2. The build keeps
>    cuBLAS as the default and FP16 as a small-N opt-in.
>
> Same paper now also includes a **head-to-head benchmark against FAISS-GPU
> 1.14.1 (Flat + IVF) and cuVS CAGRA 26.04** on identical A100 SXM4 40 GB
> hardware with paired-RNG seeding. The takeaway: cosine-only ANN baselines
> collapse on the multimodal-episode metric at scale (CAGRA `hit@15`=0 at
> N≥10⁵), and only MARS Episode-scoped is simultaneously below the 1 ms
> AV deadline and at perfect recall everywhere. Full artefacts in
> [`results/competitors_20260417/SUMMARY.md`](https://github.com/antonellof/MARS/blob/main/results/competitors_20260417/SUMMARY.md).

## What existing libraries do well — and where they stop

FAISS GPU and cuVS CAGRA are excellent at finding the K most similar vectors in a static corpus. For streaming perception, temporal awareness requires an additional post-hoc filter: fetch top-K by cosine, then re-rank by recency. This works — a 10-line temporal filter restores precision to 0.910 in our AV experiment.

MARS eliminates that second stage. The original three-way comparison on A100 SXM4:

| System | Temporal Precision@10 | p99 latency |
|--------|----------------------|-------------|
| FAISS Flat (cosine only) | 0.218 | 0.13 ms |
| FAISS + post-hoc temporal filter | 0.910 | 0.25 ms |
| **MARS** (native temporal decay) | **0.910** | **0.26 ms** |
| Ring buffer + cuBLAS SGEMV | — | 0.12 ms |

MARS matches FAISS+filter at identical precision and essentially identical latency (0.26 vs 0.25 ms). A raw ring buffer is 3.2× faster (0.12 ms) but provides no temporal decay, cross-modal retrieval, or streaming insertion. The contribution is pipeline simplification, not a capability FAISS lacks.

## Head-to-head against modern GPU ANN libraries (2026-04-17)

The April update reframes the comparison around the embodied multimodal contract: the query is an IMAGE node and we measure `hit@15` of the same-episode TEXT *and* AUDIO neighbors (kids-ball corpus, paired RNG seed=2026, A100 SXM4 40 GB).

![Head-to-head competitor benchmark](/papers/MARS/figures/fig_competitors.png)

| System | N=10K p99 / hit@15 | N=100K p99 / hit@15 | N=1M p99 / hit@15 |
|--------|------------------:|--------------------:|------------------:|
| FAISS Flat-GPU (exhaustive) | 0.18 ms / **1.00** | 0.78 ms / **1.00** | 6.64 ms / **1.00** |
| FAISS IVF-GPU (nprobe=64)   | 0.45 ms / 0.52     | 0.60 ms / 0.37      | 1.42 ms / **0.00** |
| cuVS CAGRA (graph_degree=64) | 3.32 ms / **1.00** | 3.23 ms / 0.01     | 3.25 ms / **0.00** |
| MARS Global (FP32 cuBLAS)   | 0.47 ms / 0.83     | 0.67 ms / 0.79      | **2.51 ms** / 0.84 |
| MARS Global (FP16 fused)    | **0.28 ms** / 0.83 | 0.66 ms / 0.79      | 3.73 ms / 0.84    |
| **MARS Episode-scoped**     | **0.19 ms / 1.00** | **0.20 ms / 1.00**  | **0.20 ms / 1.00** |

Two findings drove the design:

- **MARS Episode-scoped is Pareto-dominant** at every N: 33× faster than FAISS Flat at 1M and 16× faster than CAGRA, both at perfect recall. When the application can supply an episode handle, restricting the kernel to episode members converts a Θ(N · D) cosine sweep into a Θ(|episode| · D) kernel that the A100 finishes in 200 µs independent of N.
- **Cosine ANN baselines collapse on this metric at scale.** The kids-ball corpus has tiny clusters (10 nodes per episode, 100 K episodes at 1M), so per-episode TEXT/AUDIO neighbors are buried among ~999 990 distractors. CAGRA's graph traversal (even at `search_k`=512) and IVF cells (any `nprobe`) miss them. MARS keeps episode membership in the graph topology and recovers them in O(member_count). FAISS Flat alone keeps recall at N=10⁶ because it is exhaustive — at 6.64 ms p99 it sits 6.6× past the 1 ms AV deadline.

## Episode-scoped retrieval is near-flat

![Episode-scoped scaling](/papers/MARS/figures/fig_episode_scoped_scaling.png)

The episode-scoped curve grows by only ~19 % as N goes from 10⁴ to 10⁶, because the GPU work is bounded by the episode size (~10 members), not by N. At N=1M the path delivers **197 µs p99** wall-clock — below every per-frame deadline including the 1 ms AV budget — while returning a perfect-recall multimodal answer.

When does the contract apply? Episode scope is correct only when the right episode is known *before* the query. It is the natural contract for AV per-track re-identification (track id is the episode), voice-agent turn taking (session id is the episode), AR/VR per-room recall (room id is the episode), and embodied task loops (current sub-task id is the episode). It is **not** correct for open-ended global semantic search — but that workload has the wider deadline (10–100 ms) where the global path or a cosine ANN baseline already fits.

## Two contracts, one GPU-resident substrate

![Pipeline](/papers/MARS/figures/diag_pipeline.png)

MARS stores text, audio, image, and sensor embeddings in a shared 768-D space as nodes in a Neural Shortcut Network (NSN) with cross-modal bridges. Two contracts share the same GPU-resident data:

**Global path** (when no episode handle is available): three stages, sub-millisecond at N ≤ 50K, zero per-query allocation.

1. **Stage 1 — Cosine + temporal decay.** Default: cuBLAS `Sgemv` (FP32) followed by `score × exp(-λ·age)`. Opt-in `--use-fp16` switches to the hand-fused FP16 cosine kernel — wins by 41 % at N=10K but loses by 49 % at N=1M.
2. **Stage 2 — CUB radix sort top-K** in O(N).
3. **Stage 3 — Warp-cooperative BFS** through NSN bridges with `atomicCAS` race-free neighbor claiming.

**Episode-scoped fast path** (when `query_episode_id` is supplied): Stage 1 is restricted to the episode's CSR member list and Stage 3 BFS is skipped entirely. The result is the green dashed arc in the diagram above and the near-flat scaling curve in the previous section.

### When FP16 fused beats cuBLAS Sgemv (and when it doesn't)

![FP16 vs cuBLAS crossover](/papers/MARS/figures/fig_fp16_crossover.png)

The hand-fused FP16 cosine kernel is bandwidth-optimal at small N because the entire embedding tile fits in L2 and the dot product becomes memory-bound. cuBLAS `Sgemv` cannot beat that at N=10K. But once N exceeds the L2 working set, cuBLAS's Tensor-Core paths and per-arch tile heuristics dominate — FP16 fused regresses by 49 % at N=1M.

This is one of the more honest findings of the paper: bring-your-own-kernel is not always faster than vendor BLAS, and the crossover point is hardware- and corpus-size dependent. The build defaults to cuBLAS; `--use-fp16` is documented as a small-N opt-in.

## Scaling and deadline compliance

Measured on A100 SXM4 40GB (D=768, K=10, cuBLAS+CUB):

| Corpus | Global path p99 | **Episode-scoped p99** | Status |
|--------|-----:|-----:|--------|
| 1K    | 0.31 ms | — | Sub-ms |
| 10K   | 0.44 ms | **0.19 ms** | Sub-ms |
| 50K   | 0.56 ms | **0.17 ms** | Sub-ms |
| 100K  | 0.74 ms | **0.20 ms** | Sub-ms |
| 1M    | 2.67 ms | **0.20 ms** | Real-time only via Episode-scoped |
| 10M   | 22.3 ms | (mem-bound) | Batch |
| 13M   | 29.1 ms | (mem-bound) | VRAM limit |

Five workloads pass empirical p99 deadlines on A100:

![Deadline compliance](/papers/MARS/figures/fig_deadline.png)

| Workload | Rate | Budget | Measured p99 | Headroom |
|----------|------|--------|-------------:|----------|
| AV perception (N=10K)  | 60 Hz  | 1 ms  | 0.87 ms | 13 % |
| Humanoid robot (N=10K) | 1 kHz  | 1 ms  | 0.76 ms | 24 % |
| AR/VR spatial (N=10K)  | 90 Hz  | 5 ms  | 1.56 ms | 69 % |
| Voice agent (N=10K)    | 30 Hz  | 20 ms | 0.88 ms | 96 % |
| **MARS Episode-scoped (N=1M)** | any | 1 ms | **0.20 ms** | **80 %** |

The last row is the one I'd flag for embodied roboticists: a perfect-recall multimodal answer at sensor rate against a million-memory corpus, with 80 % headroom on the AV deadline.

## The Neural Shortcut Network

What makes MARS more than "cuBLAS with a timestamp column" is the graph structure. Memories are nodes in a CSR-format graph built in five phases:

1. Ring lattice (k=6 local neighbors)
2. Hierarchical skip connections (powers of 2)
3. Hub supernodes at √N intervals
4. Small-world rewiring (Watts–Strogatz, p=0.15)
5. **Cross-modal bridges** — every node gets one edge to each other modality

Phase 5 is critical: a query starting with an audio embedding reaches visual and text memories through graph traversal, without separate per-modality indices. The warp-cooperative BFS kernel explores these bridges in <0.04 ms.

The April update adds a **6th component to the graph store**: an `episode_csr` member list that drives the episode-scoped fast path. It is a per-episode index (uint32 offsets into the embedding array), built once at corpus load time, queried by the new `RetrievalScope::EpisodeScoped` contract.

## What it's not

MARS is not a vector database. Same conceptual layer — indexing, similarity, retrieval — but different latency envelope, different durability model, different deployment target. Think cuBLAS vs LAPACK: same operations, different hardware. The working set is seconds to hours of recent sensor data, bounded to fit in GPU VRAM.

This is also soft real-time, not hard real-time. The evaluation shows empirical p99 compliance with zero deadline misses over 30-second runs. True hard real-time (ISO-26262 ASIL-D) would require provable worst-case bounds, which MARS does not provide.

**One known issue carried into the April update.** The CUDA Graph capture path (`--use-cuda-graph`) currently corrupts results because counters and the episode-scoped reset are not re-initialised between graph replays — captured-graph replays return `hit@15`=0.004 and the next direct launch hits `memory_cuda.cu:1197 — invalid argument`. Tracked in [`docs/ARCHITECTURE.md` §7.4](https://github.com/antonellof/MARS/blob/main/docs/ARCHITECTURE.md) and [paper §11 Future Work](https://www.fratepietro.com/papers/MARS/main.pdf). The hand-fused FP16 path and episode-scoped fast path land cleanly without `--use-cuda-graph`.

## Try it

```bash
git clone https://github.com/antonellof/MARS.git
cd MARS
make tests          # host-only unit tests (19/19, no GPU needed)
make && make check  # full build + hardware validation
make demo-av        # 60 Hz AV perception demo

# Episode-scoped fast path on the kids-ball corpus
./demos/embodied_scene/demo --scope=episode

# Reproduce the head-to-head competitor benchmarks
pip install --extra-index-url=https://pypi.nvidia.com 'cuvs-cu12==26.4.*' faiss-gpu-cu12 cupy-cuda12x
python3 scripts/bench_kids_ball_faiss.py     --corpus results/competitors_20260417/corpus/kids_1m.bin
python3 scripts/bench_kids_ball_cuvs_cagra.py --corpus results/competitors_20260417/corpus/kids_1m.bin
```

The code is MIT licensed. The [paper](https://www.fratepietro.com/papers/MARS/main.pdf) has the full methodology, kernel pseudocode, ablation studies, the new §10.1 (episode-scoped retrieval) and §10.2 (head-to-head against FAISS / cuVS CAGRA) sections, and three rounds of reviewer feedback incorporated.

I'm particularly interested in feedback from anyone building real-time perception pipelines. The hypothesis — that a general-purpose GPU-resident substrate can replace bespoke circular buffers — needs validation from people who've actually shipped those buffers. The episode-scoped contract in particular is a structural bet: every embodied loop I can think of has *some* notion of a current track / room / session / sub-task id, and the data shows that handing that id to the retrieval kernel is worth a 30× speedup at full recall. I'd love counter-examples.

**Links:**
- [Paper (PDF, 1.9 MB)](https://www.fratepietro.com/papers/MARS/main.pdf) — last rebuilt 2026-04-17
- [GitHub repository](https://github.com/antonellof/MARS) — `main` is at the April update
- [Architecture deep dive](https://github.com/antonellof/MARS/blob/main/docs/ARCHITECTURE.md) — includes new §7.1–7.4 (episode-scoped, head-to-head, FP16, known issues)
- [Benchmark results](https://github.com/antonellof/MARS/blob/main/docs/BENCHMARKS.md)
- [Head-to-head competitor SUMMARY](https://github.com/antonellof/MARS/blob/main/results/competitors_20260417/SUMMARY.md) — full FAISS / cuVS CAGRA / MARS run logs
- [Figure-generation script](https://github.com/antonellof/MARS/blob/main/scripts/generate_competitor_figures.py) — re-renders the three new paper figures from the JSON artefacts

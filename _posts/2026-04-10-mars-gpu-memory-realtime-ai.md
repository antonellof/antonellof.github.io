---
layout: post
title: "MARS: Episode-Scoped GPU Retrieval for Real-Time Embodied AI"
date: 2026-04-10
categories: [Systems]
tags: [CUDA, GPU, Real-Time Systems, Autonomous Vehicles, Robotics, Memory, Vector Search]
excerpt: "A child's ball rolls into the road. Vision sees only the ball — but 600 ms ago, microphones captured children's voices from that direction. MARS treats scope, time, and modality as one kernel-level API: ~200 µs episode-scoped retrieval at N=1M, within ~1.3× of filtered FAISS, and 33× below the unfiltered exhaustive sweep stacks without an ID filter run today."
---

A child's ball rolls into the road from behind a parked van. The vehicle's camera sees only the ball. But 600 ms earlier, the microphones captured children's voices from that same direction — a memory that, if retrievable now, raises the prior that a child may follow the ball into the street.

The useful memory is 600 ms old, from a different modality than the query, and low in cosine similarity compared to countless irrelevant alternatives. No ranking by similarity alone can surface it.

An embodied perception stack already knows more than "find me the nearest vector" at query time. It carries an active **track id**, a **dialogue session**, an **AR room**, or a **robot sub-task** — the right answer almost always lives inside that *episode*. [MARS](https://github.com/antonellof/MARS) (*Memory for Autonomous Real-time Systems*) is what you get when that observation becomes a kernel parameter rather than a host-side filter.

**[Read the full paper (PDF)](https://www.fratepietro.com/papers/MARS/main.pdf)**

The defensible claim is narrow and, I think, the interesting one: **one device-resident API consolidating episode scope, temporal decay, cross-modal BFS, and streaming append**, at a latency within about **1.3× of filtered FAISS** (`IDSelectorRange`) and **33× below the unfiltered exhaustive sweep** a stack without an ID filter would run. On the kids-ball benchmark the episode-scoped path is near-flat at **~200 µs p99 from N=10K to N=1M**. Everything else in this post is what that contract buys — and what it does not.

## What existing libraries do well — and where they stop

FAISS GPU and cuVS CAGRA are excellent at finding the K most similar vectors in a static corpus. Their contract is: *over the entire indexed corpus, return the K vectors with highest cosine similarity*. For document retrieval, recommendation, image search — that is the right contract.

Embodied workloads ask a different question: "find any recent sensor evidence, across any modality, relevant to *this current track*." Encoding that as host-side post-filtering on a global ANN sweep wastes GPU work. Without a filter, unfiltered IVF and CAGRA also lose recall at scale on tiny multimodal clusters — a known property of unfiltered ANN, which is exactly why FAISS, cuVS, and Milvus expose filtered search. MARS's contribution is not discovering that failure mode; it is packaging scope + time + modality into one kernel API at deadline-relevant latencies.

A first concrete instance of the same idea is temporal decay. Recency is a first-class ranking signal in a sensor stack — but cosine ANN libraries do not fold it into the kernel:

| System | Temporal Precision@10 | p99 latency |
|--------|----------------------|-------------|
| FAISS Flat (cosine only) | 0.218 | 0.13 ms |
| FAISS + post-hoc temporal filter | 0.910 | 0.25 ms |
| **MARS** (native temporal decay) | **0.910** | **0.26 ms** |
| Ring buffer + cuBLAS SGEMV (N=2,400) | — | 0.12 ms |

MARS matches FAISS+filter at identical TP@10 (0.910) and comparable per-query latency (0.26 ms vs 0.25 ms p99). The 0.01 ms gap is within run-to-run noise on a non-locked-clock A100, so the contribution here is **API consolidation**, not a raw speedup. A raw cuBLAS-only ring buffer is faster still (0.12 ms at N=2,400) — including, on the episode-only case, faster than MARS Episode-scoped (~0.20 ms). What the ring buffer does not provide is the rest of the contract: a global fallback over the same store, cross-modal BFS, tunable kernel-fused decay, and episode membership as a per-query parameter rather than a per-episode data structure.

## Head-to-head against modern GPU ANN libraries

The contract is the embodied multimodal one: the query is an IMAGE node and we measure `hit@15` of the same-episode TEXT *and* AUDIO neighbors (kids-ball corpus, paired RNG seed=2026, A100 SXM4 40 GB). Episodes have 10 nodes; K=15.

![MARS vs FAISS-GPU 1.14.1 vs cuVS CAGRA 26.04: paired bar charts of per-query p99 latency (left, log scale) and same-episode TEXT+AUDIO hit@15 (right) on the kids-ball multimodal contract at N=10K, 100K and 1M, A100 SXM4 40 GB](/papers/MARS/figures/fig_competitors.png)
*Head-to-head wall-clock p99 (left, log scale) and `hit@15` (right). Episode-scoped MARS is the latency winner among plotted systems under the 1 ms AV deadline; its hit@15=1.0 is by construction (`|episode| < K`). The fair filtered-FAISS comparator lands within ~1.3× and is not plotted as a full curve yet.*

| System | N=10K p99 / hit@15 | N=100K p99 / hit@15 | N=1M p99 / hit@15 |
|--------|------------------:|--------------------:|------------------:|
| FAISS Flat-GPU (exhaustive) | 0.18 ms / **1.00** | 0.78 ms / **1.00** | 6.64 ms / **1.00** |
| FAISS IVF-GPU (nprobe=64)   | 0.45 ms / 0.52     | 0.60 ms / 0.37      | 1.42 ms / **0.00** |
| cuVS CAGRA (graph_degree=64) | 3.32 ms / **1.00** | 3.23 ms / 0.008    | 3.25 ms / **0.00** |
| FAISS Flat + IDSelectorRange (prototype) | — / 1.00* | — / 1.00* | **~0.26 ms** / 1.00* |
| MARS Global (FP32 cuBLAS)   | 0.47 ms / 0.83     | 0.67 ms / 0.79      | **2.51 ms** / 0.84 |
| MARS Global (FP16 fused)    | **0.28 ms** / 0.83 | 0.66 ms / 0.79      | 3.73 ms / 0.84    |
| **MARS Episode-scoped**     | 0.19 ms / 1.00*    | **0.20 ms** / 1.00* | **0.20 ms** / 1.00* |

\*hit@15 = 1.0 is **guaranteed by construction** for any episode-restricted search when `|episode| = 10 < K = 15`: the scope *is* the answer set. The informative axis for those rows is latency.

Three readings of the table:

1. **Episode-restricted search is the latency class that fits the 1 ms deadline at N=10⁶.** MARS Episode-scoped finishes in ~200 µs independent of N. The fair comparator is FAISS Flat + `IDSelectorRange` (~0.26 ms in a single unreplicated prototype at N=1M — within ~1.3×). Unfiltered exhaustive FAISS Flat keeps recall but costs 6.64 ms (33×) and misses the deadline. The algorithmic move (restrict an SGEMV to a labelled member range) is small; the contribution is consolidating it with decay, BFS, and streaming append in one API.

2. **Unfiltered cosine ANN collapses on this metric at scale** — a known failure mode, quantified here. IVF and CAGRA find the right neighbors at N=10⁴ but drop to ≤0.4 / 0 hit@15 at N≥10⁵. Widening CAGRA to `search_k`=512 does not recover recall. The corpus is a synthetic near-worst case for unfiltered search; filtered-ANN facilities exist precisely to fix this.

3. **MARS Global is dominated by exhaustive FAISS Flat on this benchmark** at N=10⁴–10⁵: slower and lower hit@15 (0.79–0.84 vs 1.0). Both are exhaustive cosine sweeps, so the gap is post-sweep ranking. Same-episode decay weights are ≈1 on this corpus; the plausible mechanism is the BFS max-rule re-ranking the visited set and promoting graph neighbours over low-ranked same-episode hits. On kids-ball, where ground truth *is* the episode cluster, the added machinery hurts unless you supply the episode id.

> **Synthetic corpus.** Kids-ball uses correlated 768-D clusters (within-episode cosine > 0.85). Real CLIP/CLAP/E5 geometry is lower and anisotropic — a real-encoder run would likely change both absolute recall and baseline ordering. Sequential timestamps (`τᵢ = 0.05·i`) also confound scope with time: oldest distractors at N=1M are demoted ~30–35% by decay, so decay partially proxies episode membership. An interleaved timestamp layout and a `|episode| > K` configuration (so scoped recall is measured, not implied) are the next measurements the paper needs.

## Episode-scoped retrieval is near-flat

![Wall-clock p99 vs corpus size N (log–log) on the kids-ball contract: FAISS Flat-GPU rises and crosses 1 ms by N=10^5, cuVS CAGRA stays under 4 ms but loses recall, MARS Global rises moderately, and MARS Episode-scoped is near-flat at ~200 µs](/papers/MARS/figures/fig_episode_scoped_scaling.png)
*Episode-scoped MARS (green diamonds) is near-flat at ~200 µs across three decades of N. hit@15=1.0 on the scoped path is by construction; the fair filtered comparator lands within ~1.3×. Unfiltered Flat is 33× slower at N=1M.*

The curve grows by only ~19% from N=10⁴ to 10⁶ because GPU work is bounded by episode size (~10 members), not by N. When does the contract apply? When the right episode is known *before* the query: AV per-track re-id, voice-agent sessions, AR room recall, robot sub-tasks. It is not a substitute for open-ended global semantic search — that workload has wider deadlines where the global path or a cosine ANN baseline already fits.

## Two contracts, one GPU-resident substrate

![MARS retrieval pipeline: encoders feed a 768-D space; cuBLAS SGEMV + decay, CUB top-K, and warp-cooperative BFS over a CSR memory graph; green dashed arc for the episode-scoped fast path](/papers/MARS/figures/diag_pipeline.png)
*Two contracts share one GPU-resident CSR graph. The green dashed arc is the episode-scoped fast path: Stage 1 restricted to episode members, BFS skipped.*

**Global path** (no episode handle): four kernels, sub-millisecond at N ≤ 50K, zero per-query allocation.

1. **Stage 1 — Cosine + temporal decay.** Default: cuBLAS `Sgemv` (FP32) followed by `score × exp(-λ·age)`. Opt-in `--use-fp16` wins by 41% at N=10K but loses by 49% at N=1M.
2. **Stage 2 — CUB radix sort top-K.**
3. **Stage 3 — Warp-cooperative BFS** through NSN bridges. Score rule: `score[u] ← max(score[parent] · δ_prop, sim[u] · α_bfs)`. API default `δ_prop = 0.5` (`bfs_score_decay`); the kids-ball harness uses 0.55. Temporal decay is not re-applied during BFS.

**Episode-scoped path** (`query_episode_id` supplied): Stage 1 restricted to the episode CSR member list; BFS skipped. Near-flat ~200 µs scaling.

### When FP16 fused beats cuBLAS (and when it doesn't)

![Bar chart of FP32 cuBLAS vs hand-fused FP16 p99 at N=10K, 100K and 1M: FP16 wins at 10K, loses at 1M](/papers/MARS/figures/fig_fp16_crossover.png)
*Hand-fused FP16 wins where the working set fits in L2; cuBLAS Tensor-Core paths win at large N. Default is cuBLAS; `--use-fp16` is a small-N opt-in.*

Bring-your-own-kernel is not always faster than vendor BLAS. The crossover is hardware- and corpus-size dependent.

## Scaling and deadline compliance

Measured on A100 (D=768, K=10, Round-4 cuBLAS+CUB pipeline):

| Corpus | Global path p99 | **Episode-scoped p99** | Status |
|--------|-----:|-----:|--------|
| 1K    | 0.31 ms | — | Sub-ms |
| 10K   | 0.44 ms | **0.19 ms** | Sub-ms |
| 50K   | 0.56 ms | **0.17 ms** | Sub-ms |
| 100K  | 0.74 ms | **0.20 ms** | Sub-ms |
| 1M    | 2.67 ms | **0.20 ms** | Real-time only via Episode-scoped |
| 10M   | 22.3 ms | (mem-bound) | Batch |
| 13M   | 29.1 ms | (mem-bound) | VRAM limit |

![Horizontal bar chart of measured p99 vs deadline budgets: AV, robot, AR/VR, voice, and episode-scoped at N=1M all PASS](/papers/MARS/figures/fig_deadline.png)
*Deadline compliance for the four demonstrators plus the episode-scoped path at N=1M (~200 µs, 80% headroom on the 1 ms AV budget).*

| Workload | Rate | Budget | Measured p99 | Headroom |
|----------|------|--------|-------------:|----------|
| AV perception (N=10K)  | 60 Hz  | 1 ms  | 0.87 ms | 13 % |
| Humanoid robot (N=10K) | 1 kHz  | 1 ms  | 0.76 ms | 24 % |
| AR/VR spatial (N=10K)  | 90 Hz  | 5 ms  | 1.56 ms | 69 % |
| Voice agent (N=10K)    | 30 Hz  | 20 ms | 0.88 ms | 96 % |
| **MARS Episode-scoped (N=1M)** | any | 1 ms | **0.20 ms** | **80 %** |

All latency numbers above are **single-query**. A real AV stack issues one retrieval per active track per frame (the paper's own temporal experiment uses 200 objects). Batched SGEMM evaluation is still open; until it exists, read these as per-query deadline compliance.

## Measurement caveats

p99s are over 128–256 paired probes on non-locked-clock vast.ai instances. At sub-millisecond scale, run-to-run jitter is on the order of ±10%:

- The 0.26 vs 0.25 ms temporal-decay gap is within noise.
- The ~1.3× vs IDSelector figure is a single unreplicated prototype at one N.
- The episode-scoped latency advantage over *unfiltered* Flat at N=1M (33×) is large enough that jitter does not explain it away; the comparison that matters for the contribution claim is still the filtered one.

The ablation is also candid: at N ≤ 50K, within-modality recall is driven by brute-force cosine + decay — the NSN graph contributes structural cross-modal reachability, not within-modality recall.

## The Neural Shortcut Network

Memories are nodes in a CSR graph built in five phases: ring lattice, hierarchical skips, hub supernodes, Watts–Strogatz rewiring, and **cross-modal bridges** (every node gets one edge to each other modality). Construction is deterministic — no learned weights. Phase 5 guarantees *structural* reachability in one BFS hop; it makes no claim that reached neighbours are semantically relevant. An `episode_csr` member list drives the scoped fast path.

## What it's not

MARS is not a vector database. Same conceptual layer — indexing, similarity, retrieval — different latency envelope, durability model, and deployment target. Think cuBLAS vs LAPACK. The working set is seconds to hours of recent sensor data, bounded to fit in GPU VRAM.

This is soft real-time, not hard real-time: empirical p99 compliance over 30-second runs, not provable WCET for ISO-26262 ASIL-D.

For the episode-only case alone, a per-episode ring buffer plus a small SGEMV remains the production incumbent and is faster. MARS is the bet that consolidating scope, time, modality, and streaming into one substrate is worth the ~80 µs.

## Try it

```bash
git clone https://github.com/antonellof/MARS.git
cd MARS
make tests          # host-only unit tests (no GPU needed)
make && make check  # full build + hardware validation
make demo-av        # 60 Hz AV perception demo

# Episode-scoped fast path on the kids-ball corpus
./demos/embodied_scene/demo --scope=episode

# |episode| > K (measured within-episode ranking) and interleaved time layout
./demos/embodied_scene/bench_kids_sweep --ep-len 50 --time-mode interleaved ...

# Reproduce competitor baselines (includes FAISS + IDSelectorRange)
pip install --extra-index-url=https://pypi.nvidia.com \
  'cuvs-cu12==26.4.*' faiss-gpu-cu12 cupy-cuda12x
python3 scripts/bench_kids_ball_faiss.py \
  --corpus results/competitors_20260417/corpus/kids_1m.bin
```

The code is MIT licensed. The [paper](https://www.fratepietro.com/papers/MARS/main.pdf) has the full methodology, kernel pseudocode, ablations, statistical caveats, and the evaluation-hardening track (starting with `|episode| > K`, the full filtered-FAISS curve, and the interleaved-time generator).

I'm particularly interested in feedback from anyone building real-time perception pipelines. The hypothesis — that an embodied loop's existing notion of *track / room / session / sub-task id* is worth pushing into a GPU kernel parameter, jointly with decay and cross-modal traversal — needs validation from people who have shipped those loops. The kids-ball latency numbers are clear; whether the consolidation matters end-to-end on a real CLIP/CLAP stack is the open question.

**Links:**
- [Paper (PDF)](https://www.fratepietro.com/papers/MARS/main.pdf)
- [GitHub repository](https://github.com/antonellof/MARS)
- [Architecture deep dive](https://github.com/antonellof/MARS/blob/main/docs/ARCHITECTURE.md)
- [Benchmark results](https://github.com/antonellof/MARS/blob/main/docs/BENCHMARKS.md)
- [Head-to-head competitor SUMMARY](https://github.com/antonellof/MARS/blob/main/results/competitors_20260417/SUMMARY.md)

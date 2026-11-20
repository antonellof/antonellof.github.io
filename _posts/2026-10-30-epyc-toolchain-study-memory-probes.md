---
layout: post
title: "Before benchmarking EPYC: memory probes that measure what they claim"
date: 2026-10-30
categories: [Projects]
tags: [HPC, AMD EPYC, Benchmarking, STREAM, HPL, Memory Latency, Compilers, Spack]
image: /assets/images/posts/epyc-probes-latency-m5.png
description: "Starting an EPYC toolchain study: a small harness for HPL, HPCG and STREAM across three toolchains, and two memory probes that were wrong until a local test caught them."
excerpt: "I'm starting a study of how much compiler, math library and node configuration choices change performance on AMD EPYC. Before paying for cloud nodes I built the harness and two memory probes, and the first local run showed that both probes were measuring the wrong thing."
---

How much of an HPC benchmark result comes from the hardware, and how much from the choices made before the run? On an EPYC node the compiler, the BLAS library, the NUMA mode and the way ranks are pinned can each move a number by more than the gap between two CPU generations. I want to measure that properly, so I've started a small study: [epyc-toolchain-study](https://github.com/antonellof/epyc-toolchain-study).

The plan is three toolchains, each in its own Spack environment:

- `zenss`: AOCC with AOCL (BLIS, libFLAME, FFTW), from AMD's Zen Software Studio
- `oneapi`: icx and ifx with MKL
- `gnu`: GCC with OpenBLAS and FFTW

On top of these run HPL, HPCG and STREAM, plus two small probes of my own for memory latency and bandwidth. Every run writes one JSON file holding the result together with the toolchain, the flags, `lscpu`, `numactl -H` and the pinning that produced it. A number without that context is useless six weeks later.

## Test locally first

Cloud EPYC nodes cost money by the hour, so the harness had to work before I rented one. My laptop is an Apple M5 Max, which has nothing in common with Zen 4, but it's a good place to catch bugs in the tools themselves. That paid off quickly: both probes were wrong on the first run.

## Bug one: faster than the timer

The bandwidth probe runs read, write, copy and triad kernels over working sets from a few KiB to several GiB. For the smallest sizes it printed `inf` GB/s. One pass over 64 KiB finishes in a few nanoseconds, below what `clock_gettime` resolves, so the measured time was zero. The fix is to time a batch of passes that takes at least 100 µs and divide by the batch size.

## Bug two: measuring an adder

The read kernel was a plain sum:

```c
for (size_t i = 0; i < n; i++)
    s += a[i];
```

It reached 16 GB/s in L1 and 17 GB/s from DRAM. Bandwidth that doesn't change between L1 and DRAM isn't bandwidth. Every addition depends on the previous one, and without `-ffast-math` the compiler is not allowed to reorder floating-point sums, so it can't vectorise the loop either. The loop runs at the speed of one FP add's latency, whatever the memory does.

With eight independent accumulators the same kernel reaches 94 GB/s in L1 and 92 GB/s from DRAM:

<figure>
  <img src="{{ '/assets/images/posts/epyc-probes-read-accumulators.png' | absolute_url }}" alt="Bar chart of the read kernel on one core of an Apple M5 Max. With one accumulator it reaches 16 GB/s at 64 KiB and 17 GB/s at 128 MiB. With eight accumulators it reaches 94 and 92 GB/s.">
  <figcaption>The same loop, before and after splitting the sum.</figcaption>
</figure>

This mistake matters well beyond my probe. Anyone comparing compilers on a reduction loop can end up comparing how willing each compiler is to reassociate floating-point math, which is a flag choice and not a property of the hardware.

## The latency probe

The latency probe chases pointers through a buffer linked into a single random cycle, one node per 64-byte cache line. Each load depends on the one before it, and the access order defeats the prefetchers. On the M5 Max the steps show up where they should: under a nanosecond up to 128 KiB, then plateaus at about 3 ns and 8 ns, rising to about 100 ns once the working set is far beyond the caches.

<figure>
  <img src="{{ '/assets/images/posts/epyc-probes-latency-m5.png' | absolute_url }}" alt="Load-to-use latency against working-set size on an Apple M5 Max, log scales. About 0.7 ns up to 128 KiB, about 3 ns to 1 MiB, about 8 ns to 12 MiB, then rising to 101 ns at 256 MiB.">
  <figcaption>Pointer-chase latency on the laptop, used here only to check the probe.</figcaption>
</figure>

On EPYC the same probe also runs under `numactl --cpunodebind=0 --membind=1` to measure remote NUMA latency. That number, together with NPS1 vs NPS4, is one of the things I want to see.

## Next

The harness drives the whole matrix from one YAML file: toolchains, flag sets (`-O2` to `-Ofast`, `znver4` vs `x86-64-v3`, 512-bit vector preference, LTO) and runtime layouts such as one HPL rank per CCD or one per core. It generates `HPL.dat` and `hpcg.dat` for each run and keeps going when a single configuration fails.

Next comes the part that usually takes longest in HPC work: getting everything to build. I'm starting with WRF, which is famous for exactly that.

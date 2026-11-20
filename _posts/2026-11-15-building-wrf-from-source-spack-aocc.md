---
layout: post
title: "Building WRF from source with Spack: three traps before the first run"
date: 2026-11-15
categories: [Projects]
tags: [HPC, WRF, Spack, AOCC, AMD EPYC, Fortran, NetCDF, Compilers]
image: /assets/images/posts/wrf-epyc-dependency-stack.png
description: "Building WRF 4.7.1 and its NetCDF/HDF5/MPI chain with Spack 1.x for GCC, AOCC and oneAPI, and the three problems that showed up before anything ran."
excerpt: "WRF is a good test of whether a toolchain is usable: about fifty dependencies, Fortran modules that must come from one compiler, and an interactive configure script. These are the three problems I hit on the way to a working wrf.exe."
---

The second part of my [EPYC toolchain work](/2026/epyc-toolchain-study-memory-probes/) is WRF, a weather model widely used in research and operational forecasting. Weather centres care about time-to-solution, and the choice of compiler and MPI layout shows up directly in it. Before measuring any of that, WRF has to build. The repo is [wrf-epyc](https://github.com/antonellof/wrf-epyc).

## The stack

WRF itself is a single `./configure && ./compile em_real`. Everything underneath comes from Spack, one environment per toolchain (GCC, AOCC, oneAPI):

<figure>
  <img src="{{ '/assets/images/posts/wrf-epyc-dependency-stack.png' | absolute_url }}" alt="WRF dependency stack. WRF 4.7.1 on top. Below it NetCDF-Fortran 4.6.2 and PnetCDF 1.14.1, then NetCDF-C 4.10.0 and HDF5 1.14.6 with MPI, Fortran and high-level APIs, then Open MPI 5.0.10 with PMIx, PRRTE and hwloc, and zlib-ng. 49 packages in the Spack environment.">
  <figcaption>What WRF needs underneath it, as built by Spack 1.2.2 for the GCC toolchain.</figcaption>
</figure>

The GCC environment comes to 49 packages. In a 16-core Linux container, WRF itself then compiled in 519 seconds. Three problems had to be solved first, all outside WRF's own code.

## Trap 1: where the variant goes

In Spack 1.x, compilers are ordinary dependencies, and a variant attaches to whatever comes right before it. `stream %gcc +openmp` asks for a GCC built with `+openmp`, which doesn't exist, so the environment never resolves. It has to be `stream +openmp %gcc`. Spack 0.x accepted either order, so older examples often have it the other way round.

## Trap 2: `%aocc` doesn't mean "everything with AOCC"

In Spack 1.x, `%aocc` makes AOCC the compiler for at least one of a package's languages, and the solver is free to pick something else for the rest. I checked the concretized specs against a stand-in AOCC entry before the real compiler was installed. `amdfftw %aocc` came out as `%c=aocc %fortran=gcc`. `netcdf-fortran %aocc` came out the other way round, `%fortran=aocc %c=gcc`, with NetCDF-C and HDF5 underneath it built entirely by GCC.

For many packages that mix is harmless. Fortran libraries are different: `.mod` files and the Fortran runtime are specific to each compiler, so NetCDF-Fortran should come from the same compiler that builds WRF. I also want one compiler per toolchain for the comparison itself, otherwise it compares a blend.

The fix is a Spack toolchain that pins all three languages to the same compiler:

```yaml
toolchains:
  aocc_all:
  - spec: '%[virtuals=c] aocc'
    when: '%c'
  - spec: '%[virtuals=cxx] aocc'
    when: '%cxx'
  - spec: '%[virtuals=fortran] aocc'
    when: '%fortran'
```

and then `netcdf-fortran %aocc_all`. AOCC and oneAPI also have to be installed before an environment can use them, and AOCC won't install until the `+license-agreed` variant records that you accept AMD's EULA. That step now lives in its own script.

## Trap 3: the configure menu

WRF's `./configure` is interactive and asks you to pick an option by number. The numbers depend on the platform: on the arm64 box, GNU dmpar was option 3, and two separate "GNU (gfortran/gcc)" lines appeared. The menu text comes from the `DESCRIPTION` lines in `arch/configure.defaults`, so the build script captures the menu, finds the line for the toolchain (`GNU (gfortran/gcc)`, `AMD (flang/clang)`, `INTEL (ifx/icx)`) and answers with that number. I checked those three labels against the 4.7.1 source.

## Next

The benchmark case is NCAR's CONUS 12 km input, a 3.2 GB download. The run script can shorten the forecast to a few minutes, because per-step timing is all a scaling study needs. With the GCC build working and the AOCC and oneAPI environments resolving, the next step is putting all three on real EPYC cores.

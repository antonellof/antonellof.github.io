---
layout: post
title: "Building WRF from source with Spack: three traps before the first run"
date: 2026-11-05
categories: [Projects]
tags: [HPC, WRF, Spack, AOCC, AMD EPYC, Fortran, NetCDF, Compilers]
image: /assets/images/posts/wrf-epyc-dependency-stack.png
description: "Building WRF 4.7.1 and its NetCDF/HDF5/MPI chain with Spack 1.x for GCC, AOCC and oneAPI, and the three problems that showed up before anything ran."
excerpt: "WRF is a good test of whether a toolchain is usable: about fifty dependencies, Fortran modules that must all come from one compiler, and an interactive configure script. Here is what broke on the way to a working wrf.exe."
---

The second part of my [EPYC toolchain work](/2026/epyc-toolchain-study-memory-probes/) is WRF, the weather model behind a lot of operational forecasting. Weather centres care about time-to-solution, and the choice of compiler and MPI layout shows up directly in it. Before measuring any of that, WRF has to build. The repo is [wrf-epyc](https://github.com/antonellof/wrf-epyc).

## The stack

WRF itself is a single `./configure && ./compile em_real`. Everything underneath comes from Spack, one environment per toolchain (GCC, AOCC, oneAPI):

<figure>
  <img src="{{ '/assets/images/posts/wrf-epyc-dependency-stack.png' | absolute_url }}" alt="WRF dependency stack. WRF 4.7.1 on top. Below it NetCDF-Fortran 4.6.2 and PnetCDF 1.14.1, then NetCDF-C 4.10.0 and HDF5 1.14.6 with MPI, Fortran and high-level APIs, then Open MPI 5.0.10 with PMIx, PRRTE and hwloc, and zlib-ng. 49 packages in the Spack environment.">
  <figcaption>What WRF needs underneath it, as built by Spack 1.2.2 for the GCC toolchain.</figcaption>
</figure>

The GCC environment comes to 49 packages. In a 16-core Linux container, WRF itself then compiled in 519 seconds. Getting there took three fixes, none of them in WRF.

## Trap 1: where the variant goes

In Spack 1.x, compilers are ordinary dependencies, and a variant attaches to whatever comes right before it. `stream %gcc +openmp` asks for a GCC built with `+openmp`, which doesn't exist, so the environment never resolves. It has to be `stream +openmp %gcc`. It's a small thing, but a lot of older Spack examples are written the other way round.

## Trap 2: `%aocc` doesn't cover Fortran

This one is easy to miss. With `%aocc` on HDF5 and NetCDF-Fortran, the concretized spec showed `%c,cxx=aocc` and `%fortran=gcc`. Spack had quietly picked gfortran for the Fortran parts. In most projects you'd never notice. In WRF the build fails late and confusingly, because Fortran `.mod` files are compiler-specific: flang can't read modules written by gfortran.

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

WRF's `./configure` is interactive and asks you to pick an option by number. The numbers depend on the platform: on the arm64 box, GNU dmpar was option 3, and two separate "GNU (gfortran/gcc)" lines appeared. The menu text comes from the `DESCRIPTION` lines in `arch/configure.defaults`, so the build script captures the menu, finds the line for the toolchain (`GNU (gfortran/gcc)`, `AMD (flang/clang)`, `INTEL (ifx/icx)`) and answers with that number. I checked those three labels against the 4.7.1 source instead of trusting memory, since they change between releases.

## Next

The benchmark case is NCAR's CONUS 12 km input, a 3.2 GB download. The run script can shorten the forecast to a few minutes, because per-step timing is all a scaling study needs. With the GCC build working and the AOCC and oneAPI environments resolving, the next step is putting all three on real EPYC cores.

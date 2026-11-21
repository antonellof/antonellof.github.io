---
layout: post
title: "Can a CFD model find the wind farms? Wind over the Monti Dauni and the Gargano with OpenFOAM"
date: 2026-11-20
categories: [Projects]
tags: [HPC, OpenFOAM, CFD, Spack, AOCC, AOCL, oneAPI, MKL, GCC, MPI, STREAM, HPL, AMD EPYC, Wind Energy, Puglia, ERA5]
image: /assets/images/posts/puglia-wind-mean.png
description: "A terrain-following OpenFOAM model of the Monti Dauni in Puglia, driven by ten years of ERA5 wind and compared with the 504 wind turbines in OpenStreetMap, with OpenFOAM, STREAM and HPL built from source for GCC, AMD AOCC/AOCL and Intel oneAPI/MKL."
excerpt: "The ridges of the Monti Dauni, in northern Puglia, are lined with wind turbines. I built an OpenFOAM model of the terrain from public data only, gave it ten years of ERA5 wind, and checked where it puts the strongest wind against where the turbines actually stand."
---

<figure>
  <img src="{{ '/assets/images/posts/puglia-wind-viewer.jpg' | absolute_url }}" alt="3D view of the Monti Dauni terrain coloured by modelled long-term mean wind speed 100 m above ground, from pale on the plain to dark orange on the ridges, with white wind particles and wind turbines standing along the ridges.">
  <figcaption>The <a href="https://www.fratepietro.com/puglia-wind/">3D viewer</a>: terrain coloured by modelled mean wind 100 m above ground, particles following the solved flow, and the turbines from OpenStreetMap.</figcaption>
</figure>

The Monti Dauni are the Apennine ridge on the western edge of Puglia, where it borders Molise and Campania. Wind turbines line most of their crests. Sites like these are normally chosen after mast measurements and commercial flow modelling.

I wanted to know how far you get with public data and open-source tools only: **if a CFD model knows nothing but the terrain and the regional wind climate, does it put the strongest wind where the turbines are?**

That became [puglia-wind](https://github.com/antonellof/puglia-wind). The short answer is yes, with one caveat that matters, which is further down.

## The pieces

Everything comes from open sources:

- **Terrain:** Copernicus GLO-30, a 30 m elevation model, projected to UTM and cut to a 24 x 24 km square centred on the ridge.
- **Wind climate:** ten years (2015 to 2024) of hourly ERA5 reanalysis at 100 m, through the Open-Meteo archive API. The mean is 4.62 m/s, and the wind comes mostly from 240° (21 % of hours) and 330° (20 %).
- **Turbines:** every node tagged as a wind generator in OpenStreetMap inside the domain, 504 of them. They are only used for the comparison at the end.

The flow model is OpenFOAM's `simpleFoam`: steady, incompressible RANS with k-epsilon and the standard atmospheric inflow profiles. The mesh is a single structured block with every point column moved onto the terrain, about 576,000 cells at 200 m horizontal spacing, with the first cell 5 to 7 m above the ground. I solve twelve wind directions, one per 30° sector, then weight each direction's result by how often ERA5 says the wind blows from it.

## Two things that cost time

**The four directions that never converged.** All four sides of the domain carry the same inlet/outlet condition, so one mesh serves every direction. Eight directions converged in about 250 iterations. The other four, 0°, 90°, 180° and 270°, ran to the iteration cap with the cross-stream velocity residual stuck at 1e-2. Those are exactly the directions parallel to a side of the box. On a parallel side the flux is close to zero, and the condition flips between inlet and outlet every iteration. Rotating the mesh 15° against north fixed it: every direction is then at least 15° off a side. Eleven of the twelve now converge in 225 to 275 iterations. The twelfth, 240°, levels off with its residuals around 1e-5, just above the target, and runs to the cap.

**A boundary condition that needs a value it doesn't use.** OpenFOAM's atmospheric inlet conditions inherit from `inletOutlet`, so they need an explicit `value` entry even though they compute the profile themselves. Without it the case stops at time zero.

## What the model says

<figure>
  <img src="{{ '/assets/images/posts/puglia-wind-speedup-240.png' | absolute_url }}" alt="Map of wind speed-up 100 m above ground for wind from 240 degrees. Orange bands along the ridges in the west and south, up to 1.7 times the inflow; blue in the lee valleys and over the plain to the north-east, down to about 0.3. Turbine markers sit mostly on the orange bands.">
  <figcaption>Wind from 240°, the most frequent direction: speed 100 m above ground relative to the inflow.</figcaption>
</figure>

For the most frequent direction the wind speeds up by as much as 1.7 times over the crests and drops below half the inflow in the lee valleys. Combining all twelve directions with the ERA5 climate gives the long-term map:

<figure>
  <img src="{{ '/assets/images/posts/puglia-wind-mean.png' | absolute_url }}" alt="Map of modelled long-term mean wind speed 100 m above ground over the Monti Dauni, from about 3.5 m/s on the plain to over 6 m/s on the ridges, with 504 OpenStreetMap wind turbines plotted as triangles, most of them along the darkest ridges.">
  <figcaption>Modelled long-term mean wind 100 m above ground, with the 504 turbines from OpenStreetMap.</figcaption>
</figure>

Away from the flat strip at the domain edges there are 264 turbines. At their positions the model gives a mean of 5.47 m/s, against 4.55 m/s for the domain as a whole. The median turbine sits at percentile 94 of modelled wind, 71 % of them are in the windiest quarter of the domain, and 4 % in the calmest quarter.

Now the caveat. Developers build on high ground, and high ground is windy. The median turbine is also at percentile 93 of elevation, so height alone explains most of that result. The more useful test compares each turbine only with ground of the same elevation, within 25 m. There the median turbine is still at percentile 80 of modelled wind. The model is picking out exposed crests over sheltered ground at the same height, which is the part a simple elevation map can't do.

## The Gargano

The Gargano, the promontory just north, needed one change: sea and land have very different roughness, 0.0002 m against 0.1 m, so the ground roughness now follows the ISTAT coastline face by face. The domain is a 60 km square at 250 m, about 2.3 million cells, and all twelve directions converged.

<figure>
  <img src="{{ '/assets/images/posts/puglia-wind-gargano.png' | absolute_url }}" alt="Map of modelled long-term mean wind 100 m above ground over the Gargano promontory and the surrounding sea. The western ridges are darkest, above 6 m/s; inland valleys and a wedge of sea south of the promontory are pale, around 3.5 m/s. A cluster of 17 turbines sits on the plain in the south-west corner.">
  <figcaption>The Gargano: modelled long-term mean wind 100 m above ground, with the 17 turbines OpenStreetMap has in this square.</figcaption>
</figure>

The western ridges facing the north-westerlies are the windiest ground. The sea in the lee of the south coast is calm, and the wind slows where it crosses from sea onto land. The 17 turbines in this square all stand on the plain in the south-west corner; the promontory itself, mostly national park, has none.

## The 3D viewer

The [viewer](https://www.fratepietro.com/puglia-wind/) has both sites, with a locator map of Puglia, and loads 1 to 3 MB of data and runs in the browser with three.js. You can switch between the long-term mean and the speed-up for any of the twelve directions, and pick the direction from a wind rose where each petal's length is its ERA5 frequency. Particles follow the solved flow 100 m above the ground, and the turbine rotors turn to face the selected wind. Hovering shows the elevation and modelled wind at any point.

## Building it like an HPC job

The container I used to develop the case is fine for getting the physics right, but a prebuilt binary says nothing about the machine it runs on. For anything I time, the stack is built from source with Spack, one environment per toolchain. OpenFOAM 2506 goes on GCC and AOCC; STREAM and HPL on all three:

| Toolchain | Compilers | BLAS / LAPACK | MPI |
|---|---|---|---|
| GNU | GCC 13.3 | OpenBLAS | Open MPI 5.0 |
| AMD Zen Software Studio | AOCC 5.2 | AOCL BLIS and libFLAME | Open MPI 5.0 |
| Intel oneAPI | icx, ifx 2026.0 | oneMKL | Intel MPI 2021.18 |

Before any CFD run there is a node baseline. `simpleFoam` on a hex mesh does little arithmetic per byte it moves, so memory bandwidth limits it, not FLOPs. STREAM triad gives that ceiling and says where scaling over cores will flatten. HPL is the check on the compiler, BLAS and MPI stack as a whole: if its residual check fails, the build is wrong and nothing measured on it counts. The solver benchmark compares the 100 m wind field of every build with a reference run for the same reason.

Getting the toolchains to build was most of the work:

- In Spack 1.x, `%aocc` binds AOCC to at least one language per package, and the solver is free to use GCC for the rest. A `toolchains:` block that pins C, C++ and Fortran fixes it, and then the whole chain, Open MPI and BLIS included, is built by AOCC.
- AOCC needs `+license-agreed` before Spack will install it.
- OpenFOAM pulls in ADIOS2, whose default XRootD backend fails at CMake time: its HTTP plugin needs curl, which the XRootD package doesn't declare. OpenFOAM needs neither XRootD nor ADIOS2's Catalyst plugin, so both are off.
- The first OpenFOAM install reported success after five minutes and contained no solvers. Spack 1.x passes builds a make jobserver over a named pipe, which GNU make only understands from version 4.4; the container had 4.3, so every `wmake` call stopped at once. OpenFOAM's `Allwmake` then prints "ignoring possible compilation errors" and exits 0. The install script now builds a newer make first and checks that `simpleFoam` exists before it calls a build done.
- HPL passes its residual check with GCC and OpenBLAS and with AOCC and BLIS. With oneAPI and MKL it fails, also with MKL forced onto its SSE4.2 code path. That was x86 under emulation on a laptop, so it goes on the list to recheck on real hardware rather than into a conclusion.

With make 4.4 on the path the GCC build of OpenFOAM took about an hour, and it reproduces the container: on the same case after 200 iterations, the 100 m wind fields differ by 0.00055 m/s RMS and at most 0.018 m/s, about 0.1 % of the peak speed. That is the size of difference you expect from a different build and a different domain decomposition, and it is the check every later build has to pass.

The AOCC build is the slow one here: 3.4 hours, because it is x86 code under emulation on an Arm laptop, with Open MPI built by AOCC as well. It passes the same check, 0.0021 m/s RMS and at most 0.067 m/s, with 99 % of the cells within 0.006 m/s. The maximum is larger than with GCC because almost everything changed at once: compiler, instruction set and the order of floating-point operations, on a run stopped at 200 iterations before it has fully converged. Both builds give the same wind field, which is what has to hold before any timing between them means anything.

The timed comparison comes next, on an AMD EPYC node: STREAM and HPL per toolchain, OpenFOAM with GCC against AOCC and `-march=znver4` against generic x86-64-v3, and strong scaling from one rank to a full socket with scotch against hierarchical domain decomposition.

## What it doesn't do

- 200 m cells are coarse. A single turbine position needs the 50 m mesh, about 14 million cells, which is the next run.
- The atmosphere is neutral, with no Coriolis force and the same roughness everywhere. Forests and land use would change the roughness locally.
- ERA5 is treated as the undisturbed inflow, but its 31 km grid already sees a smoothed version of these hills.
- OpenStreetMap coverage is volunteered and probably incomplete.
- It hasn't been checked against a measured wind series yet.

Next is the 50 m mesh on that EPYC node, which also tells me what a full twelve-direction sweep costs.

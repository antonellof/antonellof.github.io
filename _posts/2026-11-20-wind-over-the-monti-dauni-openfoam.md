---
layout: post
title: "Can a CFD model find the wind farms? Wind over the Monti Dauni with OpenFOAM"
date: 2026-11-20
categories: [Projects]
tags: [OpenFOAM, CFD, Wind Energy, Puglia, ERA5, Copernicus, OpenStreetMap, three.js, HPC]
image: /assets/images/posts/puglia-wind-mean.png
description: "A terrain-following OpenFOAM model of the Monti Dauni in Puglia, driven by ten years of ERA5 wind, compared with the 504 wind turbines mapped in OpenStreetMap. Includes a 3D viewer."
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

## The 3D viewer

The [viewer](https://www.fratepietro.com/puglia-wind/) loads about 1 MB of data and runs in the browser with three.js. You can switch between the long-term mean and the speed-up for any of the twelve directions, and pick the direction from a wind rose where each petal's length is its ERA5 frequency. Particles follow the solved flow 100 m above the ground, and the turbine rotors turn to face the selected wind. Hovering shows the elevation and modelled wind at any point.

## What it doesn't do

- 200 m cells are coarse. A single turbine position needs the 50 m mesh, about 14 million cells, which is the next run.
- The atmosphere is neutral, with no Coriolis force and the same roughness everywhere. Forests and land use would change the roughness locally.
- ERA5 is treated as the undisturbed inflow, but its 31 km grid already sees a smoothed version of these hills.
- OpenStreetMap coverage is volunteered and probably incomplete.
- It hasn't been checked against a measured wind series yet.

Next is the 50 m mesh on a many-core EPYC node, with OpenFOAM built from source, so I can measure how the solver scales and what a full twelve-direction sweep costs.

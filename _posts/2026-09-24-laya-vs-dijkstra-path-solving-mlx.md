---
layout: post
title: "Laya vs Dijkstra: can a typed-decision model find its way out of a maze?"
date: 2026-09-24
categories: [Projects]
tags: [AI, MLX, Apple Silicon, Laya, Local Inference, Algorithms, Dijkstra, Pathfinding, Python]
excerpt: "I put Laya, a small typed-decision model running locally on MLX, against Dijkstra on seeded weighted mazes, caves and room maps. Dijkstra sees the whole map and wins, as it should. Laya only sees four neighbours and still reaches the goal every time, beating a random-choice baseline on 5 of 6 maps. Code, GIF, an interactive replay and every number are in the post and the repo."
---

![Laya MLX vs Dijkstra on three seeded maps: Dijkstra's expansion wave on the left, Laya walking the map on the right](/assets/images/posts/laya-vs-dijkstra.gif)

[laya-mlx](https://github.com/mizorewww/laya-mlx) is an MLX port of [Laya](https://github.com/NandhaKishorM/laya), a model that doesn't generate text. You give it a state and a typed question: a `choice`, a `score`, or a yes/no `noul`. It returns probabilities from one bidirectional forward pass. No decoding, no JSON to parse. On an M2 Pro a short question takes about 15 ms.

The repo ships a Snake demo where Laya picks every move. I liked it, and I wanted a harder test with a known correct answer to measure against. Path solving has one: Dijkstra.

So I built [laya-vs-dijkstra](https://github.com/antonellof/laya-vs-dijkstra). Same map, same start and goal, two solvers, replayed side by side.

## The setup

Maps are seeded 41×29 grids in three kinds:

- **maze**: recursive backtracker, then braided so several routes compete
- **caves**: cellular automaton, largest connected region kept
- **rooms**: rectangles joined by corridors, plus extra links that create loops

Every open cell has a cost to enter: floor 1, mud 3, water 6. So the shortest path and the cheapest path are not the same thing.

**Dijkstra** gets the whole weighted map. Binary heap, textbook implementation. Optimal by construction.

**Laya** gets much less. At each step it sees its four neighbours, their terrain, whether it has been there before, and whether a move takes it closer to the goal or farther away. Like a compass, not a map. It has to walk.

That is not a fair fight, and it isn't meant to be. Dijkstra is the ceiling. The question is how close a small local model gets, walking blind, and whether its choices beat chance.

## First attempt: Laya picks RIGHT

My first version asked one `choice` question with the four directions as options, each with a short description. Laya picked RIGHT almost every time, including into a dead end.

So I measured it. I took four fixed labels (best move, okay move, dead end, wall) and tried all 24 ways of assigning them to UP, DOWN, LEFT and RIGHT. The best-move label won 11 times out of 24. That is a coin flip dressed up as a decision. The model was reacting to option position, not content.

Switching to one yes/no `noul` question per direction fixed it. The same 24 permutations: 24 out of 24. All four questions go in one batched forward pass, so it is still a single call.

Wording mattered too. I ranked nine move situations by hand, from "closer, new cell, fast floor" down to "farther, visited three times", and checked how many of the 36 pairs Laya ordered correctly under each format. Plain facts like `Closer to goal. New cell. Fast floor.` got 23 of 36. Splitting the same facts into good and bad got 34 of 36:

```
Good: gets closer to the goal, explores a new cell. Bad: slow mud.
```

The question is always the same: *Is this the best move to reach the goal quickly?* The move with the highest probability wins.

## Second attempt: Laya walks in circles

With the better prompt, Laya solved one caves map and one rooms map, and then walked a maze for 2,352 steps without reaching the goal.

Nothing was wrong with the individual decisions. Local greed has a well-known failure: in a braided maze you walk into a pocket, every exit looks worse than the one you came from, and you bounce. Telling Laya "visited 5 times" versus "visited 6 times" is not enough signal to escape.

The fix dates from the 19th century. [Trémaux's algorithm](https://en.wikipedia.org/wiki/Maze-solving_algorithm#Tr%C3%A9maux's_algorithm) marks passages as you walk them:

- a passage walked twice is closed
- unwalked passages come first
- entering a known cell through a new passage means turning back

Those rules guarantee the walker reaches the goal on any connected map. They don't say *which* unwalked passage to take. That choice is Laya's, and it is where all the efficiency is. When the rules leave only one legal move, no inference runs; the UI shows it as "forced".

It's the same idea as the Snake demo's safety layer: hard rules keep the agent alive, the model decides where to go. The replay shows both, so it is always clear which one made a given move.

## The replay

`uv run laya-vs-dijkstra` solves the maps and opens a self-contained HTML page. Left: Dijkstra's expansion wave, then the optimal path. Right: Laya's walk, with cells shaded by how often they were visited, closed passages dashed, and the final route. Under the board, the live decision panel shows every allowed move, the sentence Laya read, and the probability it returned.

![The replay page on a rooms map: Dijkstra's frontier on the left; on the right Laya's walk, its stats, and the decision panel with P(best move) for each direction](/assets/images/posts/laya-vs-dijkstra-replay.png)

This frame shows a small trade-off. Up and left are fast floor but move away from the goal: 0.777 each. Right is slow mud but moves closer: 0.826. Laya took the mud. Down is closed by the memory rule, so it was never asked.

There are two clocks. **Work steps** plays one Dijkstra node or one Laya move per tick. **Real time** replays measured wall time, and there Dijkstra is done before the first frame. The GIF at the top stretches each side to finish together, and the tiles under each board show the real compute time.

Here is the actual replay from the run behind this post. Pick a map, press play, switch clocks, drag the timeline:

<iframe id="laya-replay" src="/assets/demos/laya-vs-dijkstra/replay.html" title="Interactive replay: Laya vs Dijkstra on six seeded maps" loading="lazy" style="display: block; width: min(1240px, calc(100vw - 32px)); position: relative; left: 50%; transform: translateX(-50%); height: 1400px; border: 1px solid rgba(128, 128, 128, 0.25); border-radius: 12px;"></iframe>
<script>
  (function () {
    var frame = document.getElementById("laya-replay");
    function fit() {
      try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 2 + "px"; } catch (e) {}
    }
    frame.addEventListener("load", function () {
      fit();
      try { new ResizeObserver(fit).observe(frame.contentDocument.body); } catch (e) {}
    });
  })();
</script>

<p style="font-size: 0.9em;"><a href="/assets/demos/laya-vs-dijkstra/replay.html" target="_blank" rel="noopener">Open the replay full screen</a>. It's one self-contained HTML file with the recorded data embedded; nothing runs the model in your browser.</p>

## Results

M2 Pro, FP16, eager mode, `aac6fef/laya-multilingual-mlx`, seeds 7 and 8:

| Map | Optimal | Laya route | Random, same rules | Dijkstra | Laya | Laya decisions |
|---|---:|---:|---:|---:|---:|---:|
| maze #7 | 110 | 274 (2.49×) | 220.1 (2.00×) | 0.85 ms | 384 ms | 24 |
| caves #7 | 90 | 214 (2.38×) | 244.6 (2.72×) | 1.15 ms | 1.98 s | 112 |
| rooms #7 | 58 | 92 (1.59×) | 131.0 (2.26×) | 0.60 ms | 520 ms | 29 |
| maze #8 | 126 | 192 (1.52×) | 213.2 (1.69×) | 0.77 ms | 219 ms | 14 |
| caves #8 | 53 | 74 (1.40×) | 179.3 (3.38×) | 0.73 ms | 724 ms | 41 |
| rooms #8 | 80 | 129 (1.61×) | 154.8 (1.93×) | 0.62 ms | 1.72 s | 98 |

- **Route** is Laya's start-to-goal path with the loops removed. Its total walking cost, backtracks included, is in the repo.
- **Random, same rules** averages 20 walks under the same Trémaux rules, choosing uniformly among the allowed moves. That column isolates what Laya's choices are worth.
- Dijkstra time is the median of 25 runs. Laya time is end to end, including every synchronized inference.

Laya's decisions are deterministic. I ran the full table twice and got identical numbers, and a fresh clone reproduced them.

![Final frame on caves #7: Dijkstra's optimal path of cost 90 on the left, Laya's discovered route of cost 214 on the right](/assets/images/posts/laya-vs-dijkstra-caves-7.png)

## What I take from it

**Dijkstra wins, by a lot.** It is optimal and two to three orders of magnitude faster. If you have the map, use a planner. Nobody should swap Dijkstra for a neural network.

**Laya always reached the goal and usually beat chance.** It found a cheaper route than the random baseline on 5 of 6 maps, sometimes by a wide margin: 74 against 179 on caves #8. With only a compass and a memory, a goal-directed preference is worth a lot in open spaces.

**It lost on maze #7.** "Closer to the goal" pulled it into a long branch that looked promising and wasn't. In a tight maze, Manhattan distance lies to you. A random walker ignores it, and averaged over 20 runs that was better here.

![Final frame on maze #7, where Laya's goal-directed choice sent it down a long branch first](/assets/images/posts/laya-vs-dijkstra-maze-7.png)

**The prompt matters more than I expected.** Going from a `choice` question to `noul` questions changed the result from position bias to correct, and the Good/Bad wording added several more correct pairs. If you use Laya for your own decisions, test a few question formats against cases where you know the answer before trusting it.

**Hybrid is the honest design.** Rules for the guarantees, the model for the judgement calls, and the UI makes it visible which one decided each move. That's how I'd use a small decision model in anything real.

Six maps is a demo, not a benchmark. Run more seeds before drawing conclusions.

## Run it

You need an Apple Silicon Mac and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/antonellof/laya-vs-dijkstra
cd laya-vs-dijkstra
uv run laya-vs-dijkstra
```

The first run downloads the checkpoint (about 650 MB) once; after that everything is offline. Some variations:

```bash
uv run laya-vs-dijkstra --seeds 7,8,9 --kinds maze,rooms   # more maps
uv run laya-vs-dijkstra --width 61 --height 41             # bigger maps
uv run laya-vs-dijkstra --json run.json                    # keep the raw data
uv run laya-vs-dijkstra gif run.json --out demo.gif        # render your own GIF
```

The repo is small: map generators and Dijkstra, the Laya walker with its memory rules and random baseline, the replay page, and the GIF renderer. The tests check Dijkstra against an independent search and check that the memory rules reach the goal on every map kind. None of them need the model.

## Links

- [laya-vs-dijkstra on GitHub](https://github.com/antonellof/laya-vs-dijkstra)
- [laya-mlx](https://github.com/mizorewww/laya-mlx), the MLX port, and its [Snake demo](https://github.com/mizorewww/laya-mlx/blob/main/docs/SNAKE_DEMO.md)
- [Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations
- [Trémaux's algorithm](https://en.wikipedia.org/wiki/Maze-solving_algorithm#Tr%C3%A9maux's_algorithm)

## AI full disclosure

This experiment was built with strong assistance from Claude Code, with me leading the idea, the questions and the checks. The prompt-format measurements, the failed first attempts and every number in this post come from real runs on my machine. If you are not happy with AI-developed code, this project is not for you.

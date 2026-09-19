---
layout: post
title: "Bonsai: a 27B reasoning model on a 16 GB M2 Mac, with Frink"
date: 2026-09-18
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Ternary, Apple Silicon, M2, MacBook, Metal, Coding Agents, OpenAI API, Pi Agent]
excerpt: "Frink now runs PrismML's Ternary-Bonsai-2-27B: a 27B model at 1.75 bits per weight, 5.95 GB on disk instead of ~54 GB, with PrismML reporting 98.2% of FP16 intelligence retained. How to download it, run it, put it behind the Studio UI, and point a coding agent at it."
---

<img src="/assets/images/frink/frink-logo.webp" alt="Frink" width="380" />

[Frink](https://github.com/antonellof/frink) is a pure-Rust inference engine for GGUF models, with a llama.cpp-shaped CLI, an OpenAI-compatible server, and a small web UI called Studio. The [first post](/2026/frink-rust-gguf-inference-engine/) covers the design, the [second](/2026/frink-metal-parity-llama-cpp/) the Metal backend.

This one is about a single model: [Ternary-Bonsai-2-27B](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) from PrismML. 27 billion parameters at 1.75 bits each, 5.95 GB on disk, running on a 16 GB laptop with room to spare.

## What Bonsai is

Every language weight is one of three values, -1, 0 or +1, with one 16-bit scale per group of 128. Five trits pack into a byte in base 3, which is where 1.75 bits per weight comes from; that packing is the GGUF type `PTQ1_0`.

Ternary alone would wreck a 27B model. What makes it work is a rotation: each weight matrix is transformed blockwise by a Walsh-Hadamard matrix with fixed signs, which spreads outliers across a block so a three-level grid can hold them. The rotation is folded into the stored weights, so the runtime has to apply the matching transform to the activations before every matmul, and undo it on the embedding table after each lookup. Get that wrong and the model loads and talks nonsense.

It is ternary end to end — embeddings, attention projections, MLP projections and the LM head, a true 1.72 bits per weight, with no high-precision escape hatch behind a low-bit label. The vision tower ships separately as a Q8_0 `mmproj` pack. PrismML publish two packings: `PTQ1_0` packs trits densely (1.75 bits/weight, 5.95 GB) and `PQ2_0` gives each trit its own 2-bit slot (2.13 bits/weight, 7.21 GB). Either way the packed weights are consumed directly and never expanded back to FP16.

The numbers PrismML report for it are the reason it is interesting rather than a curiosity: **98.2% of FP16 intelligence retained**, 84.78 average across 14 thinking-mode benchmarks, against 72.59 for a conventional IQ2_XXS build at more than half again the footprint — and within 0.4 points of UD-Q4_K_XL at three times the size. Reasoning survives well below 4 bits where conventional low-bit formats collapse: math within half a point of full precision (96.57), coding level with the baseline (89.42), agentic tool calling at 74.92. The backbone is the Qwen3.8-27B hybrid attention (roughly 75% linear), which is what keeps its 262K context practical on-device. There is an MLX build too, `Ternary-Bonsai-2-27B-mlx-2bit`, for native Apple Silicon.

From ~54 GB in FP16 to ~5.9 GB. That is the whole pitch: 27B-class reasoning on a laptop or one GPU.

Frink v0.24.0 adds the packing (a CPU dot, a Metal matvec, a Metal GEMM) and the fold, read from the checkpoint's own `prism.hadamard.*` metadata. Anything outside the configuration that has been verified is refused by name rather than guessed at.

PrismML's [llama.cpp fork](https://github.com/PrismML-Eng/llama.cpp) is the reference implementation for the format, so that is what Frink is checked against. `frink parity` feeds both engines identical token ids and compares the full first-token logit distribution: a KL divergence of 2e-5 on CPU, 2e-5 on the Metal decode kernel and 2e-6 through the Metal prefill GEMM, with the same ten top tokens in the same order. The tokenizer matches on 1198 tokens across 21 test strings.

## Download and run

One line, no toolchain:

```bash
curl -fsSL https://raw.githubusercontent.com/antonellof/frink/main/scripts/install.sh | bash
```

That drops `frink` and `frink-server` into `~/.local/bin`. The macOS
build is arm64 with Metal already on; Linux x86_64 is CPU. Then:

```bash
# Same argument shape as `hf download`, no Python.
frink download prism-ml/Ternary-Bonsai-2-27B-gguf \
  Ternary-Bonsai-2-27B-PTQ1_0.gguf --local-dir models

# Chat. Frink applies the checkpoint's own template.
frink -m models/Ternary-Bonsai-2-27B-PTQ1_0.gguf \
  -p "Explain ternary quantization in three sentences" -n 400 -ngl 99
```

If you would rather build it, `cargo install frink-cli --features metal`
(or `--features cuda`) gives you the same binary.

On an M2 Pro it decodes at about 10.5 tokens per second and prefills at about 43: reading speed rather than skimming speed, with most of the machine's memory still free. That decode figure was 7.1 when the format first landed; most of the difference is a recurrent layer now running as a single Metal submission instead of three.

## The server and Studio

```bash
frink serve -m models/Ternary-Bonsai-2-27B-PTQ1_0.gguf \
  -ngl 99 --alias bonsai-2-27b --port 8383
```

That is an OpenAI-compatible API on `http://127.0.0.1:8383/v1`: chat completions, completions, embeddings and models, with Anthropic Messages and Responses on the same port. `--alias` names the model in `/v1/models` and in every response; without it you get the checkpoint's own `general.name`, which for this file is the unhelpful string `Hf`.

Note what is missing from that command: `-c`. With no context flag the server prices the checkpoint against the device and derives both the per-request ceiling and the KV block budget from the same arithmetic, so the context it advertises is one it can actually serve.

Studio is a separate app that talks to that API over HTTP. From a checkout:

```bash
cd ui && npm install && npm run dev   # http://localhost:5173/ui/
```

Its Models page lists every GGUF in your models directory with its quant, architecture, context and size, and loads one without restarting the server:

![Frink Studio Models page in dark mode: the inventory filtered to Ternary-Bonsai-2-27B-PTQ1_0, showing quant PTQ1_0, arch qwen35, context 262,144, 26.9B parameters, 5.54 GB on disk, state loaded](/assets/images/frink/bonsai-models.png)

And a chat, at the real speed:

![Frink Studio streaming an answer from Ternary-Bonsai-2-27B: the prompt is typed, sent, and the model's chain of thought fills in live](/assets/images/frink/bonsai-studio.gif)

The finished turn carries its own numbers underneath: time to first token, prefill and decode rates.

![Frink Studio chat with Ternary-Bonsai-2-27B: a Rust function answered with a doc comment and examples, and a stat line underneath](/assets/images/frink/bonsai-chat.png)

The model thinks before it answers. Studio folds the thinking into a collapsible block; over the API it arrives in `reasoning_content`, separated from the answer, and `reasoning_effort: "medium"` shortens it while `"none"` turns it off.

## Point a coding agent at it

Any tool that speaks the OpenAI API can use the server. Here is [Pi](https://github.com/earendil-works/pi), the minimal coding agent I covered in [an earlier post](/2026/running-glm-5-2-locally-rondine-pi/): four tools, one loop, one provider file.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Check the server answers first, using the id you gave `--alias`:

```bash
curl http://127.0.0.1:8383/v1/models
```

Then add Frink as a provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "frink": {
      "baseUrl": "http://127.0.0.1:8383/v1",
      "api": "openai-completions",
      "apiKey": "frink",
      "models": [
        {
          "id": "bonsai-2-27b",
          "name": "Bonsai 2 27B ternary, local via Frink",
          "contextWindow": 16384
        }
      ]
    }
  }
}
```

Frink does not validate the key, but Pi wants a non-empty one. Then `cd` into a repository, run `pi`, pick the Frink entry with `/model`, and start with something small and checkable. Two practical notes: keep `max_tokens` generous, because a thinking model spends part of the budget before it writes any code, and a few tokens per second suits reviewing each step rather than firing and forgetting.

## Links

- [Frink on GitHub](https://github.com/antonellof/frink), [v0.24.0 release](https://github.com/antonellof/frink/releases/tag/v0.24.0)
- [Ternary-Bonsai-2-27B GGUF](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) and [PrismML's llama.cpp fork](https://github.com/PrismML-Eng/llama.cpp)
- [Pi coding agent](https://github.com/earendil-works/pi)

## AI full disclosure

This software is developed with strong assistance from Cursor, Grok 4.5, GPT 5.6, and Claude Fable 5, with humans leading the ideas, testing, and debugging. We say this openly because it shaped how the project was built. If you are not happy with AI-developed code, this software is not for you.

## Acknowledgements

Frink does not link against GGML, but exists thanks to the path opened by the llama.cpp project and the kernels, quantization formats, GGUF ecosystem, and hard-won engineering knowledge developed there. The ternary format, the Hadamard fold and the model itself are PrismML's, and the Metal kernel in this release is a port of the design in their fork. We keep the GGML authors' copyright notice in [docs/THIRD_PARTY_NOTICES.md](https://github.com/antonellof/frink/blob/main/docs/THIRD_PARTY_NOTICES.md).

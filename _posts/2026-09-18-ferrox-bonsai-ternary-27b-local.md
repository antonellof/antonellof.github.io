---
layout: post
title: "A 27B model in 6 GB: Bonsai ternary on Ferrox, locally"
date: 2026-09-18
categories: [Projects]
tags: [Rust, AI, LLM, Local Inference, Ternary, Apple Silicon, Metal, Coding Agents, OpenAI API, Pi Agent]
excerpt: "Ferrox v0.23.1 runs PrismML's Ternary-Bonsai-2-27B, a 1.75-bit-per-weight model that fits in 5.95 GB, at the same logits as PrismML's own llama.cpp fork. How to download it, run it, put it behind the Studio UI, and wire it into a coding agent."
---

<img src="/assets/images/ferrox/ferrox-logo.webp" alt="Ferrox" width="380" />

[Ferrox](https://github.com/antonellof/ferrox) is a pure-Rust inference engine for GGUF models, with a llama.cpp-shaped CLI, an OpenAI-compatible server, and a small web UI called Studio. The [first post](/2026/ferrox-rust-gguf-inference-engine/) covers the design and the [second](/2026/ferrox-metal-parity-llama-cpp/) covers catching llama.cpp on Metal.

This one is about a single model, [Ternary-Bonsai-2-27B](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) from PrismML, and it is the first checkpoint I have run on Ferrox that upstream llama.cpp will not open at all. Handed the same file, a build of `ggml-org/llama.cpp` from this week says:

```text
gguf_init_from_reader: tensor 'output.weight' has invalid ggml type 143. should be in [0, 43)
llama_model_load: error loading model: failed to load model
```

27 billion parameters at 1.75 bits each, 5.95 GB on disk, running on a 16 GB laptop with room to spare. Ferrox v0.23.1, released today, adds the quantization format it ships in and the transform that makes that format work, verified against PrismML's own reference at the logit level.

## What Bonsai is

Bonsai 2 is derived from Qwen3.8-27B with the architecture unchanged, and its GGUF declares llama.cpp's `qwen35` architecture: a hybrid backbone that is about three quarters linear attention, with full attention every fourth layer (the file says `full_attention_interval = 4`). What PrismML changed is the weights. Every language weight is one of **three values**, -1, 0 or +1, with one 16-bit scale per group of 128. Five trits pack into a byte in base 3, which is where 1.75 bits per weight comes from, and that packing is the GGUF type `PTQ1_0`. A second packing, `PQ2_0`, gives each trit its own 2-bit slot at 2.13 bits per weight; Ferrox recognises it and refuses it, because it has no kernel for it.

Ternary quantization alone would wreck a 27B model. What makes it work is a rotation: before quantizing, every weight matrix is transformed blockwise by a Walsh-Hadamard matrix with fixed +1/-1 signs, 1024 wide, which spreads outliers across the channels of a block so that a three-level grid can hold them. The rotation is folded into the stored weights, so it costs no bits and no extra weight traffic, and the runtime has to apply the matching transform to the activations before every matmul and undo it on the embedding table after each lookup. The file declares the rotation as metadata precisely so that a runtime either applies it or refuses the file. If you apply it wrong, the model loads and talks nonsense.

Upstream llama.cpp knows neither the packing nor the rotation, which is what that `invalid ggml type 143` is. PrismML publish a [fork](https://github.com/PrismML-Eng/llama.cpp) that does, and that fork is the reference every number below is measured against.

## What Ferrox does with it

Three pieces, all in this release:

- **The `PTQ1_0` codec** (`ferrox-quant`): unpacking, dequantizing and dot products for the base-3 layout, sharing one implementation with llama.cpp's own `TQ1_0` since the two differ only in block geometry.
- **Metal kernels** (`ferrox-metal`): a matvec for decode and a simdgroup GEMM for prefill. The matvec is PrismML's design ported: eight GPU lanes share one 128-weight block and each lane owns whole bytes, so a block is read from memory exactly once, and the trit is peeled out on the float pipeline as `floor(3^(n+1) u) - 3 floor(3^n u)` with `u = byte / 256`, which is exact in fp32 and never touches the integer units. My first version gave each lane a whole block and decoded with integer ops. It was correct and it ran at 2.4 tokens per second.
- **The Hadamard fold** (`ferrox-core`, `ferrox-models`): read from the `prism.hadamard.*` metadata the checkpoint carries (block 1024, an explicit sign per input channel, the tensor names it applies to), applied to the activation before every launch of a folded weight, and undone on the embedding row after lookup. Anything outside the exact configuration that has been verified is refused by name, which is how Ferrox treats every partially-understood model: stop, do not guess.

## Accuracy: measured, not eyeballed

Ferrox has a `parity` command that feeds identical token ids to a compiled libllama and to Ferrox, then compares the full first-token logit distributions. It reports KL divergence, total variation, and the top-10 overlap, with the "wrong" line calibrated from how far two builds of llama.cpp itself disagree on the same file. Greedy text is not enough for this: two near-tied logits swapping looks like a bug and is not one, and a real bug can hide behind a plausible sentence.

Against PrismML's fork, on the real 27B checkpoint:

| Path | KL(reference, Ferrox) | Top-10 overlap |
|---|---|---|
| CPU | 2.1e-5 nats | 10 / 10 |
| Metal, decode kernel | 2.3e-5 nats | 10 / 10 |
| Metal, prefill GEMM (256-token prompt) | 2.2e-6 nats | 10 / 10 |

For scale, the "wrong" line is 1e-2 and the fork's own build-to-build spread on this format is up to 4.6e-4. These are the same distribution to within float accumulation order. The tokenizer matches too: 21 test strings across both special-token modes, 1198 tokens, identical.

## Speed, and where it goes

On an M2 Pro (16 GB), `ferrox bench` against the fork's `llama-bench`, same file, same GPU, same session:

| | Ferrox v0.23.1 | PrismML llama.cpp |
|---|---|---|
| Prefill, 128 tokens | 32 tok/s | 67 tok/s |
| Decode | 7.2 tok/s | 11.5 tok/s |

The first build did 2.9 and 2.4. The path from there was a sequence of measured steps, each one a profile and a fix: the matvec redesign above, fusing paired projections into one GPU submission, running the delta-net recurrence across all cores with reductions the compiler can vectorise, a Hadamard butterfly that does one row per core instead of all rows on one, and finally moving the rotation itself onto the GPU so the whole feed-forward block (gate, SwiGLU, down) fits in one command buffer instead of two.

I am still 1.6x behind on decode, and I would rather publish the reason than the excuse. Every Metal submission Ferrox makes is now timed, including the fused feed-forward block, which used to commit its command buffer without noting it and therefore charged its own GPU time to the host. With that closed, one decode token accounts for itself:

| Per token | |
|---|---|
| Command buffers submitted | 159 |
| GPU, summed over them | 66 ms |
| Submission overhead beyond that GPU time | 34 ms |
| Host compute (delta-net recurrence, norms, sampling) | 41 ms |
| Wall clock | 141 ms |

The fork's token is 87 ms. It is not winning on kernel speed: 66 ms of GPU for 5.95 GB of weights is about 90 GB/s of a 200 GB/s machine, and the trit decode is arithmetic-bound rather than bandwidth-bound in both engines. It is winning because it encodes the whole token as one graph and never comes back. Ferrox returns to the host roughly three times per layer, and each return costs 0.166 ms of wake-up latency beyond the work plus whatever the CPU then does.

So the remaining gap is one piece of work, not a list: run a whole layer without leaving the device, which means the recurrent state update, the norms and the residual adds become kernels. That is a bigger change than everything above put together, and it is the next thing.

Two experiments are worth as much as the fixes, because they say where the floor is not.

Putting the rotation on the GPU bought 9% of decode and **cost 6% of prefill**. The host version is already spread across six cores, while the kernel has to serialise into the same command buffer as the matmul it feeds, so a prefill batch keeps the host transform and the code says so at the branch.

Replacing the blocking wait on each command buffer with a short spin, aimed squarely at that 0.166 ms, produced **3.7 tok/s against 7.1**: polling the buffer's status through the Objective-C runtime takes the very core the host work needs. Unretained command-buffer references, aimed at the same number, measured 7.00 against 7.1, which is nothing for an `unsafe` whose invariant somebody has to keep. Neither is in the release; both are recorded next to the code that would otherwise invite them again.

7 tokens per second is a usable speed for a 27B model on a laptop. It is the speed at which you read, not the speed at which you skim.

The fixes were not all Bonsai's. Chasing why the first Metal run printed padding tokens turned up a kind table that had been copied into four places, and three of the copies were missing `Q5_0`. Every `Q5_0` model had been running its prefill as N separate matvecs, and skipping the fused feed-forward kernel entirely, for two weeks while the capability table claimed otherwise. That is fixed in the same release, and each copy is now derived from the one table with a test holding it there.

Two more turned up once the server was actually serving this model rather than answering `curl`. A chat request that omits `max_tokens` gets a 32768-token default, and the private decode loop clamped that to the remaining context while the batching path, which is the default one, refused it instead, so a server started `-c 16384` answered `hi` with a 400 naming a number the caller never sent. And the per-request context ceiling was derived independently of the KV block ledger, so `-c 65536` on a machine whose ledger held 25344 positions advertised a context it could never admit. Both are one shared function now.

## Download and run

You need Rust and, on a Mac, nothing else. The only build flag is your GPU.

```bash
cargo install ferrox-cli --features metal      # or --features cuda

# Same argument shape as `hf download`, no Python.
ferrox download prism-ml/Ternary-Bonsai-2-27B-gguf \
  Ternary-Bonsai-2-27B-PTQ1_0.gguf --local-dir models

# Raw completion, greedy, no chat wrapping.
ferrox -m models/Ternary-Bonsai-2-27B-PTQ1_0.gguf \
  -p "The capital of France is" -n 32 --temp 0 --no-cnv -ngl 99

# Chat. Ferrox applies the checkpoint's own template (thinking on by default).
ferrox -m models/Ternary-Bonsai-2-27B-PTQ1_0.gguf \
  -p "Explain ternary quantization in three sentences" -n 400 -ngl 99

# Check it against the reference yourself, if you have the fork built.
ferrox parity -m models/Ternary-Bonsai-2-27B-PTQ1_0.gguf --dumper target/llama_logits_prism
```

The download is 5.95 GB. The first load maps the file and is instant; the first token pays for paging it in.

## The server and Studio

```bash
ferrox serve -m models/Ternary-Bonsai-2-27B-PTQ1_0.gguf \
  -ngl 99 --alias bonsai-2-27b --port 8383
```

That gives you an OpenAI-compatible API on `http://127.0.0.1:8383/v1`: chat completions, completions, embeddings and models, with Anthropic Messages and Responses on the same port. `--alias` is what the model is called in `/v1/models` and in every response; without it you get the checkpoint's `general.name`, which for this file is the unhelpful string `Hf`.

Note what is missing from that command: `-c`. The model advertises a 262k context, my laptop can hold about 25k of its KV cache, and with no `-c` the server prices the checkpoint against the device and derives both the per-request ceiling and the block budget from the same arithmetic. Pass a `-c` larger than the machine can hold and you get the ceiling you asked for, narrowed to what the ledger can actually admit, with a log line saying so.

Studio is a separate app that talks to that API over HTTP (`ferrox-server` serves JSON, not HTML). From a checkout:

```bash
cd ui && npm install && npm run dev   # http://localhost:5173/ui/
```

It reads `FERROX_BACKEND` if your server is somewhere other than `127.0.0.1:8383`.

Studio's Models page lists every GGUF in your models directory, with its quant, architecture, context and size, and lets you load one without restarting the server. Bonsai shows up as `PTQ1_0 / qwen35`:

![Ferrox Studio Models page in dark mode: the inventory filtered to Ternary-Bonsai-2-27B-PTQ1_0, showing quant PTQ1_0, arch qwen35, context 262,144, 26.9B parameters, 5.54 GB on disk, state loaded](/assets/images/ferrox/bonsai-models.png)

And a chat. Here is a question going in and the model streaming its answer back, at the real speed:

![Ferrox Studio streaming an answer from Ternary-Bonsai-2-27B: the prompt is typed, sent, and the model's chain of thought fills in live](/assets/images/ferrox/bonsai-studio.gif)

The finished turn carries the numbers for that request under the answer: time to first token, prefill and decode rates:

![Ferrox Studio chat with Ternary-Bonsai-2-27B: a Rust function answered with a doc comment and examples, and the stat line underneath reading TTFT 3.70 s, prefill 98 tok at 26.6 tok/s, decode 1,495 tok at 4.3 tok/s](/assets/images/ferrox/bonsai-chat.png)

That decode figure is lower than the 7.3 in the table because it is a 1,495-token answer: the KV cache grows as it goes, and the benchmark number is a 32-token run from an empty cache. Both are real; they measure different things.

The model thinks before it answers by default, at the `xhigh` effort its own metadata names. Studio folds the thinking into a collapsible block; over the API it arrives in `reasoning_content`, separated from the answer. `reasoning_effort: "medium"` shortens it and `"none"` (or `enable_thinking: false`) turns it off. Do not reach for `"low"` here: PrismML's model card says this checkpoint ignores it and thinks as hard as at `xhigh`.

That separation is itself a fix in this release. Ferrox used to pick the reasoning parser from the checkpoint's name, and this file's `general.name` is the string `Hf`, so nothing matched and the entire chain of thought arrived as the answer. The chat template is probed at load now, the way its effort vocabulary already was.

## Using it from a coding agent

Any tool that speaks the OpenAI API can use the server. Here is [Pi](https://github.com/earendil-works/pi), the minimal coding agent I covered in [an earlier post](/2026/running-glm-5-2-locally-rondine-pi/): four tools (`read`, `write`, `edit`, `bash`), one loop, and a provider file.

Install it:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Confirm the server answers first, with the model id you gave `--alias`:

```bash
curl http://127.0.0.1:8383/v1/models
curl http://127.0.0.1:8383/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"bonsai-2-27b","messages":[{"role":"user","content":"Say hi in five words."}],"max_tokens":64}'
```

Then add Ferrox as a provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ferrox": {
      "baseUrl": "http://127.0.0.1:8383/v1",
      "api": "openai-completions",
      "apiKey": "ferrox",
      "models": [
        {
          "id": "bonsai-2-27b",
          "name": "Bonsai 2 27B ternary, local via Ferrox",
          "contextWindow": 16384
        }
      ]
    }
  }
}
```

Ferrox does not validate the key, but Pi wants a non-empty one. `contextWindow` should be no larger than the context the server reports it can admit (its startup log prints the derived ceiling). Then:

```bash
cd ~/Projects/some-repository
pi
```

Inside Pi, `/model` and pick the Ferrox entry. Start with something small and checkable, a single function with a test, and watch the Activity page in Studio while it works: every request the agent makes shows up there with its prompt size and timing, which is the fastest way to see whether your context is growing faster than you expected.

Two practical notes for agent use. First, keep `max_tokens` generous, because a thinking model spends part of the budget before it writes any code; if the agent's answers come back truncated, that is why. Second, 7 tokens per second means a 400-token edit takes a minute. That is fine for the review-each-step way I use these tools and frustrating for anything fire-and-forget. A 4B or 8B Bonsai exists on the same Hugging Face account for the second case.

## What I learned building it

The format took an afternoon. The correctness took a day, and none of that day was the new code.

The first Metal run produced `[PAD248319]` forever at a very respectable 5.9 tokens per second. The kernel was right; a helper that decides how many rows each threadgroup owns carried its own list of quantization kinds, the new kind was not on it, and so it dispatched the new kernel with the wrong geometry and every row but the first group's came back zero. Two more copies of the same list were found the same way, one of them wrong for a format Ferrox had shipped for weeks. This is the bug shape that has cost the project most, and it is the one thing I would tell anyone building an engine: two structures that must agree about one thing, with nothing enforcing it, will disagree. Derive one from the other, or write the test that holds them together, before the second copy exists.

The other lesson was about what "supported" means. Bonsai loaded on the first try and printed " Paris." on the first try, on the CPU. If I had stopped there, the Metal path would have shipped wrong. `ferrox parity` against the reference, on all three execution paths, is what turned "looks right" into a number, and the number is what I would want from any engine claiming to run a model I care about.

## Links

- [Ferrox on GitHub](https://github.com/antonellof/ferrox), [v0.23.1 release](https://github.com/antonellof/ferrox/releases/tag/v0.23.1)
- [Ternary-Bonsai-2-27B GGUF](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) and [PrismML's llama.cpp fork](https://github.com/PrismML-Eng/llama.cpp)
- [Pi coding agent](https://github.com/earendil-works/pi)

## AI full disclosure

This software is developed with strong assistance from Cursor, Grok 4.5, GPT 5.6, and Claude Fable 5, with humans leading the ideas, testing, and debugging. We say this openly because it shaped how the project was built. If you are not happy with AI-developed code, this software is not for you. The acknowledgement below is equally important: this would not exist without [llama.cpp](https://github.com/ggerganov/llama.cpp) and GGML, largely written by hand.

## Acknowledgements

Ferrox does not link against GGML, but exists thanks to the path opened by the llama.cpp project and the kernels, quantization formats, GGUF ecosystem, and hard-won engineering knowledge developed there. The `PTQ1_0` Metal kernel in this release is a port of the design in PrismML's fork, and the format, the fold and the model are theirs. We keep the GGML authors' copyright notice in [docs/THIRD_PARTY_NOTICES.md](https://github.com/antonellof/ferrox/blob/main/docs/THIRD_PARTY_NOTICES.md).

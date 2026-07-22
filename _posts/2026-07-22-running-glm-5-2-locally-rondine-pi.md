---
layout: post
title: "Running GLM-5.2 Locally with Rondine and Pi"
date: 2026-07-22
categories: [How-To]
tags: [Rondine, GLM-5.2, Pi Agent, Local LLM, llama.cpp, Apple Silicon, Coding Agents, OpenAI API]
excerpt: "A hardware-aware path from a 239GB GLM-5.2 GGUF to an OpenAI-compatible coding agent, without hand-tuning llama.cpp."
render_with_liquid: false
---

In my previous article, [The Local Agent Trio: cmux + Pi + Unsloth Studio](/2026/cmux-pi-unsloth-local-glm-setup/), I split the local coding stack into three replaceable layers:

1. **cmux** for the terminal workspace
2. **Unsloth Studio** for inference
3. **Pi** for the coding-agent loop

That architecture still makes sense. But there is another way to handle the inference layer—especially when you want the configuration to come from the hardware rather than a model picker.

That is what [Rondine](https://github.com/antonellof/rondine) does.

Rondine detects your machine, checks whether a model fits, selects an inference engine and quantization, applies hardware-specific settings, downloads the weights, and starts an OpenAI-compatible server.

For this setup, the stack becomes:

| Layer | Tool | Purpose |
| --- | --- | --- |
| Workspace | cmux, optionally | Terminal panes and agent notifications |
| Inference | Rondine + llama.cpp | Hardware planning, model download, and serving |
| Agent | Pi | Repository tools and coding loop |

The interesting target is **GLM-5.2**: a frontier-scale Mixture-of-Experts coding model that requires approximately 245GB of memory even at 2-bit quantization.

## The GLM-5.2 hardware reality

Rondine's catalog describes GLM-5.2 as a 744B-parameter MoE model with approximately 40B active parameters per token and support for a context window of up to one million tokens.

The active parameter count reduces computation, but it does not eliminate the need to store the complete model.

Rondine currently provides these configurations:

| Variant | Approximate size | Intended hardware |
| --- | ---: | --- |
| `UD-IQ1_S` | 223GB | Aggressive compression |
| `UD-IQ2_M` | 239GB | Recommended 2-bit balance |
| Official BF16 | ~1.5TB | Large multi-GPU or multi-node system |

For a single machine, Rondine prefers the Unsloth `UD-IQ2_M` GGUF and requires at least 245GB of usable memory.

In practice, this means a **256GB Mac Studio-class machine**. Even then, context length matters. A model may fit at a small context and fail once the KV cache, batching, and operating-system memory are included.

For that reason, Rondine uses a practical **32K coding context** instead of blindly enabling the model's theoretical maximum.

## Why use Rondine?

A raw GLM-5.2 llama.cpp launch requires several decisions:

- Which quantization should I download?
- Does it fit in unified memory?
- How much memory should remain available to macOS?
- What context length is realistic?
- Should the KV cache use F16, Q8, or something smaller?
- Should all layers be offloaded to Metal?
- Which batch and micro-batch sizes should I use?
- Should flash attention be enabled?
- How many parallel slots should the server expose?

Rondine turns those decisions into a reproducible plan.

It is not another inference engine. It installs and drives llama.cpp, MLX-LM, or vLLM while keeping the generated command visible.

## Install Rondine

Rondine requires Python 3.11+ and `uv`:

```bash
git clone https://github.com/antonellof/rondine.git
cd rondine

uv tool install .
```

Start by inspecting the machine:

```bash
rondine doctor
```

On a compatible high-memory Mac, the output should identify Apple Silicon, unified memory, and available engines.

You can then ask Rondine to plan GLM-5.2 directly:

```bash
rondine plan glm-5.2 \
  --profile coding \
  --save-as glm-coding
```

GLM-5.2 is marked as opt-in because of its size. Explicitly naming it opts into planning it, but Rondine still rejects the plan if the detected hardware cannot satisfy the memory estimate.

Before downloading hundreds of gigabytes, inspect the generated launch:

```bash
rondine serve --preset glm-coding --dry-run
```

This prints the resolved llama.cpp command without starting it.

## What the coding configuration contains

For GLM-5.2, Rondine's coding profile applies:

```text
context:           32768
temperature:       1.0
top_p:             0.95
min_p:             0.01
thinking:          enabled
reasoning effort:  max
parallel slots:    1
```

On Apple Silicon, the llama.cpp template also enables:

- Full Metal offload with `-ngl 99`
- Flash attention
- Continuous batching
- Q8 KV caches
- Large batch and micro-batch sizes where memory permits
- `mlock` to reduce unwanted swapping
- A single coding slot so context is not divided among concurrent clients

The effective command remains visible through the dry run, which is useful when experimenting or reporting a problem upstream.

## Download GLM-5.2

Once the plan looks correct:

```bash
rondine setup --engine llama.cpp
rondine pull glm-5.2
```

The preferred quantization is downloaded from:

```text
unsloth/GLM-5.2-GGUF
```

with the pattern:

```text
*UD-IQ2_M*
```

This is a multi-hundred-gigabyte download. Plan for enough disk space beyond the model itself, use a stable connection, and remember that loading it will also require memory for context, cache, and the operating system.

If 239GB is too large, `UD-IQ1_S` reduces the weights to approximately 223GB, but that is a more aggressive quality compromise.

## Start the OpenAI-compatible server

Launch the saved preset:

```bash
rondine serve \
  --preset glm-coding \
  --name glm
```

Rondine starts llama.cpp on:

```text
http://127.0.0.1:8080/v1
```

The model alias exposed to clients is:

```text
rondine/glm-5.2
```

Confirm it through the models endpoint:

```bash
curl http://127.0.0.1:8080/v1/models
```

Then run Rondine's coding verification:

```bash
rondine verify \
  --name glm \
  --profile coding
```

The verification checks:

- Server readiness
- The `/v1/models` endpoint
- A short code-generation request
- A best-effort OpenAI-format tool-call request

This distinction matters: a process listening on port 8080 does not necessarily mean the model, chat template, and tool-calling path are working correctly.

## Test GLM-5.2 directly

Before adding Pi, make one direct request:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "rondine/glm-5.2",
    "messages": [
      {
        "role": "user",
        "content": "Write a typed Python binary search function. Return code only."
      }
    ],
    "max_tokens": 512
  }'
```

If this works, the inference layer is ready. Pi becomes a client of the same endpoint.

## Install Pi

Pi is a minimal coding agent with four core tools:

- `read`
- `write`
- `edit`
- `bash`

Install it with:

```bash
npm install -g --ignore-scripts \
  @earendil-works/pi-coding-agent
```

Pi can connect to custom OpenAI-compatible providers through:

```text
~/.pi/agent/models.json
```

Add Rondine as a provider:

```json
{
  "providers": {
    "rondine": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "rondine",
      "models": [
        {
          "id": "rondine/glm-5.2",
          "name": "GLM-5.2 local via Rondine",
          "contextWindow": 32768
        }
      ]
    }
  }
}
```

Most local llama.cpp servers do not validate the API key, but Pi expects a non-empty value.

Use the exact model identifier returned by:

```bash
curl http://127.0.0.1:8080/v1/models
```

## Start coding with Pi

Move into a repository and launch Pi:

```bash
cd ~/Projects/my-application
pi
```

Inside Pi, open the model selector:

```text
/model
```

Choose:

```text
GLM-5.2 local via Rondine
```

Pi now supplies the agent loop while Rondine owns the inference lifecycle.

A useful first prompt is something constrained and verifiable:

```text
Read the project structure and test configuration.

Find one untested error path in the HTTP client, add a focused test,
run only the relevant test suite, and show me the resulting diff.
Do not modify production code unless the test reveals a real defect.
```

This exercises reading, editing, shell execution, and multi-step reasoning without giving the model permission to refactor the entire repository.

## Add cmux if you want the complete stack

cmux remains optional, but it makes the workflow easier to observe.

A practical layout is:

- **Pane 1:** Rondine server logs
- **Pane 2:** Pi running in the target repository
- **Pane 3:** Shell for health checks, Git, and memory monitoring

Start Rondine in the foreground if you want logs attached to a pane:

```bash
rondine serve \
  --preset glm-coding \
  --name glm \
  --foreground
```

Start Pi in another:

```bash
cd ~/Projects/my-application
pi
```

The architecture remains modular:

```text
cmux
  ├── Rondine
  │     └── llama.cpp
  │           └── GLM-5.2 UD-IQ2_M
  └── Pi
        └── http://127.0.0.1:8080/v1
```

Swap Pi for another OpenAI-compatible coding client and the inference layer stays unchanged. Swap GLM-5.2 for a smaller model and Pi's workflow stays unchanged.

## If GLM-5.2 does not fit

Most developers do not have 256GB of unified memory. Rondine should reject GLM-5.2 on those machines—that is better than discovering the limitation after a 239GB download.

Use the same workflow with a smaller model:

```bash
rondine suggest --profile coding
```

Typical alternatives include:

- Qwen3.6 27B for 24–48GB Macs
- Qwen3.6 35B-A3B for larger Macs or 24GB NVIDIA GPUs
- Gemma 4 12B for smaller systems
- DeepSeek-V4-Flash at 3-bit for approximately 128GB systems

For a quick end-to-end test, Rondine also includes Qwen2.5-Coder 3B:

```bash
rondine plan qwen2.5-coder-3b \
  --context 4096 \
  --save-as small-coder

rondine pull qwen2.5-coder-3b
rondine serve --preset small-coder
rondine verify --name small-coder
```

The Pi configuration is identical apart from the model ID.

This is the main advantage of separating the agent from inference: the workflow does not depend on one model fitting forever.

## Stopping and restarting

Stop the managed GLM server with:

```bash
rondine stop --name glm
```

Restart the saved configuration later:

```bash
rondine serve \
  --preset glm-coding \
  --name glm
```

Inspect it at any time:

```bash
rondine preset show glm-coding
```

The tuned command is no longer something you have to recover from shell history.

## Honest limitations

This setup does not make GLM-5.2 small.

The recommended quant still occupies approximately 239GB, and a 256GB Mac leaves limited headroom. Large contexts may require reducing batches, using a smaller context, or moving to hardware with more memory.

Rondine currently provides a hardware-aware configuration, not a published GLM-5.2 performance guarantee. Its documented benchmark is a smaller Qwen2.5-Coder run on an M2 Pro; that validates the plan-to-API path but should not be presented as evidence of GLM-5.2 throughput.

Tool calling also depends on the model, llama.cpp version, chat template, and streaming compatibility. Run `rondine verify`, test Pi on a disposable branch, and inspect the server logs before trusting a long autonomous session.

## Bottom line

The local coding stack works best when its layers remain replaceable:

- **Rondine** chooses, configures, downloads, and serves the model.
- **llama.cpp** performs inference.
- **Pi** reads, edits, and runs commands in the repository.
- **cmux**, optionally, keeps the sessions visible.

GLM-5.2 is the demanding case that makes hardware-aware planning valuable. On a compatible 256GB machine, Rondine turns a 239GB sharded GGUF and a page of llama.cpp flags into a named, inspectable preset exposed at a standard OpenAI URL.

Pi does not need to know how any of that works. It only needs:

```text
http://127.0.0.1:8080/v1
```

That is the useful abstraction: a very large local model underneath, a very small coding agent on top, and a standard API boundary between them.

---

**Links**

- [Rondine on GitHub](https://github.com/antonellof/rondine)
- [The Local Agent Trio: cmux + Pi + Unsloth Studio](/2026/cmux-pi-unsloth-local-glm-setup/)
- [Pi coding agent](https://github.com/earendil-works/pi)
- [GLM-5.2 GGUF weights](https://huggingface.co/unsloth/GLM-5.2-GGUF)


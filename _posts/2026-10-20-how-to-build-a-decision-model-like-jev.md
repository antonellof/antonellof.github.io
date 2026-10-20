---
layout: post
title: "How to Build a Decision Model Like Jev"
date: 2026-10-20
categories: [Deep Dive]
tags: [AI, LLM, Inference, Decision Models, Jev, Qwen, Calibration, Tree Batching, Tokenizers, Hugging Face, Laya]
image: /assets/images/posts/jev-readout-architecture.png
excerpt: "Autoregressive decoding is the wrong tool when software needs a fast, calibrated probability over a fixed set of outcomes. Here is how System-One decision models work from the inside: Hugging Face's new /v1/systemone endpoint for turning 250+ LLMs and VLMs into zero-shot decision engines, reserved option tokens and readout heads, calibration with soft labels, tree-batched serving, and what black-box probing reveals about TypeSafe's Jev."
---

In my [LLM inference roadmap](https://www.fratepietro.com/2026/llm-inference-learning-roadmap/), I split every model call into two phases. **Prefill** reads the prompt in parallel and is compute-bound. **Decode** emits output tokens one at a time, reading the entire weight matrix from HBM on every step, and is memory-bandwidth bound.

Most software decisions do not want text generation at all. Routing a support ticket, gating a risky tool call for human review, scoring an incident rubric from 1 to 5, or producing the `P(bullish)` signal I used in [Laya Trader](https://www.fratepietro.com/2026/laya-trader-paper-trading-small-local-model/) all ask for a probability distribution over a known set of outcomes. Calling `/v1/chat/completions` for those tasks pays the decode tax for dozens of tokens, hopes the JSON parser survives, and still leaves you without a trustworthy probability.

TypeSafe's [Jev](https://docs.typesafe.ai/models) (`POST /v1/systemone`) replaced that loop with a typed contract. You send one **state** (a document, JSON record, or ticket) and a map of named **questions** about that state:

- **`choice`:** pick one option out of up to 255 candidates
- **`noul`:** return a binary yes/no probability (`P(true)`)
- **`score`:** rate on an ordered rubric of 2 to 10 levels

The model runs prefill once, generates zero output tokens, and returns a probability for every option.

Over the last two weeks, this interface moved from a proprietary API to an open pattern you run and train yourself. Hugging Face merged native [`/v1/systemone` support](https://huggingface.co/docs/transformers/serve-cli/serving#v1systemone) into `transformers serve`, turning 250+ open LLM and VLM architectures into logit-scoring decision models out of the box. And on [JevBench](https://benchmarkheaven.com/jev-models), small open-weight decision models like `SemIf` (`Qwen3.5-4B`, scoring `73.1`) and `Winnow-12B Q8` (`71.2`) now sit right behind hosted `Jev 1.13.0` (`74.4`) at roughly half the cost per thousand decisions.

This post walks through how to build and serve a decision model from the ground up: starting with Hugging Face's zero-shot `/v1/systemone` server, then fixing its ceilings with reserved option tokens, calibrating probabilities with temperature and soft targets, packing multi-question requests with tree batching, and examining how Jev itself is wired under the hood.

## 1. The fast path: turning any LLM or VLM into `/v1/systemone` with `transformers serve`

Before training a single weight, serve the `/v1/systemone` contract locally on top of an existing open checkpoint. Hugging Face's `transformers serve` CLI (added in PR `#49322`) formats your state and questions through the model's chat template with thinking disabled, runs one batched forward pass (`output_tokens: 0`), and slices the next-token logits at the assistant prefix:

```bash
pip install "transformers[serving]"
transformers serve

curl http://localhost:8000/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-1.5B-Instruct",
    "state": "Our integration has been failing for 3 days and we are losing sales!",
    "questions": {
      "team": {
        "type": "choice",
        "instructions": "Which team handles this?",
        "criteria": {
          "billing": null,
          "technical": "Bugs or integration problems"
        }
      },
      "urgency": {
        "type": "score",
        "instructions": "How urgent is this ticket?",
        "criteria": ["low", "medium", "high"]
      },
      "upset": {
        "type": "noul",
        "instructions": "Is the customer upset?"
      }
    }
  }'
```

The response maps each question key back to its probability distribution and a probability-weighted score:

```json
{
  "model": "Qwen/Qwen2.5-1.5B-Instruct",
  "answers": {
    "team": {
      "type": "choice",
      "choice": "technical",
      "probabilities": {"billing": 0.000007, "technical": 0.999993},
      "confidence": 0.999986
    },
    "urgency": {
      "type": "score",
      "score": 1.6739,
      "legend": {"0": "low", "1": "medium", "2": "high"},
      "probabilities": {"0": 0.0031, "1": 0.3198, "2": 0.6770},
      "confidence": 0.5109
    },
    "upset": {
      "type": "noul",
      "noul": 0.8520
    }
  },
  "usage": {"input_tokens": 213, "output_tokens": 0}
}
```

Because `transformers serve` runs on top of the standard `transformers` processor pipeline, it also supports **vision-language models**: passing an `images` array with up to four `data:image/...;base64,...` strings attaches those images to the shared state for every question in the call.

How does `transformers serve` score an off-the-shelf chat model without custom training? By default, it maps `choice` and `score` options to single-token letters `A` through `Z`, maps `noul` options to `Yes` and `No`, and takes the softmax over those token logits at `temperature = 1.0`.

When you move from a zero-shot chat model to a fine-tuned decision checkpoint, you pass `--decision-config decision.json` at startup:

```bash
transformers serve openjev/openjev --decision-config decision.json
```

```json
{
  "labels": {
    "noul": ["A", "B"]
  },
  "temperature": {
    "choice": 0.85,
    "score": 0.85,
    "noul": 1.5547129
  }
}
```

Those three fields in `decision.json` (`labels`, `temperature`, and `chat_template`) point straight at the three limits of zero-shot letter scoring. To understand why dedicated decision models beat zero-shot wrappers by 10 to 25 points on [JevBench](https://benchmarkheaven.com/jev-models), we need to look at what happens at the token and logit layer.

## 2. Moving past `A` to `Z`: reserved option tokens and the `<readout>` head

Scoring the logits of plain letters `A`, `B`, `C` at the end of a prompt breaks in three ways:

1. **Capacity stops at 26.** There are 26 letters in the Latin alphabet, whereas Jev's contract allows up to 255 options per question (which is why `transformers serve`'s default mode caps `choice` at 26 options). Labels like `AA` or `A1` tokenize into two separate IDs, which cannot be read from a single output position.
2. **Pre-training priors leak into your probabilities.** In a pre-trained LLM, the token `A` is an English indefinite article, a school grade, and the most common answer key on web multiple-choice exams. All of that prior mass sits on the logit before the model weighs your criteria.
3. **Slot position bias.** When I built [Laya vs Dijkstra](https://www.fratepietro.com/2026/laya-vs-dijkstra-path-solving-mlx/), my first maze navigator asked a 4-way `choice` question across `UP`, `DOWN`, `LEFT`, and `RIGHT`. When I tested all 24 permutations of assigning four fixed descriptions to those four slots, the best move won only **11 times out of 24**, because the model favored the `RIGHT` slot regardless of the text. On JevBench, reversing option order from `A. yes, B. no` to `A. no, B. yes` on an uncalibrated 4B model dropped yes/no accuracy from **72% to 21%**.

![How a decision model answers in one forward pass: prompt layout with reserved option tags placed after each option description and a final readout token, a single forward pass through the transformer backbone and output head, masking ordinary vocabulary logits to softmax only the option slots, plus the three typed readout heads and why letters A, B, C fail](/assets/images/posts/jev-readout-architecture.png)

A dedicated decision model solves this by adding **reserved option tokens** to the vocabulary (`<opt_0>`, `<opt_1>`, ..., `<opt_254>`) along with a dedicated **`<readout>`** token at the end of the sequence. Most tokenizers already include spare slots that never fired during pre-training (such as Gemma's `<unused0>`, `<unused1>`, ...). Otherwise, append new rows to the input embedding matrix and the output head matrix.

Three architectural details decide whether those reserved tokens train cleanly:

- **Place `<opt_k>` *after* each option's description, not before it.** Autoregressive transformers apply a causal mask, so information flows strictly left to right. When you format an option as `billing: Payments, invoices and payouts <opt_0>`, the hidden state at `<opt_0>` attends to the entire description of `billing`. If you place `<opt_0>` in front of the description like a bullet point (`<opt_0> billing: Payments...`), `<opt_0>` is blind to the option it represents.
- **Warm-start `<opt_k>` rows from existing letter embeddings.** Initializing 255 new rows with random Gaussian noise forces the backbone to spend early training steps figuring out that `<opt_k>` tokens act as selector handles. Copying the embedding and output rows of standard letter tokens (`A`, `B`, `C`, ...) and adding small perturbations lets the model reuse its pre-trained multiple-choice circuits from step one.
- **Shuffle option order on every training step.** Randomizing which option gets `<opt_0>` versus `<opt_4>` strips out positional bias and forces the output head at `<readout>` to route probability by content.

The same one-token readout handles all three question primitives:

- **`choice`:** Keep only the active `<opt_0..K-1>` logits at the `<readout>` position, apply softmax, and train with cross-entropy against the target option.
- **`noul`:** Reserve two tokens (`<yes>` and `<no>`) and take the 2-way softmax.
- **`score`:** Reserve one token per rank (`<lvl_1>` through `<lvl_10>`), tied permanently to the level's rank order regardless of prompt ordering. Train with cross-entropy plus a **ranked probability score (RPS)** distance penalty: if the ground-truth rating is `5`, putting probability mass on `4` receives a much smaller penalty than putting it on `1`.

Why read from the model's own vocabulary output head instead of freezing the transformer and fitting a small linear classifier probe on the last hidden state? Because the existing output projection matrix already shares the geometry of the model's 200k+ word vectors. Unfreezing the backbone (via full fine-tuning or all-layer LoRA) and reading the option rows from the native LM head consistently outperforms a frozen probe.

## 3. Calibration: temperature scaling, soft targets, and quantization drift

When application code uses a decision model's output as a number (`if p_fraud > 0.92: block_payout()`), argmax accuracy is only half the contract. A reported `0.90` probability needs to be right 90% of the time.

![Calibration diagram: on the left, Jev 1.13 reliability plot across 14,233 PopQA questions showing ECE of 0.022 overall alongside task-specific overconfidence and underconfidence zones, and on the right, the 50/30/20 marble bag test comparing true odds, Jev 1.13 one-hot overconfidence at 0.99, and Jev 1.14 soft-label calibration at 0.52/0.29/0.19](/assets/images/posts/jev-calibration-and-labels.png)

Fine-tuned transformers almost always drift toward steady overconfidence or underconfidence. The first correction is **temperature scaling**: divide the kept option logits by a positive scalar `T` before the softmax (`softmax(z / T)`). Values of `T > 1` spread probability mass out, values of `T < 1` sharpen it, and the top-ranked option never changes. Because binary, multi-way, and ordinal heads drift at different rates, fit a separate `T` for `choice`, `noul`, and `score` on a held-out validation set (mirroring how the `--decision-config` example earlier set `0.85` for `choice` and `1.5547` for `noul`).

Four calibration traps catch teams building their own pipeline:

1. **Tune `T` against your deployment scoring rule, not blind log-likelihood.** Fitting `T` by minimizing cross-entropy (negative log-likelihood) pushes uncertain answers toward the middle (`0.50`). If your downstream gate or benchmark penalizes answers in the middle band (for instance, counting a binary answer as wrong unless `p < 0.20` or `p > 0.80`), log-likelihood tuning actively wrecks your score. Sweep `T` directly against the cost function your system runs in production.
2. **Pooled ECE hides per-task and context-length drift.** Across 14,233 8-option PopQA questions (28,466 evaluations across both option orders), `Jev 1.13` posts an Expected Calibration Error (ECE) of **0.022**, hugging the `y = x` diagonal from `0.18` to `0.98`. Split by task, as the [Just Ask Jev](https://arxiv.org/abs/2609.29429) study also found, that single curve separates: the model is overconfident on theory of mind, sorting, and prompt injection, underconfident on spatial grid navigation, and grows progressively more overconfident as input document length climbs toward 32k tokens.
3. **Temperature cannot fix one-hot training labels on uncertain outcomes.** Suppose a prompt asks: *"A bag holds 50 red, 30 green, and 20 blue marbles. One is drawn at random. What color is the drawn marble?"* The true distribution is `0.50 / 0.30 / 0.20`. If every row in your training set has a one-hot winner (`1.0` on the plurality answer), cross-entropy teaches the model to amplify any plurality edge into near-certainty. That is why `Jev 1.13` answered **0.99 Red, 0.01 Green, 0.00 Blue**. `Jev 1.14` fixed that failure mode by training on soft probability targets, returning **0.52 Red, 0.29 Green, 0.19 Blue**. Wherever the ground truth is a distribution, train cross-entropy against the distribution.
4. **Re-verify calibration after quantization.** When I deployed [Laya Trader](https://www.fratepietro.com/2026/laya-trader-paper-trading-small-local-model/) on CPU, switching the checkpoint to `int8` quantization shifted `P(bullish)` by up to **0.38** on identical inputs and flipped 3 out of 11 trading decisions. In [Frink](https://www.fratepietro.com/2026/frink-rust-alternative-to-llama-cpp/), I check quantized backends against reference logits by KL divergence (`frink parity`) for the exact same reason: a quantization scheme that preserves greedy top-1 text generation still distorts tail probabilities enough to trip a numeric threshold.

## 4. Serving at flat latency: why prefix caching stalls and how tree batching works

Eliminating the decode loop explains why one question answers in ~150 to 250 ms. It does not explain how a decision server answers 32 or 64 questions about the same 8,000-token or 30,000-token document with almost zero extra latency.

![Serving multi-question requests: naive vLLM prefix caching handles 257,920 tokens for 32 questions on an 8k state at 524 ms, whereas tree batching packs one sequence of 9,920 tokens (26x less work, 150 ms) using a block-diagonal tree attention mask and shared branch position IDs](/assets/images/posts/jev-tree-batching-serving.png)

If you wire a multi-question `/v1/systemone` endpoint on top of [vLLM](https://github.com/vllm-project/vllm) the naive way, you expand `N` questions into `N` separate sequences (`state + q_1`, `state + q_2`, ..., `state + q_N`) and rely on prefix caching so the GPU computes the state's KV blocks once. Latency still climbs steeply with `N` for two systems reasons:

- **Host-side prefix cache bookkeeping scales as `N × (S + L)`.** Even when every KV block of an `S = 8,000` token state sits hot in HBM, the serving engine still parses, hashes, and looks up all 8,000 state tokens for each of the `N = 32` sequences (`257,920` tokens handled by the server vs `9,920` unique tokens). At `S = 30,000` and `N = 64` (`L = 60` tokens per question), the server processes **1.92 million tokens** of cache lookups for roughly **34,000 tokens** of real GPU compute, a **57x** host overhead.
- **Scheduler slot contention.** Continuous batching schedulers cap how many sequences and tokens enter a forward step. Splitting one HTTP request into 64 sequences forces those 64 branches to queue against each other and against every other caller on the box.

**Tree batching** removes both bottlenecks by packing the entire request into **one sequence** of length `S + N × L`:

1. **Lay out the state once, then concatenate all `N` question branches.** In the diagram above, a 4-token state (`s1..s4`) followed by three 2-token questions (`q1a,q1b`, `q2a,q2b`, `q3a,q3b`) becomes a single 10-token buffer. Questions that share an instruction prefix share an internal node in the tree too.
2. **Apply a block-diagonal tree attention mask.** State tokens attend causally to earlier state tokens. Question tokens in branch `i` attend to all state tokens (`s1..s4`) and causally to earlier tokens inside branch `i`, while masking out every sibling branch `j ≠ i`.
3. **Reset RoPE position IDs per branch.** Every question branch starts its position IDs immediately after the state (`p4, p5` for `q1`, `p4, p5` for `q2`, `p4, p5` for `q3`). Because both the attended KV keys/values and the rotary position embeddings are identical to running that question in isolation, the logits at every branch's `<readout>` token match separate sequences bit-for-bit.
4. **Extract all `N` `<readout>` vectors from one forward pass.** And when a caller sends `N = 1` question, skip the custom tree mask and route straight through the engine's standard FlashAttention causal fast path.

TypeSafe's documented context limits for Jev show this exact tree structure in the numbers. Jev enforces **32k tokens per question** and **64k tokens per request** (with an opt-in header raising both to 262k). In a packed tree, `32k` caps a single root-to-leaf path (`S + L`, the maximum context any one question attends to), while `64k` caps the packed buffer (`S + N × L`, counting the state once). If the server duplicated the state per question, two questions on a 30k document would already blow past a 64k request ceiling. [Archer Hume's black-box latency study](https://archerhume.com/posts/jevs-architecture-unmasked/) confirmed the same single-state, batched-branch behavior empirically.

## 5. Under the hood of a production decision model: what black-box probing reveals about Jev

TypeSafe describes Jev as a non-autoregressive transformer ([The Batch](https://www.deeplearning.ai/the-batch/models-built-to-do-one-thing-well)) and keeps its base model and training recipe closed. Because a decision model must assign a probability distribution across whatever options you pass it, it cannot refuse a prompt the way a chat model does. Combined with the exact `usage.input_tokens` count returned on every API call, that property lets you fingerprint a black-box decision model across five independent tests.

![Five black-box clues pointing to Qwen3.5-35B-A3B: self-identification probabilities putting Qwen first at 0.63, sensitive China question correlation at r = 0.79 with Qwen3.5-35B-A3B, PopQA rare-fact accuracy matching at 63% with 59% identical wrong answers, and one-pass reasoning scores on MMLU-Pro, fresh math, and unit conversion](/assets/images/posts/jev-qwen-forensics.png)

### Identity, alignment priors, and rare-fact error matching

1. **Direct identity probes.** Asked about its own identity across 14 model families (`Qwen`, `Gemini`, `Claude`, `ChatGPT`, `DeepSeek`, `Grok`, `Kimi`, `Llama`, `GLM`, `Mistral`, `Phi`, `Gemma`, `Jev`, and a synthetic floor `Zorblax`) across five prompt framings and both option orders, `Jev 1.13` ranks **Qwen** first in nearly every format: **0.71** averaged across question types, and **0.63** in head-to-head prompts against `"something else"`. Its own product name, `Jev`, gets **0.12 to 0.13**.
2. **Pre-training alignment priors.** Fine-tuning changes how a model answers, not the worldviews baked into its pre-training data. Across 60 questions with documented historical answers (sensitive China events, matched events elsewhere such as Kent State, the Gulag, and Japanese American internment, plus neutral facts), `Llama 3.3` and `Gemma 3` assign `1.00` to the documented answer on both sets. `Jev 1.13` and `Qwen3.5-35B-A3B` assign `1.00` on the non-China events and drop together on the 29 China questions (`0.14` and `0.04` on whether Xinjiang facilities are involuntary detention camps), with a question-by-question deviation correlation of **r = 0.79** (versus **-0.07** for Llama 3.3 and **-0.03** for Gemma 3).
3. **PopQA rare facts and shared mistakes.** Within the Qwen 3.5 family (which ranges from under 1B to `397B-A17B`), obscure factual recall pins down the exact size class. Across 14,233 8-option questions from [PopQA](https://huggingface.co/datasets/akariasai/PopQA) stratified by Wikipedia page views, `Jev 1.13` scores **63%**, matching **[Qwen3.5-35B-A3B](https://huggingface.co/Qwen/Qwen3.5-35B-A3B)** (**63%**, a 35B Mixture-of-Experts model with ~3B active parameters per token) and **[Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B)** at every popularity tier. Even stronger is the error fingerprint: when both models miss a question, Jev picks the **exact same wrong option out of 7 distractors as Qwen 35B-A3B 59% of the time** (chance is `14%`, non-Qwen pairs sit at `36% to 52%`, and two Qwen 35B-A3B point releases agree `65%` of the time).

### One-pass reasoning without chain-of-thought

If Jev sits on a 35B-A3B backbone and answers in a single prefill pass with zero reasoning tokens, how does it beat non-thinking `Qwen3.5-35B-A3B` on hard reasoning tasks?

- **[MMLU-Pro](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro) (1,499 questions, 10 options):** Jev scores **83%** in one pass, beating non-thinking `Qwen3.5-35B-A3B` (**60%**) and non-thinking `Qwen3.5-397B-A17B` (**71%**), and nearly matching the 35B model's full *thinking* score (**85%**).
- **Fresh code-generated math (125 questions, 10 options):** Generated on the day of the test so no checkpoint saw them in training. Jev hits **87%** vs **51%** for non-thinking 35B-A3B.
- **Unit conversion (80 questions, 4 options):** Jev hits **100%** vs **40%** for non-thinking 35B-A3B.

You get that jump in one of two ways: distilling multi-step answers from a strong thinking model (`Qwen` or OpenAI's [gpt-oss-120b](https://huggingface.co/openai/gpt-oss-120b)) into one-pass readout labels, or generating synthetic tasks where code computes and verifies the exact answer. On the [Latent Space podcast](https://www.latent.space/p/jev), TypeSafe founder Diogo Almeida described that exact synthetic loop: all their training data is synthetic with *"programs in the loop"*, and on online RL rollouts he noted *"zero is the optimal amount for our shape"*.

That also demystifies **RLCD** (Reinforcement Learning for Calibrated Decisions), the label TypeSafe gives its training stage. When a program generates the task and knows the exact answer or probability distribution, you do not need PPO rollouts. Standard cross-entropy against program-verified soft labels trains a calibrated one-pass readout directly.

### Vocabulary surgery: splicing Qwen 3.5 and GPT-4o

Sending a prompt with and without a candidate substring and diffing `usage.input_tokens` tells you whether that substring is a single token in the server's vocabulary. Reconstructing Jev's tokenizer token by token uncovers a **145,072-token vocabulary** spliced from Qwen 3.5 (`248,044` tokens) and GPT-4o / `gpt-oss` (`199,998` tokens):

![Vocabulary surgery diagram: Qwen 3.5's 248,044 tokens and GPT-4o's 199,998 tokens spliced into Jev's 145,072-token vocabulary by keeping 134,608 shared tokens, dropping 113,436 Qwen-only tokens, and adding 10,463 composite GPT-4o tokens via Fast Vocabulary Transfer, alongside the Wembley tokenization example and non-Latin token multipliers](/assets/images/posts/jev-vocabulary-surgery.png)

- **134,608 tokens kept:** virtually every token present in both Qwen 3.5 and GPT-4o.
- **113,436 tokens dropped:** every token unique to Qwen 3.5 (mostly Chinese and multilingual tokens), cutting the embedding and output projection matrices by ~40%.
- **10,463 tokens added from GPT-4o:** almost every added token is a **join of two kept Qwen pieces** (for instance, `"embley"` in `" Wembley"`, built from kept tokens `"em"` + `"bley"`).

That third bullet is the unmistakable signature of [Fast Vocabulary Transfer](https://arxiv.org/abs/2402.09977) (also implemented in mergekit's [tokensurgeon](https://github.com/arcee-ai/mergekit/blob/main/docs/tokensurgeon.md)) applied to an already-trained Qwen 3.5 checkpoint. When you add a composite token `"embley"` to a trained model, you initialize its input embedding row and output head row as the **average of its two constituent rows** (`"em"` and `"bley"`), then fine-tune so the spliced rows settle in. Adding a token with no existing pieces in the base model would require learning its vector from random noise.

Pruning 113,436 tokens and stripping BPE merge rules shrinks the memory footprint of the input and output tables on English traffic (`1.0x` token count relative to Qwen 3.5), at the cost of a steep token tax on other scripts: **~1.7x** more tokens on Chinese, **~2.0x** on Russian, Greek, Arabic, and Japanese, and **~4.0x** on Thai. Because the API bills per input token, non-English states pay that multiplier on every call.

## 6. Choosing your decision model stack

If you want to replace slow, uncalibrated chat completions with typed probability readouts today, you have four concrete options:

![Four ways to run a typed-decision model: comparing Hosted Jev API on Qwen3.5-35B-A3B MoE, zero-shot LLM or VLM serving via Hugging Face transformers serve /v1/systemone, a small local encoder like Laya on 322M mmBERT-base, and a fine-tuned 4B to 12B causal LLM with reserved readout tokens and tree batching](/assets/images/posts/jev-decision-model-options.png)

1. **Small local bidirectional encoder ([Laya](https://github.com/NandhaKishorM/laya) / [laya-mlx](https://github.com/mizorewww/laya-mlx)) for sub-30 ms edge and high-frequency loops.** Laya's 322M `mmBERT-base` checkpoint runs a bidirectional pass over state and question in ~15 ms on my M2 Pro (`32.8 ms` median in PyTorch) at `0.0029 USD` per 1,000 decisions on JevBench. It is fast and free to run locally, and works well when you decompose multi-way routing into batched `noul` checks and keep inputs under its 512-token window.
2. **Zero-shot LLM or VLM via Hugging Face [`transformers serve` (`/v1/systemone`)](https://huggingface.co/docs/transformers/serve-cli/serving#v1systemone) for instant local prototyping and multimodal states.** You get the System One HTTP contract in one command across 250+ open models, including base64 image inputs on VLMs. Start here to wire your application against `/v1/systemone`, then supply a `--decision-config` file once you fit per-type temperatures and custom label tokens.
3. **Hosted Jev API for broad zero-shot coverage over long documents and wide question batches.** A `Qwen3.5-35B-A3B` MoE distilled on program-verified synthetic tasks with tree batching gives top-tier zero-shot accuracy across 32k per-question and 64k per-request contexts at ~200 to 650 ms (`0.0399 USD` per 1,000 decisions on JevBench). Watch the 2x to 4x token multiplier if your inputs are non-Latin, and remember that the model carries its base checkpoint's knowledge and alignment priors.
4. **Fine-tuned 4B to 12B causal decision model for high-volume production decisions inside your VPC.** When your service runs the same routing, moderation, triage, or rubric evaluation thousands of times a day, a smaller open backbone (such as `Qwen3.5-4B` or `Gemma 3 12B`) trained with reserved `<opt_0..N>` and `<readout>` tokens, option shuffling, soft probability targets on uncertain labels, per-type temperature scaling, and a tree-batched attention mask matches or nearly matches a 35B general model at half the serving cost and keeps every document on your own GPUs.

---

*Sources and related reading: Hugging Face, [Transformers Serve CLI: `/v1/systemone`](https://huggingface.co/docs/transformers/serve-cli/serving#v1systemone), TypeSafe, [Jev Model Documentation](https://docs.typesafe.ai/models), [JevBench v1.3 Leaderboard](https://benchmarkheaven.com/jev-models), Archer Hume, [Jev's Architecture, Unmasked](https://archerhume.com/posts/jevs-architecture-unmasked/), [Just Ask Jev](https://arxiv.org/abs/2609.29429), [Replacing Large Language Models with Jev Decision Models for Low-Latency Edge Service Orchestration](https://huggingface.co/papers/2609.22753), [Fast Vocabulary Transfer](https://arxiv.org/abs/2402.09977), Diogo Almeida on the [Latent Space podcast](https://www.latent.space/p/jev), and my earlier posts on [LLM Inference: a learning roadmap](https://www.fratepietro.com/2026/llm-inference-learning-roadmap/), [Frink Inference](https://www.fratepietro.com/2026/frink-rust-alternative-to-llama-cpp/), [Laya vs Dijkstra](https://www.fratepietro.com/2026/laya-vs-dijkstra-path-solving-mlx/), and [Laya Trader](https://www.fratepietro.com/2026/laya-trader-paper-trading-small-local-model/).*

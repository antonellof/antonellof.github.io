---
layout: post
title: "Do Jailbreaks Transfer to Fine-Tuned LLMs? Building a Lineage Attack Surface Analyzer"
date: 2026-11-09
categories: [Security]
tags: [AI Security, LLM Security, Jailbreak, Red Teaming, Fine-Tuning, Open-Weight Models, GCG, HarmBench, Research]
image: /assets/images/posts/lasa-jailbreak-transfer-header.jpg
description: "LASA (Lineage Attack Surface Analyzer) tests whether jailbreaks found on an open-weight base model carry over to its fine-tunes, and the bugs it caught."
excerpt: "If you ship fine-tunes of an open-weight model, can the base model tell you which jailbreaks to test first? LASA (Lineage Attack Surface Analyzer) is my attempt at a controlled answer, and building it surfaced three measurement bugs worth knowing about."
---

<figure>
  <img src="{{ '/assets/images/posts/lasa-jailbreak-transfer-header.jpg' | absolute_url }}" alt="Jailbreak Inheritance. Attack suffixes optimized on a source model fan out to two child and two sibling checkpoints, each marked with a question mark: does the attack transfer?">
</figure>

Most fine-tuned models people deploy start from the same few open-weight checkpoints. A Qwen or Llama Instruct model gets fine-tuned for code, for a language, for routing, for a customer's support tickets. If you own five of those derivatives, you can't red-team all of them deeply every time. You have to pick where to look first.

The base model is the obvious place to start. You have the weights, you can run gradient-based attacks on it, and every derivative carries some of it inside. So I wanted to know: **if I find jailbreaks on the base model, does that tell me which ones will still work on the fine-tunes?**

That question became [LASA](https://github.com/antonellof/lineage-attack-surface-analyzer), short for **Lineage Attack Surface Analyzer**. The name is the idea: a fine-tuned model has a lineage (the base model it came from), and LASA analyzes how much of the base model's attack surface, the jailbreaks that work on it, comes down that lineage. It's a defensive research harness with a [preprint](https://github.com/antonellof/lineage-attack-surface-analyzer/blob/main/paper/PAPER.pdf). This post covers what it does, why the controls matter, and the three bugs that would have quietly invalidated the whole study.

One thing up front: there is no transfer result yet. What exists is the protocol, the code, and a small pilot that checks the plumbing.

## Why the question isn't settled

Others have looked at this. Angell et al. tested transfer across 20 open-weight models and linked it to attack strength on the source and to how similar the two models' internal representations are. Tan et al. went closest to my setting: they optimized GCG prompts on pretrained models and found they transfer best to those models' own fine-tunes.

Both papers mostly measure raw attack success, though. If a fine-tune already answers a harmful request with no attack at all, a high "attacked" success rate tells you nothing about transfer. It just tells you the fine-tune lost its refusals.

So LASA asks a narrower, more defensive question. Does the source suffix make the derivative comply **more than it would anyway**? And can scores measured only on the source pick the attacks with the biggest effect, better than picking at random?

## The setup

<figure>
  <img src="{{ '/assets/images/posts/lasa-lineage.png' | absolute_url }}" alt="One source, many derivatives. Qwen2.5-1.5B-Instruct is the source, where attacks are optimized. Its declared children are TinySwallow (primary target) and Arch-Router (task control). Its siblings are Qwen2.5-Coder and Qwen2.5-Math, which share the same pretrained base.">
  <figcaption>The Qwen protocol. A Llama 3.2 protocol follows the same shape with fewer targets.</figcaption>
</figure>

The source is Qwen2.5-1.5B-Instruct. The targets are models whose model cards say they come from it (children) or from the same pretrained base (siblings). Small models on purpose: everything runs locally, on checkpoints anyone can download, which is also the only scope the tool allows. A target needs an authorization record before LASA will touch it.

The attack is GCG, through [nanoGCG](https://github.com/GraySwanAI/nanoGCG). It uses the source model's gradients to find a string of tokens that, appended to a harmful request, pushes the model toward a target answer like "Sure, here is...". Requests come from [JailbreakBench](https://jailbreakbench.github.io/).

The rule that matters most: **search only ever happens on the source**. Once the suffixes are found, they are frozen. Target outputs are measurements, never feedback.

<figure>
  <img src="{{ '/assets/images/posts/lasa-study-design.png' | absolute_url }}" alt="How LASA tests transfer. Step 1: nanoGCG optimizes one suffix per behavior on Qwen2.5-1.5B for 250 steps, then freezes them. Step 2: each derivative gets four conditions: bare request, random suffix of the same token length, a suffix optimized for a different behavior, and the source suffix for this behavior. Step 3: the HarmBench classifier labels every output and two blinded people audit a sample. The question: does D beat A and B, and do source scores pick the right attacks?">
</figure>

Each derivative then gets four versions of every request:

- **Bare.** The request alone. This is the baseline compliance rate.
- **Random suffix.** Benign tokens of the same length. Does any junk at the end of the prompt change the answer?
- **Mismatched suffix.** A real GCG suffix, but one optimized for a different request. This separates "this attack transfers" from "adversarial-looking text confuses the model".
- **Source suffix.** The one actually optimized for this request.

A separate HarmBench classifier labels every output, and two people label a shuffled sample without seeing the classifier's verdict. If the humans don't agree with the classifier, the classifier's numbers don't become claims.

The plan is frozen before any search runs: which behaviors, which split, model hashes, the code digest, the decision rules. LASA writes a commitment file and refuses to start the search until that file is committed to git, so anyone can check that the rules came before the results.

I also ran a power analysis before running anything. With 20 held-out behaviors, the study can detect an average uplift of roughly 14 to 28 percentage points. A real but small effect, say 5 points, would most likely come back as a null. I'd rather say that now than discover it in the results.

## Three bugs that looked fine

The most useful part of this project so far wasn't an attack result. It was going through my own pipeline before the full run and finding that it measured the wrong thing in three places. None of them threw an error.

<figure>
  <img src="{{ '/assets/images/posts/lasa-three-bugs.png' | absolute_url }}" alt="Three ways the study measured the wrong thing. 1, different tokens: joining request and suffix into one string and re-tokenizing changed all three test suffixes; fix by building every prompt the way nanoGCG does. 2, wrong template: the Mistral-based HarmBench classifier was fed the Llama-2 classifier's prompt template; fix by using the template from its own model card. 3, first-token CKA: mean-pooled similarity was dominated by position 0, 99.5% of the vector's norm in the middle layers; fix by dropping position 0.">
</figure>

**1. The prompt wasn't the prompt that was optimized.** nanoGCG tokenizes three pieces separately: the chat template up to the suffix, the suffix, and the rest. My code built `request + " " + suffix` as one string and tokenized it again. Tokenizers don't work that way: merging across the boundary gives different IDs. On the Qwen2.5 tokenizer all three test suffixes changed, and one changed length (55 tokens instead of 54). So every source score described a prompt that was never actually sent to a model. Now every condition is built with the same split as nanoGCG, and a regression test reproduces nanoGCG's reported loss from the evaluated IDs to within 0.001.

**2. The judge was reading the wrong template.** HarmBench has two classifiers: the official Llama-2-13B one and a Mistral-7B validation one, which is what fits on my machine. I was feeding the Mistral classifier the Llama-2 classifier's prompt template. It still returned clean yes/no labels, which is exactly why nobody would notice. Now the rubric file has to name its classifier, and the template comes from that model's card at a pinned revision.

**3. The similarity numbers were mostly about one token.** Earlier runs compared source and target with CKA over hidden states averaged across all tokens of short benign probes. The middle layers looked almost identical, up to 1.000 for Llama 3.2 and Dolphin. Too good. Under causal attention the first position carries a huge state that doesn't depend on the rest of the text, and it turned out to supply 99.5% of the pooled vector's norm in the middle layers. The "similarity" was mostly measuring the first token. New measurements drop position 0.

The third one is also why I narrowed the project. It started from a bigger hypothesis: that transfer could be predicted from source attack strength and from representational similarity. Testing similarity properly needs many derivatives per source, and two lineages with a handful of targets can't do that. So the prospective study tests the source-only part, and similarity is left as an open question.

## Where it stands

The pilot is deliberately tiny: Qwen2.5-1.5B-Instruct and TinySwallow, two behaviors, five GCG steps, 24 generations. All 24 were scored by the classifier without a parse failure, and all 24 came back negative. Five search steps is far too few to break the source model, and LASA reports exactly that (`attack_inadequate_on_source`) rather than calling it a robustness result. The pilot also predates the three fixes, so it validates execution only.

There was one small thing in the data I liked: the child model wrote much longer answers (a median of 128 tokens, hitting the budget 9 times out of 12) than the source (median 29.5). It means nothing about harm, since everything was labeled safe, but it's why LASA reports output length next to every label. A truncated answer and a refusal are different things.

Next is the full Qwen run: 40 behaviors, 250-step searches, four targets, about 4,000 generations, then the human audit. After that, the Llama protocol.

If the source suffixes don't beat the controls, that's a useful answer too, as long as the attack worked on the source first. The adequacy rule makes sure a failed search doesn't get reported as a safe model.

## Try it

The code, protocol and paper are on GitHub: [antonellof/lineage-attack-surface-analyzer](https://github.com/antonellof/lineage-attack-surface-analyzer).

```sh
pip install -e ".[dev,models]"
pytest
lasa study --help
```

The pilot needs about 20 GB of model downloads. Raw generations and suffixes stay in a gitignored folder; only aggregate numbers get published.

If you work on model safety for fine-tuned deployments, I'd like to hear whether this question matches how you prioritize red-teaming, and which lineages you'd want in the next protocol.

---
layout: post
title: "Google Cloud's Agentic AI Blueprint: From Design Patterns to Private Inference Networking"
date: 2026-10-08
categories: [Architecture]
tags: [Google Cloud, Agentic AI, ADK, MCP, A2A, GKE, Inference Gateway, Private Service Connect, Model Armor, Apigee]
excerpt: "Google's Architecture Center now has a full agentic AI library, and this week a networking reference for serving models behind it. Here is how the pieces fit: pick a design pattern, pick components, then decide how inference calls actually reach a GPU."
---

Most agent demos stop at the interesting part: the model reasons, calls a tool, answers. The questions that decide whether it survives production come after that. Which pattern do I use? Where does the agent run? Who is allowed to call the model, and how does that call travel across my network?

Google Cloud has quietly answered most of those in public. The [agentic AI architecture guides](https://docs.cloud.google.com/architecture/agentic-ai-overview) in the Cloud Architecture Center are now a small library of reference designs. This week's [networking for AI inference blog post](https://cloud.google.com/blog/topics/developers-practitioners/networking-for-ai-inference-model-serving-gke-only-and-for-all-other-backends) by Ammett Williams adds the layer underneath: how requests reach the model.

This post reads them as one story, top to bottom. If you want the execution-durability layer on top of this, see my earlier posts on [Google AX](https://www.fratepietro.com/2026/google-ax-distributed-agent-runtime/) and [Agent Substrate](https://www.fratepietro.com/2026/agent-substrate-zero-idle-kubernetes/).

## The stack in one picture

![The agentic AI stack on Google Cloud: frontend, agent framework, design pattern, tools, memory, agent runtime, network entry, model runtime and models, with IAM, Model Armor, Apigee, Cloud Trace and VPC Service Controls running across all layers](/assets/images/posts/google-agentic-stack.png)

Google's [component guide](https://docs.cloud.google.com/architecture/choose-agentic-ai-architecture-components) names exactly these building blocks: frontend framework, development framework, tools, memory, design patterns, agent runtime, models, and model runtime. The networking post fills in the "network entry" row, which is the one most often skipped.

## Step 1: choose a design pattern (and start small)

The [design pattern guide](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system) opens with advice I wish more teams followed: if the task is predictable or fits in one model call, you may not need an agent at all. Summarizing, translating, and classifying feedback are examples it gives. If you do need one, start with a **single agent** and refine its prompt and tools before adding architecture.

When a single agent degrades (more tools, more latency, wrong tool choices), the guide lays out a menu. I find it easiest to remember by asking whether the *workflow* or the *model* decides the next step:

| Who decides the flow | Pattern | Use it for |
|---|---|---|
| Fixed code | **Sequential** | Repeatable pipelines: extract → clean → load |
| Fixed code | **Parallel** | Independent sub-tasks fanned out, then synthesized |
| Fixed code | **Loop / iterative refinement** | Repeat until a quality bar or iteration cap |
| Fixed code | **Review and critique** | Generator plus critic, e.g. a security-auditor agent |
| The model | **Coordinator** | Dynamic routing: order status vs. return vs. refund |
| The model | **Hierarchical decomposition** | Research, planning, synthesis over several levels |
| The model | **Swarm** | Debate between agents, no central supervisor |
| The model | **ReAct** | Thought → action → observation until done |
| Human | **Human-in-the-loop** | Approvals, high-stakes or compliance steps |
| You | **Custom logic** | Mixed patterns with conditional branches |

The trade-offs are stated plainly in the guide, and they are the real content:

- Sequential is cheap and fast but rigid.
- Parallel cuts latency but burns more tokens and needs a gather step that can reconcile conflicting results.
- Loops risk running forever if the exit condition is wrong. Always set a max iteration count.
- Coordinator, hierarchical, and swarm patterns multiply model calls, so cost and latency go up. Swarm is the most expensive and the one that may never converge.

My rule: a deterministic workflow agent (sequential, parallel, loop) should be your default for anything you can draw as a flowchart. Reach for model-driven orchestration only where the input genuinely varies.

## Step 2: choose components

A few recommendations from the component guide that I think are right:

**Tools.** Pick by situation: built-in tools for web search and code execution, **MCP** for reusable, interoperable tools, an **API management platform** (Apigee API hub) for enterprise-scale governance, and custom function tools for one-off integrations. The guide makes a distinction worth remembering: MCP standardizes *how an agent talks to a tool*; API management governs *the endpoint's lifecycle and security* (auth, rate limits, monitoring). They are complementary, not competing.

**Tool bloat is a named failure mode.** Too many tool definitions dilute the model's attention, hurting accuracy and raising cost. The mitigations are concrete:

- Keep tools under five parameters, use primitives, and prefer `enum`s to free text.
- Split monolithic MCP servers into focused toolsets per user journey.
- Use progressive disclosure: a search tool that loads schemas on demand, Agent Skills, or delegation to a sub-agent with a smaller context.

**Memory.** Keep agents stateless and put session state in an external store (Memorystore for Redis, Firestore, or Agent Platform Sessions). In-memory state is fine for development and loses everything on restart. Long-term memory belongs in a persistent service such as Memory Bank.

**Models.** Use a strong model for orchestration and route simpler, structured tasks to a smaller one. The guide also covers controlling the *thinking budget*: more thinking tokens can improve planning and also add latency and cost.

**Agent-to-agent.** Use **A2A** between agents and ADK for composition. A2A mandates HTTPS in production and delegates auth to standard mechanisms like OAuth2, with requirements advertised in each agent's Agent Card.

## Step 3: put it together

The [multi-agent reference architecture](https://docs.cloud.google.com/architecture/multiagent-ai-system) wires these into a concrete system:

![Multi-agent reference flow: a coordinator routes to a sequential pattern or an iterative refinement loop, with a human-in-the-loop path, and both end at a response generator](/assets/images/posts/google-agentic-multiagent-flow.png)

Three ideas from its security and operations sections apply to any agent system:

1. **Human oversight, bounded autonomy, observability.** Google's stated principles. Business-critical agents get a human-in-the-loop path, each agent gets least-privilege IAM, and every reasoning step and tool call is traced.
2. **Evaluate trajectories, not only answers.** Check the steps the agent took, not just the final output.
3. **Baseline QPS and TPS before you scale.** Cost management starts with knowing your normal. The guide suggests starting from the most cost-efficient model and moving up, and using context caching and batching where they apply.

## Step 4: how the model call actually travels

This is the part the new networking post adds, and the part I see skipped most often. Your agents call a model. In an enterprise, that call should not leave a private network, should be authenticated and rate-limited, and should be screened for prompt injection and data leakage, both on the way in and on the way out.

Both reference designs share three pieces:

- A **Private Service Connect inference endpoint** that anchors the entry point inside your VPC on a private internal IP.
- **Apigee** (optional) via an extension processor callout for client identity, rate limits, and quotas before any compute is touched.
- **Model Armor** as an inline checkpoint on prompts and completions.

They differ in what sits behind the entry point.

### Pattern A: GKE only

For models on GKE, the entry point is the **GKE Inference Gateway**, deployed as an internal Application Load Balancer (`gke-l7-rilb`). It is more than a load balancer: it reads the request body, evaluates `HTTPRoute` rules, and picks an **inference pool**, which is a group of replicas of the same model.

![GKE Inference Gateway flow: PSC endpoint, read model from body, Apigee, Model Armor, HTTPRoute to an inference pool, then replica selection by prefix cache and load, with the response verified by Model Armor on the way back](/assets/images/posts/google-inference-gke-gateway.png)

Step 5 is why this is interesting. The gateway does not round-robin. According to the post, it matches shared prefix cache context and routes to the lowest-load replica using real-time Prometheus data. If you have read my [LLM inference roadmap](https://www.fratepietro.com/2026/llm-inference-learning-roadmap/), this is the KV cache showing up at the network layer: sending a request to the replica that already holds its prefix saves prefill work.

### Pattern B: all backends

Real estates are mixed: GKE, Cloud Run, Agent Platform, on-prem, another cloud. For that case Google uses a **regional internal Application Load Balancer** plus a **Service Extension** callout:

![All-backends flow: PSC endpoint to a regional internal Application Load Balancer, a Cloud Run payload processor injecting the X-Gateway-Model-Name header, Apigee and Model Armor, then one network endpoint group per backend type](/assets/images/posts/google-inference-all-backends.png)

The body-based routing that the Inference Gateway does natively has to be bolted on here as a lightweight Cloud Run callout, because a load balancer's URL map routes on headers and not on JSON payloads. Once the header exists, a Network Endpoint Group per backend does the rest.

### Which one

| If your models are... | Use | You get | You pay |
|---|---|---|---|
| All on GKE GPUs/TPUs | Inference Gateway | Model-aware routing, prefix-cache and load awareness | GKE-only |
| Spread across runtimes, hybrid, or external | Regional ALB + payload processor | One front door for every backend | A callout to run, and no replica-level routing intelligence |

For an agent platform, the second option has a nice property. Agents see one OpenAI-compatible endpoint and one model-name parameter, and you can change what is behind each name (swap a hosted model for a self-hosted one) without touching agent code.

## What I would do with this

1. **Start with one agent and one pattern.** Prefer workflow agents (sequential, parallel, loop) until the input is genuinely variable.
2. **Make MCP the tool boundary and Apigee the governance boundary.** Cap tool count and parameters per agent.
3. **Put one private endpoint in front of all model traffic** from day one, with identity, quota, and Model Armor in the path. This is far cheaper to design in than to retrofit.
4. **Pick the networking pattern by backend diversity**, not by fashion: GKE only → Inference Gateway; mixed → ALB with a payload processor.
5. **Trace trajectories and set iteration caps**, then add durable execution (see [AX](https://www.fratepietro.com/2026/google-ax-distributed-agent-runtime/)) once runs get long.

## Caveats

- These are **reference architectures**, not turnkey products. Expect to adapt them, and read the full documents for the deployment details I have summarized here.
- The patterns that give the best answers (hierarchical, swarm, review loops) are also the ones that multiply tokens and latency. Budget for that before you pick them.
- The all-backends design adds a hop and a component you operate (the payload processor). That cost is worth it only if you really have several backend types.
- The agentic guides evolve. The overview page I started from was last reviewed in November 2025, while the pattern guide shows a May 2026 review. Check dates before you copy a design.

---

*Sources: [Networking for AI inference model serving](https://cloud.google.com/blog/topics/developers-practitioners/networking-for-ai-inference-model-serving-gke-only-and-for-all-other-backends) (Google Cloud Blog, October 6, 2026), [Agentic AI architecture guides](https://docs.cloud.google.com/architecture/agentic-ai-overview), [Choose your agentic AI architecture components](https://docs.cloud.google.com/architecture/choose-agentic-ai-architecture-components), [Choose a design pattern for your agentic AI system](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system), and [Multi-agent AI system in Google Cloud](https://docs.cloud.google.com/architecture/multiagent-ai-system).*

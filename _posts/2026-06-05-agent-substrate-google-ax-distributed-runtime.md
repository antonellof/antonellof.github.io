---
layout: post
title: "Agent Substrate and Google AX: The Missing Runtime Layer for Production Agents"
date: 2026-06-05
categories: [Architecture]
tags: [Agent Substrate, AX, Agent Executor, Kubernetes, gVisor, Agentic AI, MCP, Distributed Systems]
excerpt: "In May 2026, Google open-sourced AX (Agent Executor) for durable distributed agent loops — and paired it with Agent Substrate, an independent Kubernetes compute layer that multiplexes stateful sessions across a small pod pool. They are not the same project. Here's what each solves, how they stack, and why your LangGraph deployment is not enough."
render_with_liquid: false
---

Your agent demo works. Your agent in production does not.

The demo runs on a laptop with one process, one terminal, one SQLite file for memory. Production has three tenants, seventeen concurrent sessions, a pod that OOM-killed during a 40-minute research task, and a user who refreshed the browser and lost the entire conversation because nothing was durable.

We have excellent **agent frameworks** — [LangGraph](https://www.langchain.com/langgraph), [ADK](https://google.github.io/adk-docs/), [AutoGen](https://microsoft.github.io/autogen/), [CrewAI](https://www.crewai.com/). We have **models** getting smarter every quarter. What we conspicuously lack is a **runtime**: the layer that makes long-running, stateful, distributed agents behave like software instead of haunted scripts.

In May 2026, two complementary open-source projects landed aimed squarely at that gap — easy to conflate, but **not the same thing**:

- [**Agent Substrate**](https://github.com/agent-substrate/substrate) — an **independent** open-source project (under the `agent-substrate` org) that is **not** an officially supported Google product. It is a Kubernetes-native compute layer that multiplexes thousands of stateful "actors" onto a small pool of worker pods.
- [**AX (Agent Executor)**](https://github.com/google/ax) — **Google's** open-source distributed agent runtime with durable event logs, resumption, auditing, and trajectory forking.

They are designed to work together — AX lists Substrate as its recommended Kubernetes deployment target, and Google's [GKE blog](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate) highlights both — but Substrate is its own project with its own repo, community, and disclaimers. Substrate answers *"where does the agent process live?"* AX answers *"how does the agentic loop coordinate, recover, and get audited?"*

Both are in **very early development**. Both say so loudly. That honesty is refreshing — and the architecture is worth understanding now, before the APIs freeze.

## The production problem nobody tweets about

Agents are not web servers. A web server handles thousands of short requests and stays warm. An agent handles one long request, goes idle waiting for human approval, wakes up, calls three tools, forks a sub-agent, blocks on an MCP server, and dies mid-thought because the node ran out of memory.

Traditional Kubernetes is optimized for **thousands of long-running services**. Agent workloads look like **millions of sub-second activations** with long idle tails. Mapping one agent session to one Pod is economically absurd and operationally fragile. Mapping one agent session to one process on your laptop does not survive a deploy.

What you need:

1. **Suspend and resume** process state (RAM + filesystem) in milliseconds, not "restart and replay the prompt"
2. **Multiplex** idle agents onto shared hardware without them stepping on each other
3. **Durable execution logs** so disconnects, crashes, and human-in-the-loop pauses do not destroy progress
4. **Isolation** when agents run arbitrary code (bash, generated Python, MCP tools)
5. **Auditability** — who called what tool, when, with what policy?

Frameworks solve reasoning. Runtimes solve *reliability at scale*. The industry is finally open-sourcing that second layer — with Google leading on orchestration (AX) and a separate community project handling compute density (Substrate).

## Agent Substrate: actors on a pod budget

[Agent Substrate](https://github.com/agent-substrate/substrate) is **not** a Google product. The README states plainly: *"This is not an officially supported Google product."* It lives under the [`agent-substrate`](https://github.com/agent-substrate) GitHub org, ships Apache 2.0, and has its own [ate-dev community](https://groups.google.com/g/ate-dev) — a Google Group for discussion, not a sign of corporate ownership.

What it **is**: infrastructure for **running** agents at scale — **not** an SDK for building them. Substrate is a control plane on top of Kubernetes that maps many **actors** (agent sessions, sandboxes, MCP servers) onto fewer **workers** (Pods).

The core insight from the [launch demo](https://www.youtube.com/watch?v=ZEzkCFJkzjY): modern agents spend **upwards of 90% of their time** waiting — for models, tools, or humans. Standard cloud setups force a **stateful gap**: pay for expensive RAM to sit idle, or scale to zero and lose context. Substrate calls its answer a **zero-idle architecture** — session-centric, decoupling logical actors from physical workers so state can teleport across the cluster in under a second.

Two vocabulary words matter everywhere in the docs and demos:

- **Actor** — a logical session; a private instance of a specific agent (or any OCI workload)
- **Worker** — physical compute; in practice, a pre-initialized Kubernetes Pod in a warm pool

Actors are often **suspended upon creation**. They exist logically, cost the platform nothing while idle, and hydrate only when traffic arrives. That is the opposite of "one Pod per user session, billing 24/7."

### Watch the launch demo

The [Agent Substrate OSS Launch Demo](https://www.youtube.com/watch?v=ZEzkCFJkzjY) (~8 minutes) walks through the counter demo, a "secret agent" zero-idle pattern, and a boardroom UI stress test scaling to **~250 concurrent agents on eight GKE worker pods** — a **32:1 oversubscription ratio** in the video's climactic burst.

<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; margin: 1.5rem 0;">
  <iframe style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;" src="https://www.youtube.com/embed/ZEzkCFJkzjY" title="Agent Substrate OSS Launch Demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

### What the demo actually proves

The video is structured in three acts. Each maps to a [repo demo](https://github.com/agent-substrate/substrate#demos) you can reproduce locally.

**Act 1 — Counter: session teleport.** A Go HTTP server keeps an in-memory counter. The presenter creates an actor from a standard OCI image (already suspended), resumes it, and increments: 1, 2. They manually suspend via the Substrate API, then flood the cluster with other actors until the **original Pod is occupied by someone else**. In a traditional system, the counter would be stuck or cold-boot from scratch. Substrate resumes the actor on a **brand-new Pod** — the **Pod IP changes** — and the counter reads **3**. Living process memory, teleported; hardware stays anonymous.

**Act 2 — Secret Agent: zero-idle by default.** A toy agent returns its volatile "secret code" from RAM, then **calls the Substrate API to suspend itself** after each request. While waiting for input, it is suspended — logically present, **costing nothing**. The gateway intercepts inbound traffic and resumes the actor in milliseconds; when work finishes, the worker Pod is freed automatically. The presenter registers **24 agents on the same eight Pods**, triggers a parallel pulse, and watches Substrate multiplex them in real time: resume → handle → auto-suspend. **3:1 oversubscription** before the flashy finale.

**Act 3 — Boardroom UI: swarm at 30× density.** A visual layer built on the same APIs as `kubectl-ate` (workers at the bottom, actors in the middle). A "lead architect" actor lands on a Pod; sub-agents fan out in parallel. Unrelated users create **resource contention** — warm Pods get snatched — without context leakage. When planning finishes, the architect **hibernates to GCS**, vacating hardware entirely. A reviewer later recalls it onto a **different Pod** (IP `.117` → `.121`) with **in-memory state intact**. The stress finale dispatches **~250 concurrent agents** onto eight slots. The demo claims replacing **~45-second cold boots** with **sub-second rehydration**; treat the "97% efficiency" line as launch-stage marketing, but the mechanism — snapshot idle actors, free workers instantly — is the real story.

Full RAM and filesystem snapshots run through [gVisor](https://gvisor.dev/) checkpoint/restore under the hood. The team calls it "instant session teleport." After watching the Pod IP change while the counter keeps counting, that label feels fair.

### How it works (simplified)

```
                    ┌─────────────────────────────────┐
  HTTP / gRPC       │         atenet-router           │
  requests    ───►  │   (DNS + Envoy routing)         │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │         ate-apiserver           │
                    │   (actor lifecycle, scheduling) │
                    └──────────────┬──────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
    ┌────▼────┐              ┌─────▼─────┐             ┌─────▼─────┐
    │ Worker  │              │  Worker   │             │  Worker   │
    │  Pod A  │              │  Pod B    │             │  Pod C    │
    │         │              │           │             │           │
    │ actor 1 │◄─suspend──►  │ actor 47  │             │ actor 12  │
    │ actor 7 │   resume     │ actor 89  │             │           │
    └─────────┘              └───────────┘             └───────────┘
```

Kubernetes still provisions nodes, autoscaling, and networking. Substrate takes the **Kubernetes control plane out of the hot path** for actor scheduling — lower latency for wake/sleep cycles that happen constantly in agent workloads.

Key components from the [repo tour](https://github.com/agent-substrate/substrate):

| Component | Role |
|-----------|------|
| `ate-apiserver` | gRPC control plane — create, destroy, suspend, resume actors |
| `atelet` | Node DaemonSet — snapshotting, state transfer, worker supervision |
| `atecontroller` | Reconciles `WorkerPool` and `ActorTemplate` CRDs |
| `atenet` | DNS, Envoy routing, proxy sidecars |
| `ateom-gvisor` | In-pod helper for `runsc` checkpoint/restore |
| `kubectl-ate` | CLI — `kubectl ate create actor ...` |

### Framework-agnostic by design

Because Substrate manages **OCI containers at the kernel level** (gVisor sandboxing), it does not care what framework built the agent:

- **ADK** — session identity and persistent working memory
- **LangChain** — long-running stateful agents with sandboxed tool calls
- **Claude Code / Codex** — multiplexed coding environments with preserved terminal state
- **MCP servers** — durable, sandboxed tool actors

The [Counter Demo](https://github.com/agent-substrate/substrate/tree/main/demos/counter) proves state survives suspend cycles. The [Sandbox Demo (Antigravity)](https://github.com/agent-substrate/substrate/tree/main/demos/sandbox) runs arbitrary shell in Alpine with filesystem persistence. The [Claude Code Multiplex](https://github.com/agent-substrate/substrate/tree/main/demos/claude-code-multiplex) demo is exactly what it sounds like — many coding agents, few machines.

### Quickstart on kind

Local development is one script chain away:

```bash
git clone https://github.com/agent-substrate/substrate.git
cd substrate

hack/create-kind-cluster.sh
hack/install-ate-kind.sh --deploy-ate-system
hack/install-ate-kind.sh --deploy-demo-counter

go install ./cmd/kubectl-ate
kubectl ate create actor my-counter-1 --template ate-demo-counter/counter

kubectl port-forward -n ate-system svc/atenet-router 8000:80
```

Then increment the counter (note the Host header — actors are routed by name):

```bash
curl -X POST \
  -H "Host: my-counter-1.actors.resources.substrate.ate.dev" \
  -i http://localhost:8000/
```

Suspend the actor, resume it on another worker, counter state intact. That is the whole value proposition in one curl.

**Caveats:** Substrate is in VERY early development — APIs **will** change, and production use today is for the brave. Again: independent project, not Google-supported. Join the [ate-dev Google Group](https://groups.google.com/g/ate-dev) or CNCF Slack `#substrate-users` if you want to follow along.

## Google AX: the agentic loop with a flight recorder

If Substrate is *where* agents run, [**AX (Agent Executor)**](https://github.com/google/ax) is *how* agentic execution is coordinated, logged, and resumed.

Announced in Google's [May 2026 blog post](https://cloud.google.com/blog/products/ai-machine-learning/agent-executor-googles-distributed-agent-runtime), AX is a **distributed agent runtime** with:

- **Single-writer controller** — one source of truth for execution state
- **Durable event log** — SQLite-backed by default; replay on recovery
- **Resumable streams** — clients reconnect with `--last-seq` and catch up
- **Trajectory forking** — branch execution at any checkpoint without losing history
- **Isolated actors** — agents, tools, skills, and sandboxes as separate processes

```
  Client
    │
    │  resumable stream
    ▼
  Router ──► AX Controller ──┬──► Remote Agent (isolated actor)
              (event log,     ├──► Tool / MCP server (isolated actor)
               registry)      └──► Environment / skills (isolated actor)
```

AX is explicitly **not**:

- A managed service (self-hosted only)
- An agent framework (bring LangGraph, ADK, whatever)
- A coding harness (Antigravity integration is on the roadmap, not the product)
- Model-specific (Gemini agent included, not required)

That discipline matters. The industry keeps conflating "agent product" with "agent runtime." Google is drawing the line.

### The CLI experience

Install and run:

```bash
go install github.com/google/ax/cmd/ax@latest

# Local execution with built-in planner + bash tool
ax exec --input "List files in this directory"

# Long-running server mode
ax serve   # listens on :8494 by default

# Resume after disconnect — replay from sequence 12
ax exec \
  --conversation d85a4b4e-c53b-4c84-b879-f10d905bce40 \
  --last-seq 12 \
  --resume

# Fork a conversation at a checkpoint — branch without destroying source
ax fork \
  --src-conversation 38460323-9a78-41cb-8991-022b0ff2c19c \
  --dest-conversation e5e26e38-53a2-4f22-b1cb-ae867357df83 \
  --src-seq 12

# Visualize execution in a local web UI
ax trace --conversation 1a6e0b29-87c2-4af0-81ac-0c73bf8fa293
```

The `ax trace` command alone tells you who this is for — engineers who have stared at corrupted agent state at 2am and wanted a **flight recorder**, not another chat UI.

Configuration lives in `ax.yaml`:

```yaml
server:
  address: ":8494"

eventlog:
  sqlite:
    filename: "eventlog/log.sqlite"

planner:
  gemini:
    model: "gemini-3.5-flash"
    timeout: "60s"
    skills_dir: "./examples/skills"

registry:
  remote_agents:
    - id: "medical-deep-researcher"
      name: "Medical Deep Researcher"
      description: "Deep medical research via pubmed and clinicaltrials.gov"
      address: "localhost:50051"
```

Remote agents implement `AgentService` gRPC ([`proto/ax.proto`](https://github.com/google/ax/blob/main/proto/ax.proto)). ADK agents, [A2A protocol](https://github.com/a2aproject/A2A) bridges, and experimental Colab agents ship as examples. The bash tool requires **explicit user approval** before running — a small detail that signals production thinking.

### What resumption actually means

Three different "resume" problems get conflated in agent systems:

| Problem | AX mechanism | Substrate mechanism |
|---------|--------------|-------------------|
| Client disconnected mid-stream | `--last-seq` event replay | (transparent to client) |
| Agent crashed mid-task | Event log + `--resume` on controller | Actor snapshot restore via gVisor |
| User wants to branch exploration | `ax fork` from checkpoint | New actor from template |

Substrate handles **compute state** (process memory, filesystem). AX handles **execution semantics** (which agent spoke, which tool fired, what was the plan). You want both for agents that run longer than a coffee break.

The [AX demo on Substrate](https://www.youtube.com/watch?v=L5Iw1IrZ6Nc) shows the combined stack — AX coordinating distributed actors that Substrate suspends and multiplexes underneath.

## How the stack fits together

Think of three layers:

```
┌─────────────────────────────────────────────────────────┐
│  Application: your agents, tools, skills, MCP servers │
├─────────────────────────────────────────────────────────┤
│  AX: execution coordination, event log, resumption,     │
│      auditing, trajectory fork, policy gates            │
├─────────────────────────────────────────────────────────┤
│  Agent Substrate: actor lifecycle, suspend/resume,        │
│      gVisor isolation, routing, 30x oversubscription    │
├─────────────────────────────────────────────────────────┤
│  Kubernetes: nodes, networking, autoscaling, storage    │
└─────────────────────────────────────────────────────────┘
```

This is a different layer than **inference orchestration** (routing tokens to GPUs — projects like [Cognitora](https://github.com/antonellof/cognitora-inference) live there) or **local inference** (running models on a MacBook — [DwarfStar 4](https://github.com/antirez/ds4) lives there). Substrate + AX sit between your framework and your cluster, answering operational questions frameworks were never meant to solve.

Google's [GKE integration blog](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate) frames the partnership from the Kubernetes side: Agent Sandbox on GKE plus Substrate as the agent-first compute abstraction — while AX provides the runtime on top. Google is integrating with Substrate; it did not author it.

## Why now?

A few forces converged:

1. **Agents got long.** Multi-hour research, coding sessions, and HITL workflows are normal now — not edge cases.
2. **Agents got distributed.** Tools, sub-agents, and MCP servers want isolation. Monolithic agent processes are a security and reliability nightmare.
3. **Kubernetes hit limits.** Scheduling a new Pod per agent session does not scale to millions of activations. The control plane becomes the bottleneck.
4. **Enterprises want sovereignty.** Managed agents are convenient; proprietary workflows need self-hosted runtimes with audit trails. AX is Google's nod to "own your stack."

The GitHub numbers tell the story: [AX at ~1.6k stars](https://github.com/google/ax), [Substrate at ~480 stars](https://github.com/agent-substrate/substrate) — modest by viral standards, but these are infrastructure repos, not demo apps. The interesting metric is who is watching: platform teams, not hobbyists.

## Honest limitations (read this before you migrate)

Both projects ship with flashing warning signs:

**Agent Substrate (independent project, not Google):**
- VERY early development — APIs guaranteed to change
- Explicitly **not** an officially supported Google product
- gVisor snapshot path is complex; distributed state recovery has edge cases
- PRs may not merge unless aligned with core roadmap

**AX:**
- Active early development — **PRs temporarily paused**
- Resumable streaming protocols **will break** before stable release
- Self-hosted only — you operate it
- Reach out to `ax-dev@google.com` for collaboration, not drive-by PRs

If you need something that works next Monday, keep your agents on plain Kubernetes Jobs and a Postgres session table. If you are designing infrastructure for the next three years of agent deployments, this stack — Google's AX plus the independent Substrate compute layer — is the most serious open-source attempt at a dedicated agent runtime I have seen land this year.

## Where this leaves builders

The agent stack is finally separating into layers the way web development did decades ago:

| Layer | Examples | Question it answers |
|-------|----------|-------------------|
| Model | Gemini, Claude, DeepSeek, local DS4 | What generates tokens? |
| Framework | LangGraph, ADK, CrewAI | How is agent logic structured? |
| Runtime | **AX** | How is execution durable and auditable? |
| Compute | **Agent Substrate** | Where do processes live at scale? |
| Cluster | Kubernetes, GKE | How is hardware managed? |

Most teams have the top two rows. Almost nobody has the middle two. That is why agents feel magical in demos and exhausting in production.

My suggestion: run the Substrate counter demo on `kind` this weekend. Install `ax`, execute something trivial, disconnect your terminal, `--resume` with `--last-seq`, then `ax trace` the result. It takes an hour. You will know immediately whether this architecture matches problems you actually have.

The frameworks are not going anywhere. The runtime layer is just finally showing up.

---

*Agent Substrate (independent): [github.com/agent-substrate/substrate](https://github.com/agent-substrate/substrate). AX (Google): [github.com/google/ax](https://github.com/google/ax) and [agentexecutor.io](https://agentexecutor.io). Announcements: [Agent Executor blog post](https://cloud.google.com/blog/products/ai-machine-learning/agent-executor-googles-distributed-agent-runtime) (May 20, 2026), [GKE + Substrate blog post](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate).*

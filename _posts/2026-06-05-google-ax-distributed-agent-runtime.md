---
layout: post
title: "Google AX: A Distributed Agent Runtime with Durable Execution"
date: 2026-06-05
categories: [Architecture]
tags: [AX, Agent Executor, Google, Agentic AI, Event Log, Resumption, MCP, Distributed Systems]
excerpt: "Google open-sourced AX (Agent Executor): a self-hosted distributed agent runtime with durable event logs, resumable streams, trajectory forking, and isolated actors. Not a framework, not a managed service — the orchestration layer production agents are missing."
render_with_liquid: false
---

Your agent remembers the conversation until someone refreshes the browser.

Then it does not. No event log. No checkpoint. No way to resume mid-task after a deploy, a pod eviction, or a human-in-the-loop pause that lasted six hours. The framework handled the reasoning loop beautifully. Nobody handled **execution durability**.

In 2026, Google open-sourced [**AX (Agent Executor)**](https://github.com/google/ax) — a **distributed agent runtime** that coordinates agentic loops, logs every step, recovers from failures, and audits tool calls through a single controller. It is explicitly **not** an agent framework, **not** a managed service, and **not** tied to one model. It is the **orchestration layer** — *how* execution proceeds, resumes, and gets inspected.

For **where** agent processes physically run at scale (suspend, multiplex, teleport across Pods), see the companion post on [Agent Substrate](https://www.fratepietro.com/2026/agent-substrate-zero-idle-kubernetes/) — the other open-source project Google's GKE team shipped at the same time, and the recommended Kubernetes target for AX.

## Why agents need a runtime, not just a framework

[LangGraph](https://www.langchain.com/langgraph), [ADK](https://google.github.io/adk-docs/), [AutoGen](https://microsoft.github.io/autogen/) — excellent for structuring agent logic. They do not give you:

- **Durable execution** across crashes and deploys
- **Connection recovery** when the client disconnects mid-stream
- **Trajectory branching** to explore alternatives without destroying history
- **Centralized auditing** of every skill, tool, and sub-agent call
- **Isolated actors** for tools, sandboxes, and remote agents in distributed harnesses

As agents evolve from chat assistants to **autonomous long-running workers**, those gaps stop being edge cases. Google's [announcement blog](https://cloud.google.com/blog/products/ai-machine-learning/agent-executor-googles-distributed-agent-runtime) frames AX as the open foundation every sophisticated agentic application will need — built in public so design decisions get validated before APIs freeze.

AX is in **active early development**. PRs are temporarily paused. Protocols **will** break. Read the warnings; the architecture still matters.

## What AX provides

AX ships as a Go runtime plus an `ax` CLI:

- **Single-writer controller** — one source of truth for execution state
- **Durable event log** — SQLite by default; replay on recovery
- **Resumable streams** — clients reconnect with `--last-seq` and catch up
- **Trajectory forking** — `ax fork` branches at any checkpoint
- **Isolated actors** — agents, tools, skills, sandboxes as separate processes

```
  Client
    │
    │  resumable stream
    ▼
  Router ──► AX Controller ──┬──► Remote Agent (isolated actor)
              (event log,     ├──► Tool / MCP server (isolated actor)
               registry)      └──► Environment / skills (isolated actor)
```

### What AX is NOT

Google is explicit — and the discipline is refreshing:

- **Not a managed service** — self-hosted; you operate it
- **Not an agent framework** — bring LangGraph, ADK, whatever
- **Not a coding harness** — Antigravity integration is roadmap, not product
- **Not model-specific** — built-in Gemini agent included, not required

The industry keeps conflating "agent product" with "agent runtime." AX draws the line.

## The CLI: flight recorder for agentic execution

```bash
go install github.com/google/ax/cmd/ax@latest

# Local execution with built-in planner + bash tool
ax exec --input "List files in this directory"

# Server mode
ax serve   # :8494 by default

# Client disconnected? Catch up from sequence 12
ax exec \
  --conversation d85a4b4e-c53b-4c84-b879-f10d905bce40 \
  --last-seq 12 \
  --resume

# Branch exploration without destroying source history
ax fork \
  --src-conversation 38460323-9a78-41cb-8991-022b0ff2c19c \
  --dest-conversation e5e26e38-53a2-4f22-b1cb-ae867357df83 \
  --src-seq 12

# Visualize execution in browser
ax trace --conversation 1a6e0b29-87c2-4af0-81ac-0c73bf8fa293
```

`ax trace` tells you the audience — engineers who wanted a **flight recorder**, not another chat UI.

### Configuration (`ax.yaml`)

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

Remote agents implement `AgentService` gRPC ([`proto/ax.proto`](https://github.com/google/ax/blob/main/proto/ax.proto)). Examples ship for native remote agents, [ADK (Python)](https://github.com/google/ax/tree/main/examples/adk_agent), [A2A protocol](https://github.com/a2aproject/A2A) bridges, and experimental Colab agents.

The built-in planner includes a **bash tool** with **explicit user approval** before execution — small detail, production thinking.

### Custom agents in three terminals

**Terminal 1** — remote agent server:

```bash
go run examples/remote_agent/main.go   # :50051
```

**Terminal 2** — AX controller:

```bash
ax serve
```

**Terminal 3** — execute:

```bash
ax exec --server localhost:8494 \
  --input "HELLO, CAN YOU LOWERCASE WHAT I JUST SAID?"
```

Register remote agents in `ax.yaml` under `registry.remote_agents`. Point `ax exec --agent coding` at any registered ID.

## Three "resume" problems — and who solves what

"Resume" means different things. AX and [Agent Substrate](https://www.fratepietro.com/2026/agent-substrate-zero-idle-kubernetes/) solve different ones:

| Problem | AX | Substrate |
|---------|-----|-----------|
| Client disconnected mid-stream | `--last-seq` event replay | Transparent to client |
| Process crashed mid-task | Event log + `--resume` | gVisor snapshot restore |
| Branch exploration | `ax fork` from checkpoint | New actor from template |

**AX** owns **execution semantics** — which agent spoke, which tool fired, what was the plan.

**Substrate** owns **compute state** — RAM, filesystem, Pod placement.

Long-running agents need both. AX on bare metal or plain Kubernetes works; on Kubernetes, Google recommends [deploying AX on Substrate](https://github.com/google/ax/blob/main/manifests/README.md) for actor resumption at the compute layer. Watch the [combined demo](https://www.youtube.com/watch?v=L5Iw1IrZ6Nc).

## Deployment on Kubernetes

AX is compute-agnostic but aims for the best experience on Kubernetes:

```bash
# Install CLI
go install github.com/google/ax/cmd/ax@latest

# Production path: AX + Agent Substrate
# See manifests/README.md in the ax repo
```

Google's [GKE blog](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate) covers Agent Sandbox on GKE plus Substrate as the agent-first compute layer — with AX as the runtime on top. Both AX and Substrate came out of Google's GKE/agent infrastructure work and were announced together; Substrate carries the standard "not an officially supported Google product" disclaimer, but it is a Google-originated open-source project, not a third-party one.

## Roadmap

From the [AX README](https://github.com/google/ax):

1. Antigravity as built-in harness
2. Bring Your Own Harness (BYOH)
3. Suspension/resumption of subagents
4. Tool call approvals in subagents
5. Resumption protocol improvements

Resumable streaming and agent communication protocols are **actively evolving** — plan for breaking changes.

## Where AX sits in the stack

| Layer | Examples | Question |
|-------|----------|----------|
| Model | Gemini, Claude, DeepSeek | What generates tokens? |
| Framework | LangGraph, ADK, CrewAI | How is logic structured? |
| **Runtime** | **Google AX** | How is execution durable and auditable? |
| Compute | [Agent Substrate](https://www.fratepietro.com/2026/agent-substrate-zero-idle-kubernetes/) | Where do processes live at scale? |
| Cluster | Kubernetes, GKE | How is hardware managed? |

Most teams have models and frameworks. Almost nobody has the runtime and compute rows. That is why demos feel magical and production feels haunted.

## Honest limitations

- Active early development — **PRs temporarily paused**
- Resumable streaming protocols **will break** before stable release
- Self-hosted only — you operate clusters, logs, backups
- Collaboration via `ax-dev@google.com`; file issues freely

If you need something Monday, use Postgres for session state and pray. If you are building agent infrastructure for the next few years, install `ax`, run `ax exec`, kill your terminal, `--resume` with `--last-seq`, then `ax trace` what happened. An hour well spent.

## Federating deployment models

Google positions AX as a bridge between deployment models — on-prem sovereignty, managed frontier agents, custom LangGraph/ADK builds, A2A-connected agents. You own models, harnesses, and compute; AX provides the **execution contract**: event log, resumption, audit, isolation.

Enterprise adoption of agents needs that contract open-sourced. Google shipped it. Whether it becomes the Linux of agent runtimes or a reference implementation depends on the next twelve months of API stability and community adoption.

---

*AX: [github.com/google/ax](https://github.com/google/ax), [agentexecutor.io](https://agentexecutor.io). Announcement: [Agent Executor blog post](https://cloud.google.com/blog/products/ai-machine-learning/agent-executor-googles-distributed-agent-runtime). Companion post: [Agent Substrate — zero-idle Kubernetes](https://www.fratepietro.com/2026/agent-substrate-zero-idle-kubernetes/).*

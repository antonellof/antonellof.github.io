---
layout: post
title: "Agent Substrate: Zero-Idle Kubernetes for Stateful AI Agents"
date: 2026-06-03
categories: [Architecture]
tags: [Agent Substrate, Kubernetes, gVisor, Agentic AI, MCP, Zero-Idle, Infrastructure]
excerpt: "Agent Substrate is an independent open-source project — not a Google product — that multiplexes thousands of stateful agent sessions onto a small pool of Kubernetes pods. Zero-idle architecture, gVisor snapshots, and 32:1 oversubscription. Here's how session teleport actually works."
render_with_liquid: false
---

Your agent demo works. Your agent in production bleeds money.

The demo keeps one process warm on a laptop. Production maps one user session to one Kubernetes Pod, bills you for RAM while the agent waits on a model, a tool, or a human, and still loses context when you scale to zero. Modern agents spend **upwards of 90% of their time idle** — yet standard cloud setups force a brutal choice: pay for expensive memory to sit empty, or cold-boot and lose volatile state.

[**Agent Substrate**](https://github.com/agent-substrate/substrate) is an **independent** open-source project (under the `agent-substrate` org) aimed at that compute problem. It is **not** an officially supported Google product — the README says so explicitly. What it provides is a **session-centric, zero-idle architecture** on Kubernetes: decouple logical **actors** from physical **workers**, suspend and resume process state in under a second, and multiplex many stateful sessions onto a small warm pod pool.

This is the **compute layer** for agent infrastructure — where processes live, hibernate, and teleport. For the **orchestration layer** (event logs, trajectory forking, audit trails), see the companion post on [Google AX](https://www.fratepietro.com/2026/google-ax-distributed-agent-runtime/).

## The stateful gap Kubernetes does not solve

Agents are not web servers. A web server handles thousands of short requests. An agent handles one long request, goes idle, wakes up, calls tools, blocks on MCP, and dies mid-thought because the node OOM'd.

Traditional Kubernetes optimizes for **thousands of long-running services**. Agent workloads look like **millions of sub-second activations** with long idle tails. One Pod per session is economically absurd. One process per laptop does not survive a deploy.

Substrate targets three operational needs at the **hardware** level:

1. **Suspend and resume** RAM + filesystem in milliseconds — not "restart and replay the prompt"
2. **Multiplex** idle sessions onto shared workers without cross-talk
3. **Isolate** arbitrary code execution via sandboxed OCI containers

Frameworks solve reasoning. Substrate solves **density and session mobility**.

## What Agent Substrate is (and is not)

[Agent Substrate](https://github.com/agent-substrate/substrate) is **not** an SDK for building agents. It is infrastructure for **running** them — a control plane on top of Kubernetes that maps many **actors** onto fewer **workers** (Pods).

It is also **not** a Google product. It lives under [`agent-substrate`](https://github.com/agent-substrate), ships Apache 2.0, and has its own [ate-dev community](https://groups.google.com/g/ate-dev). Google integrates with Substrate (GKE blogs, [AX deployment guide](https://github.com/google/ax/blob/main/manifests/README.md)) — that is partnership, not ownership.

Two vocabulary words appear in every demo and doc:

- **Actor** — a logical session; a private instance of an agent or any OCI workload
- **Worker** — physical compute; typically a pre-initialized Pod in a warm pool

Actors are often **suspended upon creation**. They exist logically, cost nothing while idle, and hydrate when traffic arrives. Substrate's core innovation is this **decoupled lifecycle** — rapid suspend/resume on any worker, state persisting independent of underlying hardware.

## Watch the launch demo

The [Agent Substrate OSS Launch Demo](https://www.youtube.com/watch?v=ZEzkCFJkzjY) (~8 minutes) walks through the counter demo, a "secret agent" zero-idle pattern, and a boardroom UI scaling to **~250 concurrent agents on eight GKE worker pods** — a **32:1 oversubscription ratio**.

<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; margin: 1.5rem 0;">
  <iframe style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;" src="https://www.youtube.com/embed/ZEzkCFJkzjY" title="Agent Substrate OSS Launch Demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

### What the demo actually proves

The video has three acts. Each maps to a [repo demo](https://github.com/agent-substrate/substrate#demos).

**Act 1 — Counter: session teleport.** A Go HTTP server keeps an in-memory counter. Create an actor (suspended), resume, increment: 1, 2. Manually suspend, flood the cluster until the **original Pod is occupied**. Substrate resumes on a **new Pod** — **IP changes** — counter reads **3**. Living memory, new hardware.

**Act 2 — Secret Agent: zero-idle by default.** A toy agent returns a volatile secret from RAM, then **self-suspends via the Substrate API**. While waiting, it costs nothing. The gateway resumes on inbound traffic in milliseconds; the worker frees automatically after work. **24 agents on eight Pods** — **3:1 oversubscription** — multiplexed in a parallel pulse.

**Act 3 — Boardroom UI: swarm at 30× density.** Visual layer on the same APIs as `kubectl-ate`. A lead architect actor spawns sub-agents; contention steals warm Pods without leaking context. The architect **hibernates to GCS** when done; a reviewer recalls it on a **different Pod** (`.117` → `.121`) with state intact. Finale: **~250 agents, eight slots**. Demo claims **~45-second cold boots** replaced by **sub-second rehydration** — treat "97% efficiency" as launch marketing; the snapshot mechanism is the real story.

[gVisor](https://gvisor.dev/) checkpoint/restore handles RAM and filesystem snapshots. "Instant session teleport" is fair after you watch the counter survive a Pod swap.

## Architecture

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
    ┌────▼────┐              ┌─────▼─────┐             ┌─────▼─────┐
    │ Worker  │              │  Worker   │             │  Worker   │
    │  Pod A  │              │  Pod B    │             │  Pod C    │
    │ actor 1 │◄─suspend──►  │ actor 47  │             │ actor 12  │
    └─────────┘              └───────────┘             └───────────┘
```

Kubernetes provisions nodes and networking. Substrate takes the **Kubernetes control plane out of the hot path** for actor scheduling — critical when wake/sleep cycles happen constantly.

| Component | Role |
|-----------|------|
| `ate-apiserver` | gRPC control plane — create, destroy, suspend, resume actors |
| `atelet` | Node DaemonSet — snapshots, state transfer, worker supervision |
| `atecontroller` | Reconciles `WorkerPool` and `ActorTemplate` CRDs |
| `atenet` | DNS, Envoy routing, proxy sidecars |
| `ateom-gvisor` | In-pod `runsc` checkpoint/restore helper |
| `kubectl-ate` | CLI — `kubectl ate create actor ...` |

## Framework-agnostic by design

Substrate manages **OCI containers via gVisor** — it does not care what framework built the agent:

- **ADK** — session identity and persistent working memory
- **LangChain** — long-running stateful agents with sandboxed tools
- **Claude Code / Codex** — multiplexed coding environments with terminal state
- **MCP servers** — durable, sandboxed tool actors

Demos worth running: [Counter](https://github.com/agent-substrate/substrate/tree/main/demos/counter), [Sandbox (Antigravity)](https://github.com/agent-substrate/substrate/tree/main/demos/sandbox), [Claude Code Multiplex](https://github.com/agent-substrate/substrate/tree/main/demos/claude-code-multiplex), [Secret Agent](https://github.com/agent-substrate/substrate/tree/main/demos/agent-secret).

[**Google AX**](https://github.com/google/ax) lists Substrate as its recommended Kubernetes deployment target — AX coordinates agentic loops on top; Substrate provides the dense, resumable compute underneath. The [AX-on-Substrate demo](https://www.youtube.com/watch?v=L5Iw1IrZ6Nc) shows the full stack.

## Quickstart on kind

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

```bash
curl -X POST \
  -H "Host: my-counter-1.actors.resources.substrate.ate.dev" \
  -i http://localhost:8000/
```

Suspend, resume on another worker, counter still increments. One curl captures the value proposition.

GKE quickstart: `go run ./tools/setup-gcp --all` then `./hack/install-ate.sh --deploy-ate-system`. See the [README](https://github.com/agent-substrate/substrate) for teardown and partial deploy flags.

## Where Substrate sits in the stack

| Layer | Examples | Question |
|-------|----------|----------|
| Framework | LangGraph, ADK, CrewAI | How is agent logic structured? |
| Runtime | [Google AX](https://www.fratepietro.com/2026/google-ax-distributed-agent-runtime/) | How is execution durable and auditable? |
| **Compute** | **Agent Substrate** | Where do processes live at scale? |
| Cluster | Kubernetes, GKE | How is hardware managed? |

This is not **inference orchestration** ([Cognitora](https://github.com/antonellof/cognitora-inference)) or **local inference** ([DwarfStar 4](https://github.com/antirez/ds4)). Substrate is purely **session mobility and hardware efficiency** for agent-shaped workloads.

## Honest limitations

- **VERY early development** — APIs guaranteed to change
- **Not** an officially supported Google product
- gVisor snapshot path is complex; distributed recovery has edge cases
- PRs may not merge unless aligned with core roadmap

If you need production tomorrow, keep plain Kubernetes Jobs. If you are designing agent infrastructure for 2027, run the counter demo on `kind` this weekend — suspend an actor, steal its Pod, resume elsewhere, watch the counter keep counting.

---

*Agent Substrate: [github.com/agent-substrate/substrate](https://github.com/agent-substrate/substrate). Community: [ate-dev Google Group](https://groups.google.com/g/ate-dev), CNCF Slack `#substrate-users`. Companion post: [Google AX — distributed agent runtime](https://www.fratepietro.com/2026/google-ax-distributed-agent-runtime/).*

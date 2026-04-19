---
layout: post
title: "s0-cli: A Self-Optimizing Security Scanner via Meta-Harness"
date: 2026-04-19
categories: [Security]
tags: [LLM Agents, Static Analysis, SAST, Meta-Harness, AI Security, Optimization]
excerpt: "Most security tools encode their heuristics in scattered config files or undocumented engineer intuition. s0-cli encodes them in a versioned single-file Python agent that gets automatically rewritten by an outer optimization loop, scored against a labeled benchmark with a held-out test split. On openai/gpt-4o-mini the LLM triage layer cuts false positives by 30% on held-out tasks (10 → 7) without dropping a single true positive — held-out F1 climbs from 0.50 to 0.59 while keeping recall at 1.00."
---

Static security scanners give you a wall of JSON. Semgrep finds a `subprocess.run(..., shell=True)`; bandit flags an `md5` call; gitleaks shouts about a token-shaped string in a test fixture. You — the engineer — read every alert, decide which are real, trace data flow by hand, and then close the ones that don't matter. The scanner doesn't help with any of that. It can't, because it doesn't read source.

The natural next move is to wedge an LLM into the triage step: run the scanners, hand the findings to a model, ask it to mark false positives, assign severities, and write fix hints. That's the easy part. The hard part is the second-order question: *how do you know the LLM triage is good?* The standard answer in 2026 is "feels better on my test repo," which is the same answer 2018 had for hand-tuned semgrep rules and it didn't age well.

[**s0-cli**](https://github.com/antonellof/s0-cli) is an LLM-driven CLI agent that finds security vulnerabilities and "vibe-code" problems (AI-slop patterns: stub authentication, hallucinated imports, dummy crypto, prompt-injection sinks) in any repository, diff, or single file. The thing I want to talk about in this post isn't the scanner itself — it's the loop *around* the scanner. The whole scanning agent is a single Python file that gets **automatically rewritten by an outer optimization loop**, scored against a labeled benchmark with a held-out test set. This is the [Meta-Harness](https://yoonholee.com/meta-harness/) approach (Lee et al., 2026) applied to security triage.

```
$ uv run s0 scan ./my-app

  hallucinated import           src/email.py:8       critical   CWE-829
    `import emailclient` — no such package on PyPI; nearest match is
    `emailclient-aws` (likely typosquat). Suggest pinning `email-validator`.

  SQL injection (f-string)      src/api/users.py:42  critical   CWE-89
    `cur.execute(f"SELECT … {user_id}")`. Use `cur.execute("… ?", (user_id,))`.

  weak password hashing         src/auth/hash.py:7   high       CWE-327
    `hashlib.md5(...)` for password storage. Use `argon2-cffi` or `bcrypt`.

3 findings (1 critical hidden as triage filtered out 6 false positives)
```

## The hybrid: classic scanners + LLM triage

The architecture isn't novel — `s0 scan` runs five classic scanners (`semgrep`, `bandit`, `ruff`, `gitleaks`, `trivy`) plus two AI-slop detectors (`hallucinated_import` AST-based, `vibe` LLM-based) on the target in parallel, deduplicates by `(path, line, rule_id)`, and hands the merged list to a multi-turn LLM agent with a tightly scoped tool surface (read source, grep for taint, blame git history, re-run scanners with tighter rules). For each finding the agent either accepts it (assigning a severity and a `fix_hint`) or marks it as a false positive.

The scanners do detection; the LLM does triage. That split matters because of how the numbers come out, which I'll get to in a moment.

| | Traditional SAST | s0-cli |
| - | - | - |
| Detection | one scanner | 5 classic scanners + 2 AI-slop detectors, deduped |
| Triage | manual (engineer reads each alert) | LLM agent reads source, traces taint, marks FPs |
| Output | rule_id + line | severity + `why_real` + `fix_hint`, in markdown / JSON / SARIF |
| Audit trail | none | full prompt + every tool call recorded under `runs/` |
| Reproducibility | re-run and hope | replay any past scan from `runs/<id>/` |

Everything the agent does — every prompt, every tool call, every LLM response — is recorded under `runs/<timestamp>__<harness>__<id>/`. That recording is not just for debugging; it's also the input to the optimization loop.

## Benchmark: 11 labeled tasks, train/test split

Before getting to the loop, the harder problem: what does "good triage" even mean numerically?

The repo ships with 11 labeled tasks under `bench/`. Each task is a tiny self-contained target with a `ground_truth.json` listing the real vulnerabilities. The scorer matches predictions by `(path, line ± 5)`. The split is deliberate:

- **`bench/tasks_train/`** — 7 tasks, visible to the optimizer. SQL injection, XSS, hallucinated imports, command injection, weak crypto, unsafe yaml load, path traversal.
- **`bench/tasks_test/`** — 4 tasks, held out. Hardcoded secrets, vibe stub auth, pickle deserialization, JWT no-verify.

The proposer cannot see `tasks_test/` and the loop refuses to start if the train and test paths resolve to the same directory. That last sentence sounds defensive because it is: the temptation to peek at the test set is enormous in any optimization loop, and the easiest way to remove the temptation is to make peeking impossible.

Two configurations on `openai/gpt-4o-mini`:

| Configuration                   | Split | TP | FP | FN | Precision | Recall | F1   | Cost (in/out tokens)     |
| ------------------------------- | ----- | -- | -- | -- | --------- | ------ | ---- | ------------------------ |
| `--no-llm` (raw scanners only)  | train | 8  | 25 | 0  | 0.24      | **1.00** | 0.39 | 0 / 0                  |
| `--no-llm` (raw scanners only)  | test  | 5  | 10 | 0  | 0.33      | **1.00** | 0.50 | 0 / 0                  |
| `baseline_v0_agentic` (LLM)     | train | 8  | 23 | 0  | 0.26      | **1.00** | 0.41 | 97k / 6k               |
| `baseline_v0_agentic` (LLM)     | test  | 5  | **7**  | 0  | **0.42** | **1.00** | **0.59** | 60k / 2k          |

What this proves:

- **Recall = 1.00 in every configuration.** Across all 13 ground-truth vulnerabilities (train + test) — SQL injection, command injection, hallucinated imports, path traversal, weak crypto, hardcoded secrets, JWT no-verify, pickle deserialization, stub auth, … — the deterministic scanner pipeline alone catches every one. The LLM never has to *find* anything; its job is purely to triage what was already found.
- **LLM triage cuts false positives by 30% on the held-out set** (10 → 7) without dropping a single true positive. Held-out F1 climbs from 0.50 → **0.59** (+18% relative).
- **Every scan ends in a fixed turn budget** (median 5 turns, max 11 in this run) and a fixed token budget. No runaway costs.
- **The held-out test split was never seen by the LLM during any optimization run** — generalization is measured, not assumed.

The train F1 only moves from 0.39 → 0.41. The test F1 moves from 0.50 → 0.59. That asymmetry is the most interesting line in the table: the LLM's triage *generalizes*, and on the held-out tasks it removes 30% of false positives without losing recall. The `--no-llm` mode stays useful as a free anchor — you keep 100% recall at zero LLM cost, at the price of more false positives to skim through. Most CI pipelines will want the LLM mode on PR diffs (small target, low token cost, accurate triage) and the no-LLM mode on full-repo nightly scans.

A statistical-honesty note that I'll repeat throughout: 11 tasks is a small bench. The +0.09 test-F1 delta is one model on one bench on one run; it would be premature to claim the same delta will hold for `claude-sonnet-4-5` on a 200-task bench. What I can claim is that the *measurement infrastructure* exists, the test split is honest, and the loop is set up to keep producing those numbers as the bench grows.

## The Meta-Harness loop

So now the second-order question. The scanner achieves train F1=0.41 / test F1=0.59. How do you make those numbers go up *without* hand-tuning?

The standard answer is "iterate on the prompt." That's fine, but it has obvious limits:

- The thing that changes is a string in a config file, but a real triage decision involves prompts *and* tool selection *and* dedup heuristics *and* severity calibration *and* when to give up.
- "Better" is measured by vibes, not by F1.
- There's no guard against overfitting your dev repo.
- There's no audit trail of what you tried and why each variant was rejected.

The Meta-Harness paper ([Lee et al., 2026](https://arxiv.org/abs/2603.28052)) generalizes the loop. The unit of mutation isn't a string — it's the entire single-file agent (prompts + tools + scanner-selection + dedup logic, ~300–500 lines of Python). The unit of progress is a labeled bench scored by F1, precision, recall, tokens, turns. The guard against overfitting is a held-out test set the proposer literally cannot read. And the history is a directory full of every attempt, every score, every trace.

`s0 optimize` runs that loop:

1. A coding-agent **proposer** reads `runs/` (every prior agent, every score, every tool trace), forms a hypothesis about the worst current failure mode, and writes a new harness file under `src/s0_cli/harnesses/`.
2. The **runner** validates and re-scores it on `bench/tasks_train/`.
3. After all training iterations finish, the **best-train-F1 candidate is scored once on the disjoint `bench/tasks_test/`** to measure generalization.

The proposer's contract is in [`SKILL.md`](https://github.com/antonellof/s0-cli/blob/main/SKILL.md), which is read by the outer loop. It pins the interface (must subclass `Harness`, must implement `async def scan(self, target: Target) -> ScanResult`, must run within budgets) and forbids the obvious cheats — touching `bench/tasks_test/` is automatic disqualification, hardcoding bench task names is instant disqualification on held-out, and so on. The contract is short on purpose; the proposer needs room to be creative on what it changes.

| | Hand-tuning prompts/rules | Meta-Harness loop |
| - | - | - |
| **What changes** | a string in a config file | a whole single-file Python agent (prompts + tools + scanner-selection + dedup logic) |
| **What measures progress** | "feels better on my test repo" | a labeled bench scored by F1, precision, recall, tokens, turns |
| **What guards overfitting** | nothing | held-out `bench/tasks_test/` the proposer never sees |
| **History** | `git log` of edits, no scores attached | every attempt + score + full trace lives forever in `runs/<id>/` |
| **Cost vs. accuracy** | implicit; you pick one config | explicit Pareto frontier (F1 ↑ vs. tokens ↓) snapshotted to `runs/_frontier.json` |
| **Reproducibility** | rerun and hope | `s0 runs show <id>` replays the exact harness file, prompts, and tool calls |
| **Rollback** | manual revert | the prior harness file is still on disk; just point `S0_DEFAULT_HARNESS` at it |

## Why this matters more than "iterating on the prompt"

A handful of properties fall out of the loop that are not available in any "edit the prompt and rerun" workflow:

**Search beats intuition.** The proposer can try ideas a human wouldn't bother with — "lower confidence on bandit B608 inside `tests/` directories", "escalate to critical when `pickle.loads` is reachable from a Flask handler", "skip semgrep's `python.lang.security.audit.dangerous-subprocess-use` for `subprocess.run` calls whose first argument is a list literal" — and *measure* whether each one helps. Most will not. That's fine; the ones that do compound.

**Pareto, not point estimates.** Real choice in CI isn't "best F1", it's "best F1 at the token budget I can afford on a PR". After every iteration the Pareto frontier (F1 vs. tokens) is snapshotted to `runs/_frontier.json`. You get a menu: "harness A is the best F1 at any cost; harness B is the best F1 below 50k tokens; harness C is the best F1 below 10k tokens." You pick whichever fits the deadline.

**Generalization is enforced, not assumed.** The proposer can't see `tasks_test/`. The loop refuses to start if the train and test paths resolve to the same directory. So a +0.1 F1 on train that comes with a -0.05 test gap shows up in the summary table — you can't cheat your own benchmark, even by accident.

**Every iteration is auditable.** Each attempt is one new file plus a `runs/<id>/` directory containing `harness.py`, `score.json`, `summary.md`, and per-task traces with the full prompt and every tool call. Disk-as-database; no schema migrations, just `grep`. When the team six months from now asks "why does `baseline_v3_taint` skip semgrep on test files?", the answer is in `runs/2026-04-12_…/score.json` next to the diff that introduced it.

## The "outer loop reads the inner loop" recursion

The bit that makes me happiest about this design is also the bit that took me the longest to internalize. The proposer doesn't optimize against scores. It optimizes against **traces**.

When the proposer wakes up at the start of an iteration, the first thing it does is `s0 runs list --frontier` to find the current best harnesses. The second thing it does is `s0 runs tail-traces <run_id> <task_id>` for each failure mode it suspects. It reads the actual prompt and the actual LLM response and the actual tool call sequence that produced the false positive. *Then* it forms a hypothesis. The Meta-Harness paper's §A.1 reports a median of 82 file reads per iteration in the tbench2 setting; the SKILL.md instructs the proposer to read at least 3-5 prior trace files for each suspected failure mode, because "optimize from scores alone" is the ablation that loses 15 points on the original bench.

This matters because the failure mode of a triage agent is rarely "the F1 is low." It's usually "on this specific path-traversal task, the LLM read the wrong file first, ran out of turn budget on a tangent, and gave up before ever looking at `routes.py`." That diagnosis is in the trace. It is not in the score. A proposer that only sees scores will rewrite the prompt; a proposer that reads traces will increase the turn cap, or change the scanner ordering, or add a `git_blame` step before `read_file`.

## Multi-candidate proposals

There's one more knob worth highlighting because it changes the cost model. Pass `-k N` (or `--candidates N`) to fan out **N parallel proposals per iteration**, each with a different temperature, seed harness, and focus directive. The runner evaluates them concurrently and keeps the highest-F1 winner; losers are still recorded under `runs/` so you can see what each design slot tried.

```bash
# 2 parallel proposals per iteration; pick the better one each time
uv run s0 optimize -n 5 -k 2 --run-name exp_multicand --fresh
```

Cost scales linearly with `k`, but wall-clock cost stays roughly constant (the proposers run concurrently). The strategy ladder lives in [`src/s0_cli/optimizer/strategies.py`](https://github.com/antonellof/s0-cli/blob/main/src/s0_cli/optimizer/strategies.py) and is deterministic — `k=2` always means slot 0 (greedy, exploit) plus slot 1 (warmer, "shrink token cost"), so reruns hit the same regions of design space.

This is the part of the loop that feels most like classical optimization: you're not just gradient-descending one harness, you're doing beam search over a population of harnesses with different temperatures and different objectives, and the disk-resident `runs/` directory is the population history.

## Honest limits

I don't want to oversell the size of what's been measured here. A few caveats worth keeping in mind if you're considering using this in production or running the loop yourself:

- **11 tasks is small.** The +0.09 test-F1 delta from `--no-llm` to `baseline_v0_agentic` is one model on one bench. The bench needs to grow before any of these absolute numbers should be quoted as evidence about real CI cost vs accuracy tradeoffs. Adding tasks is documented in [`bench/README.md`](https://github.com/antonellof/s0-cli/blob/main/bench/README.md) and is the most useful contribution someone could make right now.
- **Recall = 1.00 is partly a property of the bench.** Every ground-truth label in the train and test set is something one of the five classic scanners catches, by construction. A bench item like "side-channel timing leak in a custom JWT verifier" would not be caught by any current scanner, and the LLM-only `vibe` detector would have to find it from scratch. Adding tasks that *only* the vibe detector catches is the next thing that needs to happen to stress the LLM-as-detector path rather than the LLM-as-triage path.
- **`gpt-4o-mini` is the cheap baseline.** The numbers above are for the model that maximizes "interesting per dollar." `claude-sonnet-4-5` is the default in `.env.example` and likely produces sharper triage; I haven't run the full optimize loop on it because each iteration is non-trivially expensive and I want the bench to grow first.
- **The optimize loop is a research artifact, not a CI tool.** `s0 scan` is the production path; `s0 optimize` is what produces *better* `s0 scan` configurations. Running optimize on every PR would be cost-prohibitive and beside the point.

## Try it

```bash
git clone https://github.com/antonellof/s0-cli.git
cd s0-cli
uv sync                    # Python 3.12+, uv >= 0.5

cp .env.example .env       # then fill in one provider key

# Smoke test: scan this very repo
uv run s0 scan . --no-llm --format markdown

# Score the default harness on the training bench
uv run s0 eval

# Score on the held-out test set
uv run s0 eval --split test

# Run the optimize loop (5 iterations, then a held-out pass)
uv run s0 optimize -n 5 --run-name exp1 --fresh
```

Three drop-in CI integrations ship with the repo (a [GitHub Action](https://github.com/antonellof/s0-cli/blob/main/action.yml), a [multi-arch Docker image](https://github.com/antonellof/s0-cli/blob/main/Dockerfile) with every scanner pre-installed, and a [pre-commit hook pair](https://github.com/antonellof/s0-cli/blob/main/.pre-commit-hooks.yaml)). Output formats include `markdown` (default), `json`, and `sarif` for GitHub code-scanning / GitLab SAST.

I'm particularly interested in feedback from anyone running an LLM-augmented SAST in CI today. The hypothesis I'm trying to falsify — that *the agent itself should be the optimization variable, not the prompt* — needs validation from people who've actually paid the LLM bills on real PR traffic. The 11-task bench is a starting point, not an answer.

**Links:**
- [GitHub repository](https://github.com/antonellof/s0-cli)
- [README](https://github.com/antonellof/s0-cli/blob/main/README.md) — top-level overview, quickstart, CI integrations
- [`SKILL.md`](https://github.com/antonellof/s0-cli/blob/main/SKILL.md) — proposer contract read by the outer loop
- [`bench/README.md`](https://github.com/antonellof/s0-cli/blob/main/bench/README.md) — task layout and how to add new ones
- Lee et al. **Meta-Harness: End-to-End Optimization of Model Harnesses.** arXiv:2603.28052 (2026). [paper](https://arxiv.org/abs/2603.28052) · [code](https://github.com/stanford-iris-lab/meta-harness)
- KRAFTON AI & Ludo Robotics. **Terminus-KIRA.** [github.com/krafton-ai/KIRA](https://github.com/krafton-ai/KIRA)

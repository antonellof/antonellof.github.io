---
layout: post
title: "Managing Technical Debt: Strategies and Practices"
date: 2023-11-06
categories: [Case Study]
tags: [Technical Debt, Best Practices, Maintenance]
excerpt: "Our deploy frequency dropped from daily to weekly. Not because we got careful — because everyone was afraid to touch the payment module. That's what technical debt looks like when you stop measuring it."
---

The sprint planning meeting had twelve story points allocated for features and zero for maintenance. Same as the last sprint. Same as the sprint before that. The product manager was happy — full velocity, all customer-facing work. The engineering lead was lying.

We weren't maintaining velocity. We were accumulating debt. Deploy frequency had dropped from daily to weekly because everyone was afraid to touch the payment module. The test suite took 42 minutes and failed intermittently on unrelated changes. Onboarding a new engineer took three weeks instead of three days. We called it "stabilization" when we skipped features to fix fires. We never called it what it was: technical debt compounding with interest.

The quarter we finally measured debt and started paying it down systematically, deploy frequency recovered, onboarding dropped to five days, and feature velocity *increased* — because engineers stopped spending 60% of their time navigating around problems instead of building features.

Technical debt isn't a moral failing. It's a tradeoff — consciously or unconsciously made. The failure isn't having debt; it's not tracking it, not prioritizing it, and not paying it down before the interest overwhelms the principal.

## What Technical Debt Actually Looks Like

Ward Cunningham coined the term to describe the expedient choice now that creates rework later — like financial debt, you borrow speed today and pay interest tomorrow. The interest is the extra effort every future change requires because of the shortcut.

### The Five Types I Track

**Code debt** — the obvious one. Duplicated logic, 400-line functions, missing abstractions, `// TODO: fix this later` comments from 2019.

**Architecture debt** — design decisions that made sense at one scale but don't at current scale. The synchronous processing that blocks at 1,000 users. The shared database table that should have been partitioned at 10 million rows.

**Test debt** — missing tests, flaky tests, tests that test implementation instead of behavior. The suite that everyone runs with `--skip-integration` because "they're always broken anyway."

**Dependency debt** — libraries three major versions behind, security vulnerabilities in `npm audit` that everyone ignores, frameworks approaching end-of-life.

**Documentation debt** — onboarding docs that reference services that no longer exist, architecture diagrams from two reorganizations ago, runbooks that say "ask Dave" (Dave left in March).

### How We Assess It

Gut feeling isn't enough. We score debt with observable metrics:

```bash
# Code complexity (example: Python with radon)
pip install radon
radon cc -a -s src/          # cyclomatic complexity
radon mi src/                 # maintainability index

# Dependency age
npm outdated                  # or pip list --outdated

# Test health
npm test 2>&1 | tail -5      # pass rate, duration
```

**Metrics we track quarterly:**

| Metric | Healthy | Our "oh no" threshold |
|--------|---------|----------------------|
| Test suite duration | < 10 min | > 30 min |
| Test flakiness rate | < 1% | > 5% |
| Deploy frequency | Daily+ | < 2x/week |
| Mean time to onboard | < 1 week | > 2 weeks |
| Dependencies > 1yr old | < 10% | > 30% |
| `%` time on unplanned work | < 20% | > 40% |

When three or more thresholds are red, we schedule a debt sprint. Not because of guilt — because the metrics prove debt is slowing delivery.

## Prioritization: Not All Debt Is Equal

Every team has more debt than time to fix it. Prioritization is the skill.

### Impact vs. Effort Matrix

```
High Impact, Low Effort  →  Do first (quick wins)
High Impact, High Effort →  Plan and schedule
Low Impact, Low Effort   →  Fill gaps between features
Low Impact, High Effort  →  Don't bother (seriously)
```

**High impact debt** — things that slow every engineer, every day:

- The payment module everyone avoids (touches every feature)
- The flaky test suite (erodes confidence in every deploy)
- The missing CI pipeline (manual deploys, human error)
- The authentication layer with known security gaps

**Low impact debt** — things that annoy but don't block:

- Inconsistent naming conventions in a stable, rarely-touched module
- A deprecated API endpoint with three callers that could migrate in an afternoon
- Documentation for an internal tool only two people use

The mistake I see: teams fix low-impact debt because it's easy and feel productive, while high-impact debt grows. Fixing variable names in a dead module while the payment system terrifies everyone is backwards prioritization.

### The "Tax" Test

Ask: "Does this debt tax every change we make?" If yes, prioritize it. Module coupling that requires touching five files for every bug fix is a tax. A poorly named variable in an isolated utility is not.

## Paying Down Debt: Strategies That Work

### The 20% Allocation

The most sustainable approach: dedicate a fixed percentage of every sprint to debt:

```javascript
// Sprint capacity allocation
const sprintCapacity = 100; // story points or hours
const featureWork = 80;       // 80% features
const debtWork = 20;          // 20% debt repayment
```

Twenty percent sounds like a lot to product managers. Frame it as insurance: without it, velocity drops 40% over six months as debt compounds. We tracked this — teams that maintained 20% debt allocation sustained velocity. Teams that dropped to 0% saw velocity decline within two quarters.

**Making it real:**

- Debt items go in the same backlog as features, with story points
- Debt work is sprint-committed, not "if we have time"
- Debt items have acceptance criteria, same as features
- Progress is visible in sprint reviews

### Debt Sprints

Every fourth sprint, we run a focused debt sprint:

- No new features (product manager agrees in advance, quarterly)
- Team identifies top 3-5 debt items by impact
- Clear objectives: "reduce test suite to under 15 minutes," "upgrade Node 16 → 20," "refactor payment module to reduce coupling"
- Measurable outcomes defined before the sprint starts

Our first debt sprint results:

- Test suite: 42 min → 11 min (removed duplicate integration tests, fixed flaky ones)
- Payment module: extracted into three focused services within the monolith
- Dependencies: upgraded 23 outdated packages, zero security vulnerabilities remaining
- Onboarding doc: rewritten, new engineer productive in 4 days

One week of focused work. Months of accumulated benefit.

### The Boy Scout Rule

"Leave the code better than you found it." Small improvements on every PR:

- Rename one confusing variable
- Add one missing test
- Delete one unused import
- Extract one function that's grown too long

This doesn't replace dedicated debt work, but it prevents debt from growing in areas under active development. We enforce this in code review — "you touched this function, can you add a test for the path you changed?"

### Debt Tickets With Business Context

Debt items die in backlogs when they're written as "refactor UserService." They get prioritized when written as:

> **Debt:** Payment module refactor
> **Impact:** 3 of last 5 sprints had payment-related blockers (avg 2 days delay each)
> **Cost:** ~6 engineer-days per quarter lost to payment module friction
> **Proposal:** Extract payment validation into isolated module (3 days)
> **ROI:** Pays for itself in one quarter

Product managers understand business impact. Engineers understand technical impact. Translate between them.

## Preventing Debt: The Unsexy Part

Paying down debt is necessary. Not accumulating it is better.

**Code review standards.** We don't merge PRs without tests for new logic, without updating docs for API changes, or with known shortcuts unless there's a debt ticket filed for the shortcut.

**Definition of Done includes debt check.** "Does this PR introduce coupling? Add a dependency? Skip a test? If yes, file a debt ticket before merging."

**Architecture decision records (ADRs).** When we consciously take on debt ("ship without caching, add caching when we hit 10K users"), we document the decision, the trigger for fixing it, and the estimated cost. Conscious debt is manageable. Unconscious debt is a time bomb.

**Dependency update cadence.** Monthly `npm outdated` review. Security patches applied within 48 hours. Major version upgrades scheduled in debt sprints, not ignored until they break.

## Communicating Debt to Non-Engineers

The hardest part isn't technical — it's organizational. Product managers, executives, and stakeholders see debt work as "not building features." 

**What works:**

- **Metrics, not complaints.** "Deploy frequency dropped 60%" not "the code is messy"
- **Cost framing.** "This refactor costs 3 days and saves ~2 days per sprint going forward"
- **Risk framing.** "Three security vulnerabilities in production dependencies, patch available"
- **Customer impact.** "The bug that affected 200 users last week was caused by missing test coverage in the payment module we've been avoiding"

**What doesn't work:**

- "We need to rewrite everything" (you don't, and nobody will approve it)
- "Technical debt" without translation (means nothing to non-engineers)
- Guilt or blame (debt is a system problem, not an individual failure)
- All-or-nothing ("stop features for a month to fix debt" — you'll lose the argument)

## What We Got Wrong

**Debt sprints without metrics.** Early debt sprints were "clean up whatever feels bad." Engineers fixed satisfying things (linting, formatting) instead of impactful things (payment module, test suite). Now we define measurable outcomes before the sprint.

**No debt backlog visibility.** Debt items lived in a separate Jira project nobody checked. Moved them to the main backlog with a `debt` label. Product manager sees them in every planning meeting.

**Hero culture.** One senior engineer spent weekends "fixing things." Unsustainable, unscalable, invisible to leadership. Debt repayment became a team responsibility with sprint allocation.

**Ignoring dependency debt.** We focused on code debt because it was visible. Dependency debt was invisible until a CVE forced an emergency weekend upgrade of a library three major versions behind. Now dependencies are on the quarterly review.

## Practical Takeaways

Technical debt is inevitable. Shipping software means making tradeoffs. The goal isn't zero debt — it's managed debt with visible cost and a repayment plan.

**Start here:**

1. Measure: deploy frequency, test duration, onboarding time, unplanned work percentage
2. Track debt in the same backlog as features, with business impact descriptions
3. Allocate 20% of sprint capacity to debt repayment
4. Run a debt sprint every 4th sprint with measurable outcomes
5. Apply the Boy Scout rule on every PR in active code

**The signal to act:**

When engineers start routing around parts of the codebase instead of through them, debt has crossed from "manageable" to "delivery bottleneck." That's when the 20% allocation isn't enough and you need a dedicated debt sprint.

Our deploy frequency recovered. Onboarding shortened. Feature velocity increased. Not because we stopped shipping features — because we stopped paying the invisible tax on every change. Technical debt is a loan. Pay the interest regularly, or the bank forecloses on your velocity.

---

*Managing technical debt — November 2023. See Ward Cunningham's [original metaphor](http://wiki.c2.com/?WardExplainsDebtMetaphor) and Martin Fowler's [Technical Debt Quadrant](https://martinfowler.com/bliki/TechnicalDebtQuadrant.html) for deeper context.*

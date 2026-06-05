---
layout: post
title: "Building Engineering Organizations from Zero"
date: 2020-12-26
categories: [Case Study]
tags: [Engineering, Organization, Leadership]
excerpt: "Zero to fifty engineers in three years. The hiring mistakes, culture bets, and process decisions that actually mattered—and the ones that sounded good in blog posts but failed in practice."
---

I joined a startup as engineer #3. When I left three years later, we were at fifty. I wasn't the CTO—I was an engineer who cared about how teams work, which meant I watched every organizational experiment closely: what accelerated us, what slowed us down, and what sounded great in all-hands but changed nothing.

Building an engineering org from zero isn't about copying Spotify's squad model or Google's OKRs. It's about **sequential problems**: first you need people who can ship, then you need people who can ship without breaking things, then you need people who can help others ship.

Each phase needs different hiring, different process, different tooling. What works at five engineers actively hurts at thirty. Here's the playbook I wish we'd had—honest about what worked and what we'd skip next time.

## Phase 1: Foundation (0-5 Engineers)

You're proving the product can exist. Process is minimal. Everyone touches everything.

### Hiring: Generalists Who Own

At 3 engineers, you don't need a Kubernetes expert. You need someone who can build the feature, fix the bug, deploy on Friday, and answer customer support on Monday.

**What we optimized for:**
- **Ownership** — do they take problems to completion without hand-holding?
- **Learning speed** — can they become productive in a new stack in weeks?
- **Communication** — can they explain trade-offs to non-engineers?
- **Culture contribution** — would you want them on-call at 2 AM?

**What we deprioritized:**
- Deep specialization (no "frontend only" hires)
- Pedigree (great engineers come from everywhere)
- Years of experience (judgment matters more than tenure)

**Interview process (kept simple):**
1. Technical screen — real problem, not leetcode (1 hour)
2. System design or architecture discussion (1 hour)
3. Culture/values conversation (30 min)
4. Team lunch or informal chat (30 min)

Decision within 48 hours. Slow hiring loses candidates to companies that move fast.

### Culture: Defaults That Stick

Culture isn't ping pong tables. It's what happens when nobody's watching:

- **Code review everything** — even founder's PRs
- **Post-mortems without blame** — "what broke the system?" not "who broke it?"
- **Document decisions** — TDRs for anything you'll forget in 6 months
- **Ship weekly** — momentum is a culture

These habits compound. Teams that review code at 5 engineers still review at 50. Teams that skip it at 5 never start.

## Phase 2: Growth (5-20 Engineers)

The product works. Now you need to ship faster without shipping bugs faster.

### Structure: Feature Teams Emerge

```
Product Engineering
├── Team A (User-facing features)
├── Team B (Core platform)
└── Platform/Infra (shared services, CI/CD, observability)
```

We resisted formal teams until ~8 engineers. Before that, everyone knew everything. After, ownership blurred and PRs sat unreviewed because "someone else knows that area better."

**Roles that appeared:**
- **Tech Lead** — technical direction for a team, still codes
- **Engineering Manager** — people, process, hiring (first EM around engineer #12)
- **Staff Engineer** — cross-team architecture (around engineer #18)

Don't hire managers too early. Don't wait too long either. Around 10-12 engineers, someone needs to focus on people full-time or engineering quality suffers.

### Process: Enough to Prevent Chaos

**Development:**
- Feature branches + PRs (required)
- CI on every PR (tests + lint, no exceptions)
- Deploy to staging automatically; production with approval

**Planning:**
- Weekly sprint planning (1 hour max)
- Async daily updates in Slack (not standup meetings—remote-friendly)
- Retrospectives every 2 weeks (actually act on action items)

**What we tried and killed:**
- Estimation poker (too slow for our pace)
- Mandatory standups (replaced with async updates)
- Jira for everything (GitHub Issues was enough until ~15 engineers)

### Tooling That Earned Its Keep

- **GitHub** — code, issues, projects, CI
- **Slack** — with norms (threads required, channels per team)
- **Datadog** — monitoring from day one of production
- **Sentry** — error tracking (free tier → paid when needed)
- **Notion** — docs, onboarding, runbooks

**Tooling rule:** adopt when pain is real, not anticipated. We didn't buy Kubernetes until we had deployment pain, not before.

## Phase 3: Scale (20-50 Engineers)

Coordination cost exceeds individual contribution cost. Architecture decisions have blast radius.

### Organization Structure

```
Engineering
├── Product Engineering (feature teams by domain)
├── Platform Engineering (infra, data, developer experience)
├── Security (reviews, compliance, tooling)
└── QA/Testing (embedded in teams + platform test infra)
```

**Management layer:**
- Engineering Managers (1 per 6-8 engineers)
- Tech Leads (1 per team, senior ICs)
- Staff/Principal Engineers (architecture, standards, mentorship)

**Critical hire:** Developer Experience engineer around engineer #25. CI/CD, local dev setup, internal tools. Best ROI hire we made.

### Process: Reviews, Not Bureaucracy

**Added at scale:**
- Design reviews for significant features (30-min doc, async comments)
- Architecture review for cross-team changes
- Security review for auth, payments, PII
- RFC process for major technical decisions

**Kept lightweight:**
- No approval committees for normal feature work
- No mandatory design docs for small changes
- No sprint velocity tracking (focused on outcomes, not points)

### Career Development

We defined levels with clear expectations:

| Level | Scope | Impact |
|-------|-------|--------|
| Junior | Task-level, with guidance | Team |
| Mid | Feature-level, independent | Team |
| Senior | System-level, mentors others | Team + adjacent teams |
| Staff | Cross-team architecture | Organization |
| Principal | Company-wide technical strategy | Company |

Promotion = sustained performance at next level, not tenure. Written rubrics. Calibration across managers. Transparent to engineers.

## What Actually Mattered

### Hiring

1. **Hire for slope, not intercept** — learning ability beats current skills
2. **Move fast** — 48-hour decision cycle
3. **Diverse pipelines** — different backgrounds, different perspectives
4. **Trial projects** — paid work trials for senior hires (best signal we found)
5. **Say no to brilliant jerks** — culture damage compounds

### Onboarding

Bad onboarding wastes your most expensive hires' first month:

1. **Week 1: environment works** — `docker-compose up`, tests pass, first PR merged
2. **Assigned mentor** — not manager, a peer they can ask "dumb" questions
3. **Meaningful first task** — real bug or feature, not "read the docs"
4. **30/60/90 check-ins** — structured feedback

Every new hire updated the onboarding doc. It improved continuously.

### Culture Preservation at Scale

What we protected:
- **Blameless post-mortems** — even when the outage was embarrassing
- **Engineering blog** — share learnings externally and internally
- **Tech talks** — monthly, any engineer, any topic
- **No hero culture** — sustainable pace beats crunch sprints

What we lost (and accepted):
- Everyone knowing everything
- Instant consensus in Slack
- Single shared codebase context

You can't preserve a 5-person culture at 50. You preserve values, not practices.

## Challenges We Hit

### Scaling Too Fast

**Symptom:** Hired 10 engineers in 2 months. Half were unproductive for months. Code quality dropped.

**Fix:** Hiring pause. Structured onboarding. Mentor program. "No merge without review from someone who's been here 3+ months" temporarily.

**Lesson:** Hiring speed should match onboarding capacity.

### Technical Debt Avalanche

**Symptom:** Features shipped fast early. At 30 engineers, everything was slow because of accumulated shortcuts.

**Fix:** 20% time for tech debt (real, not theoretical). Tech debt register in GitHub Issues. Architecture reviews caught new debt before it landed.

**Lesson:** Debt is a loan. Start paying interest before it's crushing.

### Communication Silos

**Symptom:** Teams didn't know what other teams were building. Duplicate work. Integration surprises.

**Fix:** Weekly engineering all-hands (30 min). Shared roadmap in Notion. Cross-team liaison on large projects.

## Metrics We Tracked (Not Worshipped)

**Delivery:**
- Deployment frequency (target: multiple per week per team)
- Lead time for changes (commit to production)
- Change failure rate (% of deploys causing incidents)

**Quality:**
- Incident count and MTTR
- Test coverage on critical paths (not vanity 100%)
- Code review turnaround time

**People:**
- Onboarding time-to-first-PR
- Retention (especially first-year)
- Engagement survey scores

DORA metrics are useful directional indicators. They're not goals. Optimizing deployment frequency alone just means you ship bugs faster.

## Conclusion

Building an engineering organization from zero is a sequence of different problems. Phase 1: find generalists who ship. Phase 2: add structure before chaos wins. Phase 3: invest in platform, career growth, and coordination.

There's no perfect org chart. Spotify's model might not fit your company. Google's processes will crush a 10-person startup. Copy principles, not org charts: ownership, code review, blameless learning, hire for slope, document decisions, and adapt process to team size.

We went from 3 to 50. The engineers who joined at 5 and stayed to 50 were the culture carriers. The processes changed three times. The values—ship quality software, own outcomes, help each other—didn't.

Start with people who care. Add process when pain appears. Remove process when it stops helping. That's the whole playbook.

---

*Building engineering organizations from December 2020, covering hiring, culture, processes, and scaling.*

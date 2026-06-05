---
layout: post
title: "Leading Architectural Reviews: A Practical Guide"
date: 2022-12-03
categories: [Case Study]
tags: [Architecture, Reviews, Leadership]
excerpt: "The worst architecture review I ever attended lasted three hours, ended with no decisions, and left the presenting team demoralized. The best one took 45 minutes and saved us from a $200K/month mistake."
---

I've been on both sides of architecture reviews—the presenter sweating through "why didn't you consider X?" questions, and the reviewer trying to give useful feedback without derailing the project. I've seen reviews that improved systems and reviews that destroyed team morale without improving anything.

The difference wasn't the architecture. It was the process.

The three-hour disaster? No agenda, stakeholders ambushed with questions, scope creep into implementation details, no documented outcomes. The team left without knowing what to change or whether their design was approved.

The 45-minute success? Clear agenda sent 48 hours ahead, focused questions on decisions not syntax, explicit outcomes documented with action items. We caught a database sharding approach that would have cost $200K/month in cross-region transfer fees. The presenting team felt heard, not attacked.

Leading architectural reviews is a skill. Here's the process that's worked for me.

## What Architecture Reviews Are (And Aren't)

Architecture reviews evaluate **significant design decisions** before significant implementation investment. They're decision checkpoints, not code reviews, not status meetings, not design-by-committee.

**Review these:**
- New system designs
- Major changes to existing architecture
- Technology selection decisions
- Cross-team integration approaches
- Security-sensitive designs
- Scaling strategy changes

**Don't review these:**
- Implementation details (save for code review)
- Routine feature development
- Decisions already made and shipped
- Hypothetical future problems

The goal: catch problems early when they're cheap to fix, align stakeholders, and document rationale.

## Before the Review: Preparation Is Everything

Bad reviews happen when presenters arrive unprepared and reviewers arrive uninformed.

### For the Presenting Team

Send materials **48 hours before** the review. Not the morning of. Reviewers need time to read, think, and form questions.

Required materials:

```markdown
# Architecture Review Request: Order Processing Redesign

## Metadata
- **Date:** 2022-12-10, 2:00 PM
- **Presenters:** @jane-smith, @bob-jones
- **Reviewers:** @architect-lead, @platform-lead, @security-lead
- **Decision needed by:** 2022-12-17 (sprint planning)

## Summary (2-3 sentences)
Redesigning order processing from synchronous monolith to event-driven 
microservices to support 10x traffic growth and reduce p99 latency 
from 2s to 200ms.

## Problem Statement
- Current: Monolithic order service, 2s p99 latency at peak
- Growth: 10x traffic projected in 18 months
- Constraints: Zero downtime migration, existing API contracts

## Proposed Architecture
[Link to C4 container diagram]
[Link to sequence diagram for order flow]

## Key Decisions
1. Event sourcing for order state (ADR-012)
2. Kafka for event bus (vs. SQS—see comparison)
3. CQRS for read/write separation

## Alternatives Considered
| Option | Pros | Cons | Why Not |
|--------|------|------|---------|
| Scale monolith | Simple | Ceiling at ~5x | Doesn't meet 10x |
| Database sharding | Keeps current code | Complex queries | Doesn't fix latency |
| Microservices + events | Scalable, decoupled | Complexity | Selected |

## Risks and Mitigations
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Event schema evolution | Medium | High | Schema registry, compatibility checks |
| Dual-write during migration | High | Medium | Strangler fig pattern, see migration plan |
| Team Kafka expertise | Medium | Medium | Training budget, consultant for Q1 |

## Questions for Reviewers
1. Is event sourcing overkill for our consistency requirements?
2. Kafka vs. SQS—are we over-engineering with Kafka?
3. Does the migration timeline (6 months) seem realistic?

## Out of Scope
- Payment processing (separate review scheduled)
- Frontend changes (standard React patterns)
```

This template gives reviewers everything they need. Specific questions focus the discussion. "Out of scope" prevents scope creep.

### For Reviewers

Read the materials before the meeting. I mean actually read them—not skim during the first five minutes of the review.

Come with:
- Questions about decisions, not implementation
- Concerns backed by reasoning
- Alternative suggestions (not just "I don't like it")
- Understanding of what decision is being requested

Reviewers who arrive cold force the presenting team to re-present everything, wasting time and frustrating everyone.

## During the Review: Facilitation Matters

Someone must facilitate. Not the presenting team—they're answering questions. A neutral facilitator keeps the review on track.

### The Agenda (And Sticking to It)

```markdown
# Architecture Review Agenda: Order Processing Redesign
Duration: 60 minutes (hard stop)

## 1. Context (5 min)
- Presenter: Problem statement, constraints
- No questions yet—just context

## 2. Architecture Overview (15 min)
- Presenter: Walk through diagram, key decisions
- Clarifying questions only

## 3. Discussion (30 min)
- Reviewers: Concerns, alternatives, risks
- Presenter: Responses, tradeoff explanations
- Facilitator: Keep focused on decisions

## 4. Decision & Actions (10 min)
- Facilitator: Summarize outcomes
- Document: Approved / Approved with conditions / Needs revision
- Assign action items with owners
```

Hard stop at 60 minutes. If you need more discussion, schedule a follow-up. Marathon reviews lose focus and exhaust everyone.

### Questions That Help

Good review questions probe decisions and tradeoffs:

- "What happens when [failure scenario]?"
- "Why this approach over [alternative]?"
- "How does this scale to [future requirement]?"
- "What's the migration path from current state?"
- "What are we explicitly not solving?"
- "What would make you reconsider this decision?"

### Questions That Don't Help

Avoid questions that derail without adding value:

- "Why didn't you use [reviewer's favorite technology]?" (unless there's a concrete reason)
- "Have you considered [obvious thing clearly addressed in materials]?"
- "Let me tell you about how we did this in 2008..."
- Implementation details: "What ORM will you use?"
- Scope expansion: "While you're at it, could you also..."

The facilitator's job is redirecting unhelpful questions: "That's an implementation detail we can address in code review. Let's focus on the architectural decision."

### Creating Psychological Safety

Reviews fail when presenters feel attacked. They're showing work for feedback, not defending a thesis.

Facilitator techniques:
- "What works well about this design before we discuss concerns?"
- "What's the strongest part of this approach?"
- Redirect blameless: "What risk should we mitigate?" not "Why didn't you think of this?"
- Private feedback for sensitive interpersonal issues

I've seen teams stop bringing designs for review after a brutal session. One bad review creates months of shadow architecture decisions made without oversight.

## The Review Checklist

Reviewers evaluate against consistent criteria—not personal preferences:

### Functional Fit
- [ ] Design solves the stated problem
- [ ] Requirements are addressed (functional and non-functional)
- [ ] Scope is appropriate (not over/under-engineered)
- [ ] Out-of-scope items are explicitly identified

### Quality Attributes
- [ ] **Scalability:** Can this handle projected growth?
- [ ] **Reliability:** Failure modes identified? Recovery paths?
- [ ] **Security:** Auth, data protection, attack surfaces addressed?
- [ ] **Performance:** Latency/throughput requirements achievable?
- [ ] **Maintainability:** Can the team operate this long-term?

### Operational Readiness
- [ ] Monitoring and alerting considered
- [ ] Deployment strategy defined
- [ ] Rollback approach documented
- [ ] Runbook requirements identified

### Team and Organization
- [ ] Team has skills to build and operate this
- [ ] Dependencies on other teams identified
- [ ] Timeline realistic given constraints
- [ ] Cost estimate reasonable

Not every item applies to every review. A prototype has different standards than a production system. Adjust expectations to context.

## After the Review: Document Outcomes

Reviews without documented outcomes might as well not have happened. People remember differently. Action items get forgotten.

### The Review Record

```markdown
# Architecture Review Record: Order Processing Redesign

## Review Details
- **Date:** 2022-12-10
- **Attendees:** @jane-smith, @bob-jones, @architect-lead, @platform-lead, @security-lead
- **Facilitator:** @architect-lead

## Decision
**Approved with conditions**

The proposed event-driven architecture is approved pending addressal 
of conditions below.

## Conditions (Must address before implementation)
1. **Security:** Add threat model for event bus (Owner: @security-lead, Due: 2022-12-17)
2. **Cost:** Provide Kafka cluster cost estimate (Owner: @bob-jones, Due: 2022-12-14)
3. **Migration:** Detail rollback procedure for Phase 1 (Owner: @jane-smith, Due: 2022-12-17)

## Action Items
| Item | Owner | Due | Status |
|------|-------|-----|--------|
| Create ADR-012 for event sourcing decision | @jane-smith | 2022-12-12 | Done |
| Schedule Kafka training for team | @platform-lead | 2022-12-20 | Pending |
| Set up shadow mode infrastructure | @bob-jones | 2023-01-15 | Pending |

## Key Discussion Points
- Event sourcing complexity acknowledged; team committed to training
- Kafka chosen over SQS due to replay requirements (see ADR-013)
- Strangler fig migration approved; 6-month timeline accepted with monthly checkpoints

## Follow-up Review
Scheduled for 2023-01-15 to review Phase 1 migration progress.

## Dissenting Opinions
@platform-lead prefers SQS for operational simplicity. Documented in ADR-013 
as rejected alternative. Revisit if replay requirements change.
```

File this with the architecture documentation. Link from ADRs. Reference in future reviews.

### Decision Outcomes

Every review ends with one of:

**Approved.** Proceed as proposed. Rare for significant designs—most have conditions.

**Approved with conditions.** Proceed after addressing specific items. Conditions have owners and due dates. Implementation starts, but conditions must be met before production.

**Needs revision.** Significant concerns require design changes. Schedule follow-up review. Don't start implementation of affected components.

**Rejected.** Fundamental problems with the approach. Significant rework needed. Document why to prevent repeated proposals.

Avoid ambiguous outcomes like "looks good" or "let's discuss offline." Explicit decisions only.

## Building a Review Culture

One good review doesn't create a culture. Systematic practice does.

### Review Tiers

Not every decision needs the same review rigor:

**Tier 1: Full Review (60 min)**
- New systems
- Major architectural changes
- Cross-team impacts
- Security-sensitive designs

**Tier 2: Lightweight Review (30 min)**
- Significant feature designs within existing architecture
- Technology choices within approved stack
- Integration approaches

**Tier 3: Async Review (no meeting)**
- Minor changes to approved designs
- ADR review via PR comments
- Routine patterns already established

Match review rigor to decision impact. Tier 1 everything and teams stop bringing designs. Tier 3 everything and problems slip through.

### Regular Cadence

Schedule review slots weekly or biweekly. Predictable slots mean teams plan for reviews instead of requesting emergency sessions.

Our schedule:
- Tuesdays 2pm: Tier 1 reviews (60 min)
- Thursdays 10am: Tier 2 reviews (30 min)
- Continuous: Tier 3 async via ADR PRs

### Reviewer Rotation

Same reviewers every time creates blind spots. Rotate in:
- Domain experts for specific areas
- Junior engineers (learning opportunity)
- Adjacent team leads (cross-pollination)
- Security/ops representatives (when relevant)

Fresh eyes catch things regular reviewers miss.

### Metrics That Matter

Track review effectiveness:

- **Time to decision:** Days from request to outcome
- **Rework rate:** Designs sent back for revision
- **Issue catch rate:** Problems found in review vs. production
- **Team satisfaction:** Post-review surveys

We caught the $200K/month sharding mistake in review. One data point, but leadership noticed. Review culture got easier to maintain after that.

## Common Failures (And Fixes)

**Review as approval gate.** Teams treat review as bureaucracy to check off, not feedback to incorporate. Fix: Make reviews genuinely useful. Catch real problems. Teams will want them.

**Design by committee.** Review becomes group design session with no owner. Fix: Reviewers advise; presenting team decides. Review approves or rejects, doesn't redesign.

**No follow-through.** Action items assigned, never tracked. Fix: Review record with owners and due dates. Follow up in next review slot.

**Reviewing too late.** Design is already implemented when review happens. Fix: Review before significant implementation investment. Prototypes are fine; production code without review is not.

**Reviewing too early.** Idea is half-formed, review becomes brainstorming. Fix: Require minimum materials. "We should use microservices" isn't a design ready for review.

## Conclusion

Architecture reviews are decision-making tools, not judgment ceremonies. The three-hour disaster and the 45-minute success had the same participants, similar designs, different processes.

Prepare materials 48 hours ahead. Facilitate with a clear agenda. Ask questions about decisions, not implementation. Document outcomes with explicit approval and action items. Follow up.

The $200K/month mistake we caught? The presenting team wasn't embarrassed—they were grateful. Good reviews make teams better, not bitter.

Lead reviews that teams want to attend. That's the whole job.

**Further Resources:**
- [Architecture Decision Records](https://adr.github.io/) — Documenting decisions
- [ThoughtWorks Technology Radar](https://www.thoughtworks.com/radar) — Technology assessment framework
- [Fundamentals of Software Architecture](https://www.oreilly.com/library/view/fundamentals-of-software/9781492043441/) — Mark Richards & Neal Ford
- [Team Topologies](https://teamtopologies.com/) — Team structure and communication
- [C4 Model](https://c4model.com/) — Architecture diagram standard

---

*Leading architectural reviews from December 2022, covering review process and best practices.*

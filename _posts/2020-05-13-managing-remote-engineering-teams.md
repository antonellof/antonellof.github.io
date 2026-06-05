---
layout: post
title: "Managing Remote Engineering Teams: Technical Practices"
date: 2020-05-13
categories: [Case Study]
tags: [Remote Work, Team Management, Best Practices]
excerpt: "March 2020 sent everyone home. The teams that thrived weren't the ones with the best Zoom backgrounds—they had async workflows, ruthless documentation, and code review cultures that worked across time zones."
---

In March 2020, our office closed with 48 hours' notice. One day we were debating monitor stands; the next, everyone was home trying to figure out if their VPN worked. Some teams collapsed into endless Zoom calls. Others shipped faster than before.

The difference wasn't talent or tools. It was **technical practices adapted for distributed work**: async-first communication, documentation that replaced hallway conversations, code review processes that didn't require everyone online simultaneously, and tooling that made collaboration feel seamless across nine time zones.

I'd managed remote engineers before COVID—this was different because *everyone* was remote, including leadership. The practices that worked became non-negotiable. Here's what actually mattered.

## Async-First: The Default That Changes Everything

Synchronous communication is expensive when your team spans US, Europe, and Asia. A "quick question" in Slack at 9 AM San Francisco is 6 PM in Berlin—maybe fine. It's midnight in Bangalore—not fine.

**Our principle:** default to async. Sync only when async failed or the topic required real-time negotiation.

| Channel | Use for | Don't use for |
|---------|---------|---------------|
| Slack | Quick questions, social, urgent blockers | Long technical debates |
| GitHub Issues/PRs | Technical decisions, code discussion | "What should we have for lunch" |
| Loom | Architecture explanations, demos | Replacing written docs |
| Notion/Confluence | Decisions, runbooks, onboarding | Real-time chat |
| Email | External comms, formal announcements | Day-to-day engineering |

The test: *can someone in Tokyo contribute meaningfully to this conversation without staying up until 2 AM?* If no, move it async.

### Documenting Decisions (Because Hallways Don't Exist)

Every significant technical decision got written down:

```markdown
# Technical Decision Record (TDR)

## Context
Why this decision is needed. What constraints exist.

## Decision
What we decided. Be specific.

## Consequences
Positive and negative impacts. What we're trading off.

## Alternatives Considered
What else we evaluated and why we rejected it.
```

This replaced the "oh, we discussed that in a meeting you weren't in" problem. New engineers could read decision history. Disagreements had context. Six months later, we remembered *why* we chose PostgreSQL over DynamoDB for that service.

## Code Review: The Async Collaboration Engine

Code review became our primary collaboration surface. Not Zoom. Not standups. Pull requests.

### Review Standards That Worked Remotely

**Author responsibilities:**
- PR description explains *what* and *why*, not just *how*
- Link to ticket/design doc when relevant
- Self-review before requesting others
- Keep PRs small (<400 lines when possible)

**Reviewer responsibilities:**
- First review within 24 hours (team agreement)
- Ask questions, don't just request changes
- Approve when "good enough to ship and improve later"
- Use `[nit]` prefix for non-blocking suggestions

```markdown
## PR Template

### Description
What does this change and why?

### Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactoring

### Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed

### Checklist
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No secrets committed
```

Small PRs got reviewed in hours. 2,000-line PRs sat for days and accumulated merge conflicts. We learned to enforce size limits culturally when we couldn't enforce them technically.

### Async Review in Practice

A developer in London opens a PR at 5 PM GMT. San Francisco reviewers see it at 9 AM PST. Comments arrive throughout the US day. London developer addresses feedback the next morning. No one worked outside their hours. The PR merged in 36 hours—faster than most in-office teams I'd seen.

The secret: **clear PR descriptions and small diffs.** Reviewers shouldn't need a Zoom call to understand what they're reviewing.

## Development Workflow: Git and CI as Source of Truth

### Feature Branch Workflow

```bash
git checkout -b feature/user-authentication
# ... work ...
git commit -m "Add user authentication"
git push origin feature/user-authentication
# Open PR, get reviews, merge
```

Nothing exotic. Consistency mattered more than novelty. Everyone used the same flow, same branch naming, same merge strategy (squash and merge for clean history).

### CI/CD as Quality Gate

```yaml
name: CI

on:
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Run tests
      run: npm test
    - name: Run lint
      run: npm run lint
```

PRs didn't merge with red CI. No exceptions, no "I'll fix it after merge." Remote teams can't tap someone on the shoulder about a broken build—you need automated gates.

## Tooling: The Remote Engineer's Toolkit

**Development:**
- **VS Code + Live Share** — pair programming without screen-share lag
- **Docker** — identical dev environments (no more "works on my machine")
- **Terraform/Pulumi** — infrastructure changes reviewed like code

**Communication:**
- **Slack** — with norms (threads mandatory, @channel sparingly)
- **Zoom** — scheduled, with agendas, recorded when useful
- **Loom** — 3-minute architecture videos beat 30-minute meetings

**Project management:**
- **GitHub Projects** — tied to repos, visible to everyone
- **Notion** — onboarding docs, runbooks, team wiki

### Consistent Dev Environments

```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]
```

`docker-compose up` and you have the same environment as everyone else. Onboarding dropped from 3 days to 4 hours. Support questions about "my local setup" virtually disappeared.

## Documentation: Replace Tribal Knowledge

Remote work kills tribal knowledge. If it's not written down, it doesn't exist.

### Code Documentation

```javascript
/**
 * Authenticates a user with email and password.
 * 
 * @param {string} email - User email address
 * @param {string} password - User password
 * @returns {Promise<User>} Authenticated user object
 * @throws {AuthenticationError} If credentials are invalid
 * 
 * @example
 * const user = await authenticateUser('user@example.com', 'password123');
 */
async function authenticateUser(email, password) {
    // Implementation
}
```

Not every function needs JSDoc. Public APIs, complex business logic, and non-obvious behavior do.

### Architecture Documentation

```markdown
# System Architecture

## Overview
API gateway routing to microservices behind Kubernetes.

## Components
- API Gateway (Kong)
- User Service (Node.js)
- Order Service (Node.js)
- PostgreSQL (primary data)
- Redis (caching, sessions)

## Data Flow
User → API Gateway → Service → Database

## Deployment
Kubernetes on AWS EKS, multi-AZ
```

Updated when architecture changed. Stale docs worse than no docs—we dated every page and reviewed quarterly.

## Testing: Confidence Without Colocation

You can't tap a colleague to "just quickly check" your change. Tests are your safety net.

```javascript
describe('UserService', () => {
    it('should authenticate valid user', async () => {
        const user = await userService.authenticate('user@example.com', 'password');
        expect(user).toBeDefined();
    });
});
```

**Our targets (pragmatic, not dogmatic):**
- Unit tests: 80%+ coverage on business logic
- Integration tests: critical API paths
- E2E tests: top 5 user journeys
- Performance tests: before major releases

## Onboarding: First Week Makes or Breaks Remote Hires

Remote onboarding is harder. There's no "shadow someone for a day." You need structure:

**Week 1:**
- [ ] Tool access (GitHub, Slack, AWS, VPN)
- [ ] Dev environment running (`docker-compose up` works)
- [ ] Read architecture docs and team wiki
- [ ] 1:1 intro calls with each team member (30 min each)

**Week 2:**
- [ ] First small bug fix or doc improvement (merged PR)
- [ ] Pair programming session via Live Share
- [ ] Attend code reviews as observer

**Month 1:**
- [ ] First feature shipped end-to-end
- [ ] Led at least one code review
- [ ] Feedback session with manager

```markdown
# Engineering Onboarding Guide

## Day 1 Setup
1. Clone repo, run `docker-compose up`
2. Run test suite (`npm test` — should be green)
3. Join Slack channels (#engineering, #team-yourteam)

## First PR (Day 2-3)
Fix a "good first issue" from GitHub. Goal: learn the PR workflow.

## Resources
- Architecture overview (link)
- Style guide (link)
- On-call runbook (link)
```

Every new hire improved the onboarding doc with questions they had. It got better continuously.

## Challenges We Hit (And Fixes)

### Time Zones

**Problem:** US-East and India had 10.5 hours overlap—zero if US folks didn't start early.

**Fix:** 
- Core overlap hours: 8-10 AM EST / 6:30-8:30 PM IST (2 hours daily)
- Rotate meeting times monthly (fairness)
- Record all meetings; written summaries mandatory

### Communication Overload

**Problem:** Slack became a never-ending stream. People felt they had to be always-on.

**Fix:**
- Status norms: 🟢 available, 🟡 async only, 🔴 deep work
- No expectation of instant response
- "Done for the day" posts in team channel (psychological closure)

### Collaboration on Complex Work

**Problem:** Architecture discussions in Slack threads went in circles.

**Fix:**
- RFC documents in Notion for anything >2 hours of debate
- 48-hour comment period, then decision
- Loom walkthroughs for visual explanations

## What Actually Mattered

1. **Async by default** — sync is the exception
2. **Write it down** — decisions, architecture, runbooks, onboarding
3. **Small PRs, fast reviews** — the collaboration engine
4. **CI gates** — no "trust me, it works"
5. **Consistent environments** — Docker eliminated an entire category of problems
6. **Intentional overlap hours** — not "always available," but reliable windows
7. **Onboarding as a product** — iterate on it like you iterate on code

## Conclusion

Remote engineering isn't "in-office practices over Zoom." It's a different operating system. Async communication. Written decisions. Code review as primary collaboration. Tooling that makes distance irrelevant.

The teams that struggled after March 2020 tried to replicate the office remotely—endless meetings, implicit knowledge, "quick syncs" that weren't quick across time zones. The teams that thrived built systems where work progressed while people slept.

You don't need perfect tools. You need consistent practices: document decisions, keep PRs small, run CI on everything, and respect that your colleague in another timezone is also a human who wants to log off.

We shipped more after going remote. Not because remote is magic—because we were forced to fix the practices that had been held together by physical proximity. Keep those fixes even when people return to offices. They're just good engineering.

---

*Managing remote engineering teams from May 2020, covering technical practices for distributed teams.*

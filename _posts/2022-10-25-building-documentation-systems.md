---
layout: post
title: "Building Documentation Systems: From Zero to Hero"
date: 2022-10-25
categories: [How-To]
tags: [Documentation, Best Practices, Tools]
excerpt: "Our best engineer quit and took six months of tribal knowledge with him. The documentation existed—in his head, in Slack threads, and in a Confluence page last updated in 2019. Never again."
---

The onboarding request was reasonable: "Can we get the new hire access to the payment service documentation?"

I searched Confluence. Found a page titled "Payment Service Architecture" last edited by the engineer who'd left in March. It described a PostgreSQL schema we'd migrated away from eighteen months ago. The API endpoints referenced didn't exist. The "current owner" field pointed to someone in a different department now.

I checked the repo. README had install instructions—mostly accurate. A `/docs` folder had three markdown files, one empty, one describing a feature that shipped and was removed, one actually useful.

Slack history? Golden. Completely unsearchable for anyone who wasn't in `#payments-team` in 2021.

The new hire spent their first two weeks reverse-engineering production instead of shipping code. That's when I got mandate to fix documentation—not write a doc, build a **system** that keeps documentation alive.

## Documentation Isn't a Document. It's a System.

The failure mode I see everywhere: someone writes a comprehensive doc, everyone celebrates, six months later the doc is wrong and nobody knows.

Documentation systems have four components:

1. **Content** — What you document (APIs, architecture, runbooks, guides)
2. **Structure** — How it's organized (taxonomy, navigation, search)
3. **Process** — How it stays current (reviews, ownership, CI integration)
4. **Culture** — Who writes it and when (docs-as-code, definition of done)

Fix one without the others and you get Confluence graveyards—lots of content, zero trust.

## What to Document (And What to Skip)

Not everything deserves documentation. I prioritize by "how much pain if this is wrong":

### Tier 1: Must Document (High Pain if Missing)

**Runbooks.** What to do when things break at 3am:

```markdown
# Runbook: Payment Service 503 Errors

## Symptoms
- Checkout failing with 503
- `payment_service_error_rate` alert firing
- User reports in #support-urgent

## Quick Checks (< 5 minutes)
1. Check service health: `kubectl get pods -l app=payment-service`
2. Check recent deploys: `kubectl rollout history deployment/payment-service`
3. Check payment provider status: https://status.stripe.com

## Common Causes

### Cause 1: Payment Provider Outage
**Diagnosis:** External status page shows incident
**Action:** Enable fallback mode (see below)
**ETA:** Wait for provider recovery

### Cause 2: Database Connection Pool Exhaustion
**Diagnosis:** Logs show "connection pool timeout"
**Action:**
```bash
kubectl rollout restart deployment/payment-service
# If persists, scale up:
kubectl scale deployment/payment-service --replicas=5
```

## Escalation
- L1: On-call engineer (this runbook)
- L2: Payment team lead (@payments-lead)
- L3: Platform team for infrastructure issues
```

Runbooks save incident duration. A good runbook turns a 45-minute outage into a 10-minute one.

**Architecture Decision Records (ADRs).** Why you made choices, not just what you built:

```markdown
# ADR-012: Use Event Sourcing for Order State

## Status
Accepted (2022-08-15)

## Context
Order state changes frequently (pending → confirmed → shipped → delivered).
Multiple services need order history. Audit requirements mandate state change tracking.

## Decision
Implement event sourcing for order state. Store events, derive current state.

## Consequences
**Positive:**
- Complete audit trail
- Easy to add new state consumers
- Time-travel debugging

**Negative:**
- Team needs event sourcing training
- Event schema evolution requires care
- Read models add complexity

## Alternatives Considered
- CRUD with audit log table (rejected: dual writes, consistency issues)
- CDC from PostgreSQL (rejected: doesn't capture business intent)
```

ADRs prevent the "why did we do this?" archaeology expeditions.

### Tier 2: Should Document (Medium Pain)

**API documentation.** Contracts between services and clients:

```yaml
# openapi.yaml
openapi: 3.0.0
info:
  title: Payment Service API
  version: 2.1.0
  
paths:
  /api/v2/payments:
    post:
      summary: Create payment
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount, currency, orderId]
              properties:
                amount:
                  type: integer
                  description: Amount in cents
                  example: 9999
                currency:
                  type: string
                  example: USD
                orderId:
                  type: string
                  format: uuid
      responses:
        '201':
          description: Payment created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Payment'
        '400':
          description: Invalid request
        '402':
          description: Payment declined
```

Generate docs from OpenAPI. Don't hand-write API docs that drift from implementation.

**Architecture diagrams.** C4 model context and container diagrams (see my [C4 Model post](/2022/01/28/c4-model-software-architecture.html)). Link to ADRs for decisions.

**Developer guides.** How to set up, test, deploy:

```markdown
# Payment Service Developer Guide

## Prerequisites
- Node.js 18+
- Docker Desktop
- Access to `#payments-team` Slack

## Local Setup
```bash
git clone git@github.com:org/payment-service.git
cd payment-service
cp .env.example .env
docker-compose up -d postgres redis
npm install
npm run db:migrate
npm run dev
```

## Running Tests
```bash
npm test              # Unit tests
npm run test:integration  # Requires docker-compose
npm run test:e2e      # Full stack, slower
```

## Deployment
Merging to `main` triggers staging deploy. Production requires manual approval in GitHub Actions.
See [Deployment Runbook](./runbooks/deployment.md) for rollback procedures.
```

### Tier 3: Nice to Have (Low Pain if Missing)

- Detailed code comments (prefer self-documenting code)
- Meeting notes (unless they contain decisions → ADR)
- Comprehensive wikis (often become graveyards)

## Tools That Work

I've used most documentation tools. Here's what stuck:

### Docs-as-Code: Markdown in Git

Documentation lives in the repo, reviewed in PRs, versioned with code:

```
payment-service/
├── docs/
│   ├── architecture/
│   │   ├── context-diagram.md
│   │   └── container-diagram.md
│   ├── adr/
│   │   ├── 001-use-postgresql.md
│   │   └── 012-event-sourcing.md
│   ├── runbooks/
│   │   ├── 503-errors.md
│   │   └── deployment.md
│   └── guides/
│       └── developer-setup.md
├── openapi.yaml
└── README.md
```

**Why it works:** Docs change with code in the same PR. Reviewers catch outdated docs. Git history shows when docs changed and why.

### Static Site Generators

For cross-repo documentation portals:

**[Docusaurus](https://docusaurus.io/)** — React-based, great for technical docs, versioning built-in:

```bash
npx create-docusaurus@latest docs-site classic
cd docs-site
npm start
```

**[MkDocs](https://www.mkdocs.org/)** with Material theme — Python-friendly, simple, beautiful:

```yaml
# mkdocs.yml
site_name: Engineering Docs
theme:
  name: material
  features:
    - navigation.tabs
    - search.suggest

nav:
  - Home: index.md
  - Architecture: architecture/
  - Runbooks: runbooks/
  - ADRs: adr/
```

**[GitBook](https://www.gitbook.com/)** — Polished output, good for external-facing docs.

### API Documentation

**[Swagger/OpenAPI](https://swagger.io/)** — Industry standard. Generate docs, client SDKs, and mock servers from spec.

**[Redoc](https://github.com/Redocly/redoc)** — Beautiful OpenAPI rendering.

**[Postman Collections](https://www.postman.com/)** — Interactive API exploration, shareable with teams.

Our rule: if it's a public or cross-team API, it has an OpenAPI spec. No spec, no merge.

### Architecture Documentation

**[Structurizr](https://structurizr.com/)** — C4 diagrams as code.

**[Mermaid](https://mermaid.js.org/)** — Diagrams in Markdown, renders in GitHub/GitLab.

**[Draw.io](https://draw.io/)** — Quick diagrams, exports to PNG/SVG for embedding.

### Runbook and Incident Tools

**[PagerDuty](https://www.pagerduty.com/)** / **[Opsgenie](https://www.atlassian.com/software/opsgenie)** — Link runbooks to alerts.

**[Incident.io](https://incident.io/)** — Post-incident review templates that feed back into runbooks.

## The Process: Keeping Docs Alive

Tools don't solve the hard problem: **documentation that rots.**

### Documentation Ownership

Every doc has an owner. Not "the team." A person.

```markdown
---
title: Payment Service Architecture
owner: @jane-smith
last_reviewed: 2022-10-01
review_cycle: quarterly
---
```

Automated reminders when `last_reviewed + review_cycle` passes. Owner gets a Slack ping: "Payment Service Architecture hasn't been reviewed in 90 days."

### Docs in Definition of Done

PRs that change behavior must change docs:

```markdown
## PR Checklist
- [ ] Tests added/updated
- [ ] API spec updated (if endpoints changed)
- [ ] Runbook updated (if operational behavior changed)
- [ ] ADR added (if architectural decision made)
- [ ] README updated (if setup changed)
```

Enforce in CI where possible:

```yaml
# .github/workflows/docs-check.yml
- name: Check API spec matches implementation
  run: |
    npm run openapi:validate
    npm run openapi:diff -- --fail-on-changed
```

### Documentation Reviews

Quarterly doc review sprints—half a day where teams audit their docs:

1. Read every doc you own
2. Flag outdated content
3. Update or archive
4. Update `last_reviewed` date

We treat doc debt like tech debt. It gets sprint capacity.

### Search That Works

Docs nobody can find might as well not exist.

- Full-text search in your doc portal (Docusaurus, MkDocs, GitBook all have this)
- Slack integration for common questions (`/docs payment 503`)
- README in every repo pointing to relevant docs

## Anti-Patterns I've Learned to Avoid

**The comprehensive wiki nobody maintains.** 500 pages, 400 outdated, 50 useful, 50 empty. Users learn to ignore it.

**Docs written after the fact.** "We should document this" six months post-launch means reconstructing from memory. Write docs as you build—in the same PR.

**Docs without examples.** API docs that list endpoints without curl examples are reference manuals, not guides. Show me how to use it.

**Multiple sources of truth.** API docs in Confluence AND OpenAPI AND README. Pick one canonical source, link from others.

**Documentation by committee.** Everyone can edit, nobody owns it, quality varies wildly. Clear ownership beats open wiki.

**Blaming users for not reading docs.** If people aren't reading docs, the docs aren't useful. Fix the docs.

## Measuring Documentation Health

Metrics I track:

```yaml
# Documentation health dashboard
metrics:
  - name: doc_freshness
    description: "% of docs reviewed within review_cycle"
    target: 90%
    
  - name: api_spec_coverage
    description: "% of services with OpenAPI specs"
    target: 100%
    
  - name: runbook_coverage
    description: "% of on-call alerts with linked runbooks"
    target: 100%
    
  - name: onboarding_time
    description: "Days until new hire's first PR"
    target: < 5 days
    
  - name: doc_search_success
    description: "% of doc searches that click a result"
    target: 70%
```

Onboarding time is the ultimate metric. Good docs compress it. Bad docs extend it.

## Building From Zero: A 90-Day Plan

When we started from nothing:

**Month 1: Foundation**
- Create docs repo/site structure
- Write runbooks for top 5 alert types
- Add README to every service repo
- Establish ADR template and process

**Month 2: Coverage**
- OpenAPI specs for all public APIs
- C4 context diagrams for major systems
- Developer setup guides for each service
- Assign doc owners

**Month 3: Process**
- PR checklist enforcement
- Quarterly review calendar
- Doc search setup
- Measure onboarding time baseline

After 90 days, we had imperfect but *trusted* documentation. Perfection came later. Trust came from keeping things current.

## Conclusion

Documentation systems fail when treated as a one-time writing project instead of an ongoing process. The engineer who left in March didn't fail us by leaving— we failed by letting knowledge live only in his head.

Build the system: docs in git, owners assigned, reviews scheduled, CI enforcing freshness. Start with runbooks and ADRs—the highest pain if missing. Add API specs and architecture diagrams. Measure onboarding time.

The new hire who spent two weeks reverse-engineering? With the system we built, the next new hire shipped code on day three. That's the ROI of documentation done right.

**Further Resources:**
- [Docs-as-Code](https://www.writethedocs.org/guide/docs-as-code/) — Write the Docs guide
- [Architecture Decision Records](https://adr.github.io/) — ADR templates and tools
- [Docusaurus](https://docusaurus.io/) — Documentation site generator
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) — API documentation standard
- [C4 Model](https://c4model.com/) — Architecture diagram approach
- [Google Developer Documentation Style Guide](https://developers.google.com/style) — Writing standards

---

*Building documentation systems from October 2022, covering tools and best practices.*

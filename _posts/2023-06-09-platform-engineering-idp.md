---
layout: post
title: "Platform Engineering: Building Internal Developer Platforms"
date: 2023-06-09
categories: [Architecture]
tags: [Platform Engineering, IDP, DevOps]
excerpt: "Developers were opening Jira tickets to get a staging environment. Three-day wait. I helped build an internal platform that turned 'request infrastructure' into a button click."
---

"How do I deploy to staging?" was the most-asked question in our engineering Slack channel. Not because the answer was secret — it was documented in a Confluence page last updated eighteen months ago. The docs described a process involving three Jira tickets, a manual Terraform apply by the ops team, and a prayer that nobody had modified the shared staging environment since your last deploy.

New hires took two weeks before they could ship their first PR to staging. Senior engineers had kubectl aliases tattooed on their forearms and a mental map of which secrets lived in which vault path. The gap between "joined the company" and "productive engineer" was entirely infrastructure friction.

We didn't set out to build a "platform." We set out to stop being the bottleneck. What emerged was an Internal Developer Platform (IDP) — self-service infrastructure, golden paths, and a developer portal that turned three-day waits into three-minute workflows. This post is what worked, what flopped, and what I'd do differently.

## Platform Engineering vs. DevOps vs. SRE

Before building anything, we needed shared vocabulary. These terms overlap and teams use them inconsistently:

- **DevOps** — culture and practices bridging dev and ops. A philosophy, not a team.
- **SRE** — reliability engineering with error budgets and SLOs. Focused on keeping production healthy.
- **Platform Engineering** — building internal products that let developers self-serve infrastructure and tooling.

Platform engineering isn't "DevOps rebranded." It's treating your internal tooling as a product with users (developers), features (self-service workflows), and success metrics (time to first deploy, ticket volume, developer satisfaction).

The [CNCF Platform Engineering whitepaper](https://tag-app-delivery.cncf.io/whitepapers/platform-eng/) frames it well: platforms provide curated capabilities on shared infrastructure, reducing cognitive load for product teams.

## What Our Platform Actually Included

### Developer Portal: The Front Door

The portal was a web UI and CLI that wrapped our infrastructure APIs:

```javascript
// Self-service portal — simplified core logic
class DeveloperPortal {
    async createEnvironment(name, type) {
        // Provision infrastructure
        const env = await this.provisionEnvironment(name, type);

        // Configure CI/CD
        await this.setupCICD(env);

        // Grant access
        await this.grantAccess(env, this.currentUser);

        return env;
    }

    async provisionEnvironment(name, type) {
        const template = this.getTemplate(type); // 'nodejs-api', 'worker', 'frontend'
        return await this.infraProvisioner.create({
            name,
            template,
            owner: this.currentUser.team,
            ttl: type === 'preview' ? '7d' : null,
        });
    }

    async setupCICD(env) {
        // Create GitHub Actions workflow or attach to existing pipeline
        await this.cicdService.connectRepo(env.repo, env.cluster);
    }

    async grantAccess(env, user) {
        await this.iamService.addRole(user, `env:${env.name}:developer`);
    }
}
```

**What developers experienced:**

1. Click "Create Environment" in the portal
2. Pick a template (Node.js API, background worker, static frontend)
3. Name it, select a branch
4. Wait 4 minutes
5. Get a URL, kubectl access, and a CI pipeline that deploys on push

**What happened behind the scenes:**

- Terraform module instantiated (VPC subnet, K8s namespace, RDS instance or shared DB schema)
- Secrets generated and stored in Vault
- GitHub Actions workflow created from template
- DNS record pointed at the load balancer
- Slack notification sent to the team channel

The first version took eight weeks to build and supported one template. It eliminated 80% of infrastructure tickets within a month.

### Golden Paths: Opinionated Defaults

The biggest mistake in our first platform attempt was infinite flexibility. We built a "generic infrastructure provisioner" that let developers configure everything — instance sizes, network topology, database engines, monitoring agents. Nobody used it because configuring infrastructure *was the problem we were solving*.

Golden paths fixed this:

```yaml
# Standard application template — developers fill in name and repo, nothing else
apiVersion: platform/v1
kind: Application
metadata:
  name: my-app
spec:
  runtime: nodejs-18
  database: postgresql
  cache: redis
  monitoring: enabled
  scaling:
    min: 2
    max: 10
  ingress: internal  # or 'public' for customer-facing
```

**Golden path principles we followed:**

- **80% of apps fit the template** — if yours doesn't, talk to the platform team (that's the 20%)
- **Sensible defaults, not configurable everything** — PostgreSQL 15, not "pick your database engine"
- **Escape hatches exist** — advanced teams can override, but the default path is the happy path
- **Templates evolve centrally** — security patches, runtime upgrades happen once, propagate everywhere

The team that fought the golden path hardest eventually became its biggest advocate — after they realized their custom Terraform was three months behind on security patches.

### Service Catalog: Know What Exists

A portal that creates things but doesn't show what exists is half a platform. We added a service catalog:

- Every environment, its owner, its cost, its last deploy
- Dependency graph (this API depends on this database depends on this cache)
- Health status aggregated from monitoring
- Links to logs, metrics, runbooks

This sounds obvious. Most platforms skip it and wonder why developers create duplicate staging environments they forgot about.

## What We Got Wrong (Learn From Our Mistakes)

### Mistake 1: Building Before Listening

Our v0 platform was built by three senior infra engineers based on what *they* wished existed. Developers ignored it because it solved problems they didn't have while ignoring problems they did.

**Fix:** Two weeks of developer interviews before writing code. We asked: "Walk me through your last deploy. Where did you get stuck?" The answers were humbling and shaped every feature priority.

### Mistake 2: No Feedback Loop

We launched the portal and declared victory. Usage was low because onboarding was a 45-minute wiki page. Nobody knew the portal existed, or they tried once, hit a confusing error, and went back to Slack-asking.

**Fix:** Embedded a platform engineer in each product team for two sprints. Not to do their infra — to watch them try the platform and fix friction in real time. Also: in-portal feedback button that created tickets automatically.

### Mistake 3: Treating It as a Project, Not a Product

The platform had a launch date and a "done" state in the project plan. Platforms aren't projects — they're products that need ongoing investment, roadmap, and ownership.

**Fix:** Dedicated platform team (three engineers) with a product manager. Quarterly developer satisfaction surveys. Monthly usage metrics reviewed in engineering all-hands.

### Mistake 4: Abstracting Too Early

We tried to build a "cloud-agnostic platform abstraction" before we had a working AWS-specific platform. Twelve months of architecture diagrams, zero self-service environments.

**Fix:** Build for your current cloud. Abstract when you have two clouds, not before.

## Measuring Whether the Platform Works

Vanity metrics: number of services provisioned, portal page views.

**Metrics that actually mattered:**

| Metric | Before Platform | 6 Months After |
|--------|----------------|----------------|
| Time to first staging deploy (new hire) | 12 days | 1.5 days |
| Infrastructure Jira tickets / month | 47 | 8 |
| Mean time to create preview environment | 3 days | 6 minutes |
| Developer satisfaction (quarterly survey) | 3.1 / 5 | 4.2 / 5 |
| Platform team on-call pages | N/A | 2 / month |

The Jira ticket reduction paid for the platform team's salaries. Everything else was upside.

## Team Structure: Who Builds This?

We tried "everyone contributes to the platform" (nobody did) and "one hero engineer maintains scripts" (hero burned out). What worked:

- **Platform team (3 engineers):** builds and maintains the platform
- **Platform PM (0.5 FTE):** prioritizes based on developer feedback
- **Embedded rotations:** product engineers spend one sprint per year on the platform team
- **Clear escalation:** platform team owns the golden paths; product teams own application code

The platform team doesn't gatekeep — they enable. When a product team needs something outside the golden path, the platform team helps, then decides whether to add it to the platform or keep it as a one-off.

## Technology Choices (What We Used)

I'm not going to prescribe a stack — ours was Kubernetes + Terraform + GitHub Actions + a React portal + Backstage-inspired service catalog. But the principles transfer:

- **Infrastructure as Code** — everything the portal creates is Terraform/Pulumi, stored in Git
- **GitOps** — environment state matches Git state, always
- **Identity integration** — SSO for the portal, RBAC tied to your existing IAM
- **Observability baked in** — monitoring and logging enabled by default in every template, not opt-in

[Backstage](https://backstage.io/) (Spotify's open-source developer portal) is worth evaluating if you don't want to build a portal from scratch. We built custom because our workflows were specific, but Backstage's plugin ecosystem has matured significantly.

## When NOT to Build a Platform

Platform engineering has hype-cycle energy right now. You don't need an IDP when:

- You have fewer than 15 engineers (Slack + good docs is fine)
- You deploy once a month (the friction cost is low)
- Your infra is genuinely simple (one app, one database, Vercel/Heroku handles the rest)
- You don't have dedicated people to maintain it (an unmaintained portal is worse than no portal)

The right time is when infrastructure friction measurably slows down product engineering and the cost of that friction exceeds the cost of building internal tooling.

For us, that threshold was ~40 engineers and ~47 infrastructure tickets per month.

## Practical Takeaways

Platform engineering is about treating internal developer experience as a product. The goal isn't fancier infrastructure — it's getting developers from "I have an idea" to "it's running in staging" without filing tickets, reading outdated wikis, or learning kubectl before they learn the codebase.

**Start here:**

1. Measure current friction — time to first deploy, ticket volume, developer survey
2. Interview developers about where they get stuck (not what they want built)
3. Build one golden path for your most common app type
4. Ship a portal that does one thing well: create that environment
5. Add catalog, monitoring, and more templates iteratively

**Avoid:**

- Building for flexibility before building for the common case
- Launching without embedded support during adoption
- Treating the platform as a one-time project
- Cloud-agnostic abstractions before you have a working single-cloud platform

The developer who used to wait three days for staging now clicks a button and gets coffee. That's the whole point. Everything else is implementation detail.

---

*Platform engineering and IDP — June 2023. The space evolves quickly; see the [CNCF TAG App Delivery](https://tag-app-delivery.cncf.io/) for current guidance.*

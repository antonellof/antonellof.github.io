---
layout: post
title: "OpenTofu in Production: Migration from Terraform"
date: 2023-03-28
categories: [Case Study]
tags: [OpenTofu, Terraform, IaC, Migration]
excerpt: "HashiCorp changed the Terraform license and our legal team said no. We migrated 200+ modules to OpenTofu in six weeks — here's the playbook that didn't break production."
---

The email from legal landed on a Tuesday: "We need to review all HashiCorp license dependencies by Friday." Terraform was on the list. HashiCorp had switched from MPL to the Business Source License, and our company's open-source policy had opinions about that.

I wasn't emotionally attached to Terraform the product — I'd been using it since 0.11 and it had served us well. But ripping out infrastructure-as-code tooling mid-sprint felt like changing the engine on a flying plane. Two hundred modules. Three AWS accounts. State files dating back to 2019. A CI pipeline that ran `terraform plan` on every pull request.

[OpenTofu](https://opentofu.org/) had forked from Terraform 1.5.x under the Linux Foundation with an MPL license. The pitch was simple: drop-in replacement, community-governed, no license surprises. The reality, as always, was in the details.

We completed the migration in six weeks. Zero production incidents attributed to the switch. Here's what actually happened.

## Why We Chose OpenTofu (Not Just "License Bad")

License was the trigger, not the only reason. After evaluating options:

- **Stay on Terraform 1.5.x forever** — frozen in time, no security patches, eventual provider incompatibility
- **Migrate to Pulumi/CDK** — rewrite everything, months of work, different mental model
- **OpenTofu** — same HCL, same state format, same providers, `tofu` instead of `terraform`

The migration cost for OpenTofu was measured in weeks. Pulumi would have been measured in quarters. Engineering leadership did the math.

OpenTofu also promised community-driven development without a vendor's commercial interests shaping the roadmap. Whether that matters long-term is debatable. In March 2023, it mattered to us.

## Phase 1: Assessment (Don't Skip This)

Before touching anything, we needed to know what we had:

```bash
# Audit Terraform usage
find . -name "*.tf" -o -name "*.tfvars" | wc -l

# Check providers
grep -r "required_providers" .
```

Our audit found:

- 247 `.tf` files across 34 modules
- 12 provider plugins (AWS, Kubernetes, Cloudflare, Datadog, etc.)
- 3 remote state backends (S3 + DynamoDB locking)
- 8 CI/CD pipelines referencing `terraform` binary
- 2 wrapper scripts that hardcoded the `terraform` command name

The provider list was the risk surface. OpenTofu compatibility with providers is excellent for the major ones, but edge-case providers need verification. We made a spreadsheet: provider name, version, criticality, test status.

**Lesson:** The migration isn't about HCL files. It's about the ecosystem around them — CI, scripts, documentation, team habits, and provider versions.

## Phase 2: Dev Environment Testing

We started with the lowest-risk environment: a sandbox AWS account that mirrored production architecture but handled no real traffic.

```bash
# Test OpenTofu in dev
tofu init
tofu plan
tofu apply

# Verify compatibility
tofu validate
```

First `tofu plan` on our largest module: identical output to `terraform plan`. I exhaled.

Second module: plan showed 2 unexpected changes. Root cause: we'd been pinning an older AWS provider on Terraform 1.5, and OpenTofu's init pulled a slightly newer compatible version with different default attribute handling. We pinned the provider version explicitly — problem solved.

**Testing checklist we used:**

- `tofu plan` produces zero unexpected changes
- `tofu apply` succeeds on create, update, and destroy operations
- Remote state locking works (DynamoDB)
- Sensitive outputs still mask correctly
- Module sources (git refs, local paths) resolve
- Workspaces behave identically

We ran this against every module over two weeks. Modules that passed got a ✅ in the spreadsheet. Modules that failed got a ticket.

## Phase 3: State Migration (Easier Than Expected)

This was the part that kept me up at night. State files are the source of truth for all infrastructure. Corrupt them and you're rebuilding from console screenshots and prayer.

```bash
# OpenTofu uses same state format
# No migration needed, just rename
mv terraform.tfstate tofu.tfstate
mv terraform.tfstate.backup tofu.tfstate.backup
```

For remote state on S3, we didn't rename anything. OpenTofu reads the same state files Terraform wrote. The backend configuration is identical:

```hcl
terraform {
  backend "s3" {
    bucket         = "our-terraform-state"
    key            = "production/vpc/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}
```

OpenTofu respects this block as-is. The `terraform` block name is historical — it doesn't mean "Terraform only."

**What we actually did for safety:**

1. Enabled S3 versioning on state buckets (should have been on already — it wasn't)
2. Took manual state snapshots before each environment migration
3. Ran `tofu plan` immediately after switching — any drift from the switch would show up
4. Kept Terraform 1.5 binary installed for one-click rollback during the transition window

Zero state corruption incidents. The format compatibility promise held.

## Phase 4: CI/CD Updates

Every pipeline that ran `terraform` needed to run `tofu`. Our GitHub Actions changes:

```yaml
# Update GitHub Actions
- name: Setup OpenTofu
  uses: tofu-actions/setup-tofu@v1
  with:
    tofu_version: 1.6.0

- name: OpenTofu Init
  run: tofu init

- name: OpenTofu Plan
  run: tofu plan
```

We migrated CI in waves:

1. **Sandbox pipelines first** — broken builds here don't page anyone
2. **Staging next** — validate plan/apply cycle with real-ish infrastructure
3. **Production last** — with required approvals unchanged

Wrapper scripts got a simple abstraction:

```bash
#!/bin/bash
# infra.sh — binary-agnostic wrapper
IAC_BIN="${IAC_BIN:-tofu}"
$IAC_BIN "$@"
```

During transition, `IAC_BIN=terraform infra.sh plan` still worked for rollback. After cutover, the default was `tofu`.

**Gotcha:** Pre-commit hooks. We had `terraform fmt` and `terraform validate` in pre-commit config. Updated to `tofu fmt` and `tofu validate`. Three developers committed broken HCL in the two hours before everyone pulled the hook update. Minor, but worth communicating.

## Phase 5: Team Transition

The technical migration was easier than the human migration.

**What worked:**

- A one-page cheat sheet: `terraform X` → `tofu X` (it's the same)
- A 30-minute team walkthrough, not a day-long training
- Office hours for the first week after production cutover
- Updated README files in every infra repo

**What we should have done earlier:**

- Told the team *why* we were migrating, not just *what* to type
- Documented the rollback procedure before anyone asked
- Agreed on a version pinning policy for OpenTofu itself

The funniest moment: a senior engineer typed `terraform plan` out of muscle memory for three weeks after cutover. It still worked — they'd installed tfenv with both binaries and tfenv shimmed to tofu. Accidental success.

## Production Rollout Strategy

We didn't flip a big red switch. The rollout:

| Week | Environment | Action |
|------|-------------|--------|
| 1–2  | Sandbox     | Full migration, all modules |
| 3    | Staging     | Migration + soak test |
| 4    | Production (non-critical) | DNS, monitoring, logging modules |
| 5    | Production (critical) | VPC, RDS, EKS — one module per day |
| 6    | Cleanup     | Remove Terraform binaries, archive docs |

Critical modules got one-per-day migration with a mandatory plan review by two engineers. Paranoid? Yes. But RDS state mistakes don't forgive.

## What Broke (Honestly)

Not nothing, but less than feared:

1. **Provider version drift** — one Datadog provider update changed attribute defaults. Caught in staging.
2. **IDE plugins** — VS Code Terraform extension mostly worked with OpenTofu but auto-formatting was flaky for two weeks until extension update.
3. **Third-party docs** — some tutorials and modules still say `terraform`. New hires were confused for a day.

What didn't break: state files, remote backends, module sources, HCL syntax, provider resources, or production infrastructure.

## Rollback Plan (We Didn't Need It, But Had It)

```bash
# Emergency rollback procedure
export IAC_BIN=terraform
terraform init          # re-initialize with Terraform provider cache
terraform plan          # verify plan is clean
# If plan is clean, Terraform is still managing the same state
```

Because state format is shared, rollback is binary-level, not data migration. Keep the old Terraform binary available for 30 days post-migration. We kept it for 90 days, then deleted it.

## Practical Takeaways

OpenTofu migration in production is boring in the best way. Same language, same state, same providers, different binary. The work is organizational: CI pipelines, scripts, team habits, and careful sequencing.

**Do this:**

- Audit before migrating — know your provider dependencies
- Test in non-production with real modules, not toy examples
- Pin provider versions explicitly during transition
- Migrate CI before production
- Keep rollback binaries available
- Communicate the why to your team

**Don't do this:**

- Migrate all environments simultaneously
- Skip `tofu plan` verification after switching
- Assume IDE tooling will just work
- Delete Terraform state backups because "we don't need them anymore"

The license change that started this project was annoying. The migration it forced was, in hindsight, straightforward. Our infrastructure code didn't change. Our deployment pipelines changed one word. Production didn't notice.

Six weeks later, legal was happy, engineering was happy, and the only ongoing difference was typing `tofu` instead of `terraform`. Sometimes the best infrastructure migration is the one nobody remembers.

---

*OpenTofu production migration — March 2023. Check [opentofu.org](https://opentofu.org/) for current releases and provider compatibility.*

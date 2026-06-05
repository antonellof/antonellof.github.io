---
layout: post
title: "OpenTofu: Open Source Alternative to Terraform"
date: 2022-07-02
categories: [How-To]
tags: [OpenTofu, Terraform, IaC]
excerpt: "When your entire infrastructure is defined in HCL files and the tooling license changes, you don't want to rewrite 200 modules—you want a drop-in replacement. That's the gap OpenTofu fills."
---

Infrastructure as Code changed how I ship. Instead of clicking through AWS consoles and hoping I remembered every setting, I describe what I want in `.tf` files, run `plan`, review the diff, and apply. Reproducible. Reviewable. Version-controlled.

For years, Terraform was the default. The ecosystem was massive—providers for everything, modules for every pattern, CI/CD integrations galore. Our team had 200+ modules, years of state files, and pipelines wired to `terraform plan` on every PR.

Then the license conversation happened. HashiCorp moved Terraform from MPL 2.0 to the Business Source License (BSL). For many organizations—especially those with strict open-source policies or concerns about vendor lock-in—this raised a question: **what happens to our infrastructure if the tooling direction diverges from our needs?**

The community's answer was [OpenTofu](https://opentofu.org/)—a fork of Terraform maintained under the Linux Foundation, licensed under MPL 2.0, committed to remaining open source. Same HCL syntax. Same provider ecosystem. Same workflow. Different binary name.

I've migrated production pipelines from Terraform to OpenTofu. Here's what you need to know.

## What OpenTofu Actually Is

OpenTofu isn't a rewrite or a competitor trying to do things differently. It's a **fork**—a continuation of Terraform's open-source lineage before the BSL change:

| Aspect | Terraform (BSL) | OpenTofu (MPL 2.0) |
|--------|-----------------|---------------------|
| Language | HCL | HCL (identical) |
| Providers | Terraform Registry | Same registry, same providers |
| State format | JSON | Compatible |
| CLI commands | `terraform` | `tofu` |
| License | Business Source License | Mozilla Public License 2.0 |
| Governance | HashiCorp | Linux Foundation |

If you've written Terraform, you already know OpenTofu. The migration is a binary swap, not a rewrite.

## Why Teams Are Migrating

Different organizations have different reasons. I've heard all of these:

**Open-source policy compliance.** Companies with "no BSL software" policies need an alternative that doesn't require legal exceptions.

**Community governance.** Some teams prefer Linux Foundation governance over a single vendor controlling the roadmap.

**Long-term stability concerns.** Infrastructure code has a 5-10 year lifespan. Teams want confidence the tooling won't shift beneath them.

**Nothing broke—they just wanted MPL.** Plenty of teams were happy with Terraform and switched purely for licensing peace of mind. The migration cost was low enough to justify it.

I'm not here to argue Terraform vs. OpenTofu on features—they're largely identical today. The decision is about licensing, governance, and where you want your infrastructure tooling bet placed.

## Installation

OpenTofu installs alongside Terraform—they don't conflict:

```bash
# macOS
brew install opentofu

# Linux (direct download)
wget https://github.com/opentofu/opentofu/releases/download/v1.6.0/tofu_1.6.0_linux_amd64.zip
unzip tofu_1.6.0_linux_amd64.zip
sudo mv tofu /usr/local/bin/

# Verify
tofu version
# OpenTofu v1.6.0
```

Keep Terraform installed during migration. Run both in parallel until you're confident.

For CI/CD, pin the version explicitly:

```yaml
# GitHub Actions example
- name: Setup OpenTofu
  uses: opentofu/setup-opentofu@v1
  with:
    tofu_version: 1.6.0

- name: Plan
  run: tofu plan -out=tfplan
```

## Migration: The Actual Steps

The good news: migration is boring. That's the point.

### Step 1: Inventory Your Setup

Before changing anything, know what you have:

```bash
# List all workspaces/environments
find . -name "*.tf" -o -name "*.tfstate" | head -20

# Check current Terraform version
terraform version

# Check provider versions
grep -r "required_providers" .
```

Document:
- Terraform version in use
- Provider versions and sources
- Backend configuration (S3, GCS, Terraform Cloud, etc.)
- CI/CD pipeline locations
- State file locations

### Step 2: Test in Dev

Pick your least critical environment. Swap the binary:

```bash
cd environments/dev

# Initialize with OpenTofu (reads existing .terraform/)
tofu init

# Plan should show NO changes if migration is clean
tofu plan
```

If `tofu plan` shows changes you don't expect, stop and investigate. A clean migration shows zero diff.

Common first-run issues:

```bash
# Provider lock file may need updating
tofu init -upgrade

# Backend configuration unchanged—same state file
# OpenTofu reads terraform.tfstate natively
```

### Step 3: State File Compatibility

OpenTofu uses the same state format as Terraform. Your existing state files work without conversion:

```bash
# State file location (unchanged)
# backend "s3" {
#   bucket = "my-terraform-state"
#   key    = "prod/terraform.tfstate"
# }

# OpenTofu reads and writes the same format
tofu state list
tofu state show aws_instance.web
```

**Important:** Don't run Terraform and OpenTofu against the same state simultaneously. Pick one tool per environment during migration. State locking prevents corruption, but mixed tooling invites confusion.

### Step 4: Update CI/CD Pipelines

Find and replace in your pipelines:

```bash
# Before
terraform init
terraform plan -out=tfplan
terraform apply tfplan

# After
tofu init
tofu plan -out=tfplan
tofu apply tfplan
```

Our GitLab CI migration was literally a sed command and a week of monitoring:

```yaml
# .gitlab-ci.yml
plan:
  stage: plan
  script:
    - tofu init -input=false
    - tofu plan -out=plan.cache -input=false
  artifacts:
    paths:
      - plan.cache

apply:
  stage: apply
  script:
    - tofu apply -input=false plan.cache
  when: manual
  only:
    - main
```

### Step 5: Roll Out Environment by Environment

Our rollout order:

1. **Dev** — break things here first (we didn't)
2. **Staging** — validate CI/CD changes
3. **Production (non-critical)** — internal tools, monitoring infra
4. **Production (critical)** — customer-facing infrastructure

Each environment: `tofu plan` (expect zero changes) → merge pipeline changes → monitor for a week → next environment.

Total migration time: three weeks, mostly waiting between environments.

## What Works Identically

These require zero changes:

**HCL configuration files.** Every `.tf` file works as-is:

```hcl
resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"

  tags = {
    Name = "web-server"
  }
}
```

**Provider configuration.** Same sources, same versions:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

**Modules.** Public and private modules work unchanged:

```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
  
  name = "my-vpc"
  cidr = "10.0.0.0/16"
}
```

**Remote state backends.** S3, GCS, Azure Blob, Terraform Cloud—all supported:

```hcl
terraform {
  backend "s3" {
    bucket         = "my-org-terraform-state"
    key            = "prod/vpc/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}
```

**Workspaces, variables, outputs, data sources.** All identical syntax and behavior.

## What's Different (So Far)

OpenTofu is actively diverging with community-driven features. As of recent releases:

**Command name.** `terraform` → `tofu`. Scripts and aliases need updating.

**Early variable evaluation.** OpenTofu can use variables in backend configuration more flexibly:

```hcl
terraform {
  backend "s3" {
    bucket = "my-state"
    key    = "env/${var.environment}/terraform.tfstate"
    region = "us-east-1"
  }
}
```

**State encryption.** Client-side state encryption (experimental):

```hcl
terraform {
  encryption {
    key_provider "pbkdf2" "default" {
      passphrase = var.state_encryption_passphrase
    }
    
    method "aes_gcm" "default" {
      keys = key_provider.pbkdf2.default
    }
    
    state {
      method   = method.aes_gcm.default
      enforced = true
    }
  }
}
```

**Provider mapping overrides.** Ability to redirect provider sources—useful during transitions.

Check the [OpenTofu changelog](https://github.com/opentofu/opentofu/releases) for current feature differences. The gap is intentional—community priorities vs. vendor priorities.

## Migration Gotchas

Things that tripped us up:

**Terraform Cloud vs. OpenTofu.** If you use Terraform Cloud for remote operations, evaluate OpenTofu's native S3/GCS backends or tools like [Spacelift](https://spacelift.io/) and [Scalr](https://scalr.com/) that support both.

**Provider lock files.** The `.terraform.lock.hcl` file works with both tools, but run `tofu init` after switching to ensure consistency.

**IDE extensions.** VS Code Terraform extensions mostly work with OpenTofu. Update settings to point to `tofu` binary if auto-formatting matters.

**Team habits.** Engineers typing `terraform` out of muscle memory. We added shell aliases during transition:

```bash
# Temporary alias during migration (remove after cutover)
alias terraform='echo "Use tofu, not terraform" && false'
```

**Documentation drift.** Runbooks, wikis, onboarding docs—all said "Terraform." grep across your org's docs and update.

## Running Both During Transition

Some teams run Terraform and OpenTofu in parallel during evaluation:

```bash
# Compare plans
terraform plan -out=tf.plan 2>/dev/null
tofu plan -out=tofu.plan 2>/dev/null

# Plans should be identical for unchanged infrastructure
diff <(terraform show -json tf.plan | jq '.resource_changes') \
     <(tofu show -json tofu.plan | jq '.resource_changes')
```

If plans diverge unexpectedly, investigate before committing to migration.

## Should You Migrate?

Honest assessment framework:

**Migrate if:**
- BSL licensing conflicts with company policy
- You want Linux Foundation governance
- Community-driven roadmap aligns with your needs
- Migration cost (a few weeks) is acceptable

**Stay on Terraform if:**
- BSL licensing isn't a concern for your organization
- You're heavily invested in Terraform Cloud features
- HashiCorp's enterprise support is critical
- "If it ain't broke" is a valid strategy (it often is)

**Either way:**
- Pin your tool version in CI/CD
- Lock provider versions
- Back up state files before any tooling change
- Test in dev first

There's no wrong answer—only whether the migration cost justifies the benefit for your situation.

## Conclusion

OpenTofu exists because infrastructure code outlives tooling decisions. When you've invested years in HCL modules, provider configurations, and CI/CD pipelines, you shouldn't have to rewrite everything because the license changed.

Migration is a binary swap: install OpenTofu, run `tofu init`, verify `tofu plan` shows zero changes, update CI/CD. Our 200-module migration took three weeks and zero infrastructure changes.

Same language. Same providers. Same state. Different governance. For teams where that matters, OpenTofu is the path forward without starting over.

**Further Resources:**
- [OpenTofu Official Site](https://opentofu.org/) — Documentation and migration guide
- [OpenTofu GitHub](https://github.com/opentofu/opentofu) — Source and releases
- [OpenTofu vs Terraform Comparison](https://opentofu.org/faq/) — Official FAQ
- [Linux Foundation Announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-opentofu) — Project governance
- [HCP Terraform vs OpenTofu Backends](https://opentofu.org/docs/intro/migration/) — Backend migration guide

---

*OpenTofu from July 2022, covering migration from Terraform.*

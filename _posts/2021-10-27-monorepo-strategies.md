---
layout: post
title: "Monorepo Strategies: Nx, Turborepo, and Lerna"
date: 2021-10-27
categories: [Architecture]
tags: [Monorepo, Nx, Turborepo, Lerna]
excerpt: "Twelve repos, twelve CI pipelines, twelve versions of lodash. We consolidated into one monorepo and spent the savings on Nx task caching instead of more DevOps contractors."
---

At one point we had 12 repositories for a product that was one product. Shared utility code was copy-pasted or published to a private npm registry that nobody versioned correctly. A bug fix in the shared library required coordinated releases across 4 repos. CI ran the full test suite on every repo for every commit, even when only the README changed.

"We should use a monorepo," someone said. The debate lasted months. Monorepos aren't free—they're a trade. You gain atomic cross-package changes and shared tooling. You pay with tooling complexity and CI configuration.

We moved to a monorepo with Nx. Build times dropped 60% with caching. Cross-package changes became single PRs. The private npm registry for internal packages died. Here's how to choose and use monorepo tooling.

## Why Monorepo (And When Multi-Repo Wins)

**Monorepo advantages:**
- **Atomic changes** — one PR updates API and client together
- **Shared tooling** — one ESLint, one TypeScript config, one CI pipeline
- **Code sharing** — import shared code directly, not via published packages
- **Refactoring** — change a shared type, fix all usages in one commit

**Monorepo costs:**
- **CI complexity** — need affected-package detection
- **Tooling investment** — Nx/Turborepo learning curve
- **Scale limits** — very large monorepos (Google-scale) need specialized infrastructure
- **Access control** — harder to restrict who sees what (everything is visible)

**Stick with multi-repo when:** teams are fully independent, release cycles don't overlap, or regulatory requirements mandate repository separation.

**Monorepo when:** shared code, coordinated releases, one product with multiple packages.

## Tool Comparison

| Tool | Strength | Best for |
|------|----------|----------|
| **Nx** | Computation caching, affected commands, generators | Large teams, polyglot repos |
| **Turborepo** | Simple pipeline config, fast caching | JS/TS monorepos, Vercel ecosystem |
| **Lerna** | Package publishing, versioning | Libraries published to npm |
| **pnpm workspaces** | Efficient dependency management | Any monorepo (often combined with above) |

Most teams use **pnpm/yarn workspaces** for dependency management plus **Nx or Turborepo** for task orchestration and caching.

## Nx: The Power User Choice

```bash
npx create-nx-workspace@latest myorg --preset=ts
```

### Project Structure

```
myorg/
├── apps/
│   ├── web/              # React frontend
│   ├── api/              # Node.js API
│   └── admin/            # Admin dashboard
├── libs/
│   ├── shared/ui/        # Shared components
│   ├── shared/types/     # Shared TypeScript types
│   └── shared/utils/     # Shared utilities
├── nx.json
└── package.json
```

### Task Execution with Caching

```bash
# Run tests for one project
nx test web

# Build only affected by current changes
nx affected:build --base=main

# Run with cache (second run is instant if nothing changed)
nx build api  # First run: 45s
nx build api  # Cached: 0.3s
```

Nx caches task outputs locally and remotely (Nx Cloud). CI runs `nx affected:test` and only tests what changed. This is where the 60% build time reduction came from.

### Dependency Graph

```bash
nx graph
```

Visualize which projects depend on which. Before refactoring `shared/types`, see every consumer.

## Turborepo: Simple and Fast

```bash
npx create-turbo@latest
```

### Pipeline Configuration

```json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

`dependsOn: ["^build"]` means "build dependencies first." Turborepo understands the package graph and runs tasks in correct order, parallelizing where possible.

```bash
turbo run build          # Build everything
turbo run test --filter=web  # Test only web package
turbo run build --filter=...[origin/main]  # Build affected by changes
```

Turborepo's config is simpler than Nx. Less feature-rich, but faster to adopt. Vercel's remote caching integrates seamlessly.

## Lerna: Publishing Focus

Lerna predates Nx and Turborepo. Its strength is **versioning and publishing** packages to npm:

```bash
lerna init
```

```json
{
  "version": "independent",
  "npmClient": "pnpm",
  "command": {
    "publish": {
      "conventionalCommits": true,
      "message": "chore(release): publish"
    }
  }
}
```

```bash
lerna version    # Bump versions based on conventional commits
lerna publish    # Publish changed packages to npm
```

Use Lerna (or Nx release) when your monorepo publishes libraries externally. For internal-only monorepos, publishing tooling is less critical.

## Package Management with Workspaces

```json
{
  "name": "myorg",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

Internal dependencies reference workspace packages:

```json
{
  "dependencies": {
    "@myorg/shared-types": "workspace:*",
    "@myorg/ui": "workspace:*"
  }
}
```

No publishing step for internal packages. Change `shared-types`, all consumers see it immediately. This eliminated our broken private npm registry.

**Use pnpm** for workspaces—faster installs, strict dependency resolution, efficient disk usage via symlinks.

## CI/CD for Monorepos

The critical CI optimization: **only run tasks for affected packages.**

```yaml
# GitHub Actions with Nx
- name: Derive affected bases
  run: |
    echo "BASE=$(git merge-base origin/main HEAD)" >> $GITHUB_ENV

- name: Test affected
  run: npx nx affected:test --base=$BASE

- name: Build affected
  run: npx nx affected:build --base=$BASE
```

Without affected detection, a README change in `apps/web` triggers tests for `apps/api`, `libs/utils`, and everything else. With it, only `apps/web` tests run.

Remote caching shares cache between CI runs and developer machines:

```bash
# Nx Cloud or Turborepo Remote Cache
# Developer builds locally → CI uses cached output
# CI builds → developer uses cached output
```

## Practical Lessons

### What Worked

1. **Shared TypeScript config** — `tsconfig.base.json` extended by all packages
2. **Shared linting** — one ESLint config, enforced everywhere
3. **Affected commands in CI** — 60% faster pipelines
4. **Remote caching** — developers and CI share build artifacts
5. **CODEOWNERS per package** — clear ownership within the monorepo

### What Hurt

1. **Migrating all repos at once** — migrate incrementally
2. **No affected detection in CI** — full test suite on every commit
3. **Inconsistent package naming** — enforce `@org/package` convention early
4. **Circular dependencies** — Nx graph helps detect; fix immediately

### Monorepo Boundaries

Not everything belongs in one repo:
- **Infrastructure/terraform** — often separate
- **Mobile apps** — sometimes separate (different release cycles)
- **Experimental projects** — don't pollute the main monorepo

## Choosing Your Tool

**Choose Nx if:** large team, polyglot (JS + Java + Go), need generators/scaffolding, want comprehensive affected analysis.

**Choose Turborepo if:** JS/TS only, want minimal config, Vercel deployment, fast adoption.

**Choose Lerna if:** primary need is publishing packages to npm with versioning.

**Combine:** pnpm workspaces + Turborepo is a popular, lightweight stack. pnpm workspaces + Nx for larger organizations.

## Conclusion

Monorepos don't eliminate complexity—they centralize it. One CI pipeline to configure instead of twelve. One dependency graph to understand instead of a web of published packages. One PR for cross-cutting changes instead of coordinated releases.

The 12-repo chaos became one monorepo with Nx caching. Build times dropped. Cross-package refactoring became fearless. The private npm registry for internal utilities retired un-mourned.

Start with workspaces (pnpm). Add Turborepo or Nx when CI gets slow. Use affected commands from day one. Set up remote caching when the team grows past five.

The goal isn't "monorepo because Google does it." The goal is shipping coordinated changes faster with less tooling overhead. Monorepos deliver that—when you invest in the right tools.

---

*Monorepo strategies from October 2021, covering Nx, Turborepo, and Lerna.*

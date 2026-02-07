---
layout: post
title: "Monorepo Strategies: Nx, Turborepo, and Lerna"
date: 2021-10-15
categories: [Architecture]
tags: [Monorepo, Nx, Turborepo, Lerna]
excerpt: "Manage monorepos with Nx, Turborepo, and Lerna. Learn workspace management, task orchestration, dependency management, and scaling strategies for large codebases."
---

Monorepos manage multiple packages in one repository. After managing production monorepos, here's how to use the tools effectively.

## What is a Monorepo?

A monorepo:
- **Multiple packages** - In one repository
- **Shared code** - Common utilities
- **Atomic changes** - Cross-package commits
- **Single source** - One version control

## Nx

### Setup

```bash
npx create-nx-workspace my-workspace
cd my-workspace
```

### Create Application

```bash
nx generate @nrwl/react:application my-app
nx generate @nrwl/node:library shared-utils
```

### Task Execution

```bash
# Run tests
nx test my-app

# Build
nx build my-app

# Affected commands
nx affected:test
nx affected:build
```

### Configuration

```json
{
  "projects": {
    "my-app": "apps/my-app",
    "shared-utils": "libs/shared-utils"
  },
  "defaultBase": "main"
}
```

## Turborepo

### Setup

```bash
npx create-turbo@latest
```

### Turbo.json

```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    }
  }
}
```

### Run Tasks

```bash
# Run build for all packages
turbo run build

# Run only affected
turbo run build --filter=...my-package

# Parallel execution
turbo run build --parallel
```

## Lerna

### Setup

```bash
npm install -g lerna
lerna init
```

### Lerna.json

```json
{
  "version": "independent",
  "npmClient": "npm",
  "command": {
    "publish": {
      "conventionalCommits": true
    }
  }
}
```

### Commands

```bash
# Bootstrap dependencies
lerna bootstrap

# Run script in all packages
lerna run test

# Publish packages
lerna publish
```

## Package Management

### Workspaces

```json
{
  "workspaces": [
    "packages/*",
    "apps/*"
  ]
}
```

### Shared Dependencies

```json
{
  "dependencies": {
    "shared-utils": "workspace:*"
  }
}
```

## Best Practices

1. **Use tools** - Nx, Turborepo, or Lerna
2. **Task orchestration** - Parallel execution
3. **Dependency management** - Workspaces
4. **CI/CD** - Affected packages
5. **Code sharing** - Shared libraries
6. **Versioning** - Independent or fixed
7. **Testing** - Cross-package tests
8. **Documentation** - Clear structure

## Conclusion

Monorepo tools enable:
- Code sharing
- Atomic changes
- Task orchestration
- Better DX

Choose the right tool for your needs. The strategies shown here scale to large codebases.

---

*Monorepo strategies from October 2021, covering Nx, Turborepo, and Lerna.*

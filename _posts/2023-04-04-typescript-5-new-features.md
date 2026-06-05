---
layout: post
title: "TypeScript 5.0: New Features and Improvements"
date: 2023-04-04
categories: [How-To]
tags: [TypeScript, JavaScript, Language Features]
excerpt: "TypeScript 5.0 shipped ECMAScript decorators, made 'as const' work in generics, and compiled twice as fast. Here's what actually mattered when I upgraded our monorepo."
---

The PR that upgraded TypeScript from 4.9 to 5.0 was supposed to be a one-line change. `npm install -D typescript@^5.0.0`, run the build, merge. Famous last words.

The build failed in eleven minutes. Not because TypeScript 5.0 is broken — it's excellent — but because major version bumps surface every `@ts-ignore` you'd been meaning to fix, every deprecated option in `tsconfig.json`, and every library whose types assumed the old compiler behavior.

I still think the upgrade was worth it. TypeScript 5.0 isn't a feature fireworks show — it's a maturity release. Decorators finally match the ECMAScript standard. Const type parameters fix a generics papercut that's annoyed me for years. The compiler is genuinely faster. If you're still on 4.x, this is the release that makes upgrading feel like progress, not punishment.

## What's Actually New (And Why You Should Care)

### ECMAScript Decorators: Finally Standard

TypeScript had decorators since 2015. They were experimental, loosely typed, and different from what JavaScript was actually standardizing. TypeScript 5.0 ships decorators that match the [ECMAScript decorator proposal](https://github.com/tc39/proposal-decorators).

```typescript
// Standard decorators in TypeScript 5.0
function logged(target: any, context: ClassMethodDecoratorContext) {
    const methodName = String(context.name);
    return function (this: any, ...args: any[]) {
        console.log(`Calling ${methodName}`);
        return target.apply(this, args);
    };
}

class MyClass {
    @logged
    myMethod() {
        // Method implementation
    }
}
```

**Why this matters:** If you've been using frameworks that depend on decorators — Angular, NestJS, various ORM layers — the standardization path just got clearer. The old `experimentalDecorators` mode still exists for backward compatibility, but new code should use the standard.

**My migration experience:** We had 14 decorator usages across the codebase. Three were custom logging decorators (easy). Four were NestJS controllers (NestJS 9+ handles both modes). Seven were legacy `@reflect-metadata` patterns that needed manual review. Budget a day for a medium-sized codebase, not an hour.

Enable in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": false,
    "emitDecoratorMetadata": false
  }
}
```

For NestJS projects still on experimental decorators, keep `experimentalDecorators: true` until the framework version you're on supports standard decorators. Check their migration guide — don't guess.

### Const Type Parameters: `as const` in Generics

This is the feature I didn't know I needed until I used it once and got angry I'd lived without it.

```typescript
// Const type parameters
function getFirst<T extends readonly string[]>(values: readonly [...T]) {
    return values[0];
}

const result = getFirst(['a', 'b', 'c'] as const);
// result is 'a' (literal type), not string
```

Before TypeScript 5.0, passing `['a', 'b', 'c'] as const` to a generic function often widened the return type to `string`. You'd lose literal type information precisely where you wanted to keep it — routing tables, i18n keys, event names, configuration objects.

I used this immediately in a type-safe event emitter:

```typescript
type EventMap = {
    'user.created': { id: string };
    'user.deleted': { id: string };
    'order.placed': { orderId: string };
};

function createEmitter<Events extends Record<string, unknown>>() {
    return {
        on<K extends keyof Events & string>(event: K, handler: (data: Events[K]) => void) {
            // ...
        }
    };
}
```

With const type parameters, event names inferred from `as const` arrays stay literal-typed through generic boundaries. Fewer `as` casts. Fewer runtime bugs from typos that the compiler used to miss.

### Performance: Not Marketing, Measurable

TypeScript 5.0 restructured the compiler internals — moving from enums to union types in the type checker, reducing memory allocations, optimizing the build graph. Microsoft claims up to 2x faster compilation. Our monorepo numbers:

| Metric | TS 4.9 | TS 5.0 | Change |
|--------|--------|--------|--------|
| Clean build | 4m 12s | 2m 18s | -45% |
| Incremental (one file) | 8s | 4s | -50% |
| `tsserver` memory | 890MB | 620MB | -30% |

Your mileage varies by project size and type complexity. But faster builds aren't just convenience — they change how often developers run `tsc`. When the build takes four minutes, people push and pray. When it takes two, they actually check.

Smaller npm package size for the `typescript` package itself is a nice bonus for CI caches.

### Other Improvements Worth Knowing

**`moduleResolution: bundler`** — new option for projects using Vite, esbuild, or other modern bundlers. Tells the compiler "don't resolve like Node, resolve like a bundler." If you've fought `Cannot find module` errors in Vite projects, this helps.

**`verbatimModuleSyntax`** — stricter, clearer import/export handling. `import type` is enforced. Side-effect imports are explicit. Migration can be noisy but the resulting code is more honest about what runs at runtime.

**Enum improvements** — TypeScript 5.0 makes enums into union types internally, which speeds up type checking on enum-heavy codebases. We had one file with a 200-value enum that actually compiled noticeably faster.

**JSDoc `@satisfies`** — you can use `satisfies` in JavaScript files with JSDoc annotations now. Great for gradual migration projects.

See the full [TypeScript 5.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html) for the complete list.

## Migration Guide: What Actually Breaks

### Update Dependencies

```bash
npm install -D typescript@^5.0.0
```

Also update `@types/node`, `typescript-eslint`, and any typed libraries that pinned to older TypeScript peer dependencies. The TypeScript upgrade is the domino that knocks over type packages.

### Update tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true
  }
}
```

Don't copy this blindly. `moduleResolution: bundler` only makes sense if you actually use a bundler. Node.js backend projects should likely stay on `"moduleResolution": "node16"` or `"nodenext"`.

### Breaking Changes We Hit

1. **`@ts-ignore` behavior** — some suppressed errors became visible. Good, actually.
2. **Deprecated options removed** — `importsNotUsedAsValues`, `preserveValueImports` consolidated into `verbatimModuleSyntax`
3. **Stricter type inference** — a generic utility type that "worked" via accidental `any` propagation now correctly errors
4. **API changes** — if you use the TypeScript compiler API directly (custom lint rules, codegen), check the [breaking changes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#breaking-changes)

Our eleven-minute build failure was a cascade: one deprecated tsconfig option, three newly-visible type errors, and a `@types` package that needed bumping. All fixable. None were runtime bugs — the old code was wrong, the new compiler was honest.

## How I Approach Major TypeScript Upgrades

After four major version upgrades across different teams, the pattern is consistent:

**Week before upgrade:**
- Run `tsc --noEmit` on current version, ensure clean build
- Audit `tsconfig.json` for deprecated options
- Check library peer dependency compatibility

**Upgrade day:**
- Bump TypeScript and `@types/*` together
- Fix tsconfig deprecations first (fast wins)
- Fix type errors file-by-file, starting with shared utilities
- Run tests — type fixes can change runtime behavior if you "fix" with `as any`

**Week after upgrade:**
- Monitor CI build times (confirm performance gains)
- Update team style guide if new features change conventions
- Enable stricter options you previously couldn't (`verbatimModuleSyntax`, etc.)

## Features I'm Actually Using in Production

**Const type parameters** — routing, event systems, config validation. Daily.

**Standard decorators** — new services on NestJS. Gradual.

**`moduleResolution: bundler`** — every Vite frontend project. Immediately.

**`satisfies` operator** (shipped in 4.9, better in 5.0) — config objects where you want type checking without widening:

```typescript
const config = {
    endpoint: 'https://api.example.com',
    retries: 3,
    timeout: 5000,
} satisfies ServiceConfig;
// config.retries is number, but config is checked against ServiceConfig
```

**Performance gains** — felt in CI, felt in IDE, appreciated by everyone even though nobody filed a ticket about it.

## Features I'm Not Using Yet

**Standard decorators on legacy Angular code** — waiting for Angular's migration path to complete for our version.

**`verbatimModuleSyntax` on the backend monorepo** — too many side-effect imports to fix in one PR. Scheduled for a dedicated cleanup sprint.

**Custom decorators beyond logging** — the team is still building intuition for when decorators help vs. when a plain function is clearer.

## Practical Takeaways

TypeScript 5.0 is the upgrade I'd recommend to any team still on 4.x. Not because one feature changes everything, but because the combination — standard decorators, const type parameters, faster builds, bundler-aware resolution — makes the daily experience meaningfully better.

The upgrade cost is real but bounded. Our monorepo took two engineer-days to migrate cleanly. The build time savings pay that back within a month in CI alone.

**Start here:**

1. Read the [release notes breaking changes section](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#breaking-changes)
2. Upgrade in a dedicated branch, not alongside feature work
3. Bump TypeScript and type packages together
4. Adopt `moduleResolution: bundler` if you use Vite/esbuild
5. Try const type parameters in your next generic utility — you'll keep them

TypeScript's best releases aren't the ones with the flashiest features. They're the ones where the compiler gets out of your way faster, catches more bugs, and aligns with where JavaScript is actually going. Version 5.0 checks all three boxes.

---

*TypeScript 5.0 — April 2023. See [typescriptlang.org](https://www.typescriptlang.org/) for current releases and migration guides.*

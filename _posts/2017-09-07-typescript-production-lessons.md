---
layout: post
title: "TypeScript in Production: Lessons Learned"
date: 2017-09-07
categories: [Lessons Learned]
tags: [TypeScript, JavaScript, Production, Best Practices]
excerpt: "A year of TypeScript in production taught us that types catch bugs — and that `any` is a trap door you will fall through at 11 p.m."
---

The bug was a classic: `undefined is not a function`. Someone had refactored a user service, renamed a method, and updated fourteen call sites. They missed fifteen. JavaScript didn't care. Production did.

We'd been debating TypeScript for months — "it's just JavaScript with extra steps," "the build is slower," "who has time to write interfaces?" Then that bug cost us a rollback, an apology email, and roughly six hours of sleep. We started migrating the following Monday.

A year later, the codebase was mostly TypeScript, strict mode was on, and `any` was treated like `@ts-ignore`: a confession that you'd given up. Here's what actually mattered in production — not the theoretical benefits, but the patterns that stuck and the traps that didn't.

## Why We Stayed After the Migration Pain

The sales pitch is real, but the production receipts are better:

- **Fewer runtime surprises**: Typos and wrong argument types die at compile time
- **IDE superpowers**: Autocomplete that actually knows your data shapes
- **Living documentation**: Types don't go stale like wiki pages
- **Refactoring confidence**: Rename a field, let the compiler find every usage

The build got slightly slower. The deploys got noticeably calmer. Fair trade.

## Migration: Big Bang Is a Bad Idea

Rewriting 40,000 lines of JavaScript over a weekend sounds heroic. It ends with a heroic rollback.

### Gradual Migration via `allowJs`

```json
// tsconfig.json - Allow JavaScript
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": false,  // Don't check .js files initially
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

New files get `.ts` extensions. Old files migrate when someone touches them for another reason. Boring? Yes. Sustainable? Also yes.

```typescript
// Start with new files
// user-service.ts (new)
export interface User {
    id: string;
    name: string;
    email: string;
}

export function getUser(id: string): Promise<User> {
    // Implementation
}

// Gradually migrate old files
// old-file.js → old-file.ts
```

### JSDoc: The Bridge for Files You Haven't Converted Yet

```javascript
// user.js - Add JSDoc types
/**
 * @param {string} userId
 * @returns {Promise<{id: string, name: string, email: string}>}
 */
async function getUser(userId) {
    // Implementation
}
```

Turn on `checkJs` selectively for high-risk modules. You get type checking without renaming a single file.

## Types: Your Best Friend and Your Worst Habit

### `any` Is a Trap Door

```typescript
// BAD
function processData(data: any) {
    return data.value;
}

// GOOD
interface Data {
    value: string;
}

function processData(data: Data) {
    return data.value;
}
```

Every `any` is a hole in your safety net. One `any` at the API boundary can infect an entire call chain. We called it "type rot" — and it spread exactly like you'd expect.

If you genuinely don't know the shape, use `unknown` and narrow it. `any` says "I give up." `unknown` says "prove what this is before you use it."

### Union Types Beat Stringly-Typed APIs

```typescript
// Instead of any
type Status = 'pending' | 'approved' | 'rejected';

function updateStatus(status: Status) {
    // Type-safe status handling
}

// Compile error if invalid
updateStatus('invalid'); // Error!
```

The compiler becomes your QA team for invalid states. `'invalid'` fails at build time, not in a user's browser.

### Generics: Write Once, Type Many Things

```typescript
// Reusable generic function
function getById<T>(id: string): Promise<T> {
    return db.findById(id);
}

// Usage with type inference
const user = await getById<User>('123');
const order = await getById<Order>('456');
```

Generics shine in repositories and API clients. Less copy-paste, fewer "oops, that returns the wrong type" moments.

## Patterns That Earned Their Keep

### API Response Types

Untyped `response.json()` is a slot machine. You always win something; it's rarely what you expected.

```typescript
// Define API response structure
interface ApiResponse<T> {
    data: T;
    error?: string;
    status: number;
}

async function fetchUser(id: string): Promise<ApiResponse<User>> {
    const response = await fetch(`/api/users/${id}`);
    return response.json();
}

// Type-safe usage
const result = await fetchUser('123');
if (result.error) {
    console.error(result.error);
} else {
    console.log(result.data.name); // TypeScript knows data is User
}
```

The `if (result.error)` branch is where TypeScript's control flow analysis quietly saves you from accessing `.data` on an error response.

### Event Handlers Without `any`

```typescript
// Type-safe event handlers
type EventHandler<T> = (event: T) => void;

interface UserEvent {
    type: 'created' | 'updated' | 'deleted';
    userId: string;
    timestamp: Date;
}

class EventEmitter {
    private handlers: Map<string, EventHandler<any>[]> = new Map();
    
    on<T>(event: string, handler: EventHandler<T>) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event)!.push(handler);
    }
    
    emit<T>(event: string, data: T) {
        const handlers = this.handlers.get(event) || [];
        handlers.forEach(handler => handler(data));
    }
}

// Usage
const emitter = new EventEmitter();

emitter.on<UserEvent>('user', (event) => {
    // TypeScript knows event structure
    console.log(event.userId);
});
```

Yes, the internal `Map` still has `any` in the array type — we cleaned that up in pass two. Perfection is a journey.

### Database Models and the Repository Pattern

```typescript
// Define database models
interface User {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
}

// Repository pattern
class UserRepository {
    async findById(id: string): Promise<User | null> {
        // Implementation
    }
    
    async create(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
        // Implementation
    }
    
    async update(id: string, data: Partial<User>): Promise<User> {
        // Implementation
    }
}
```

`Omit` and `Partial` are utility types you'll use constantly. Learn them early; you'll thank yourself when create/update DTOs stop duplicating the full model.

## Configuration: Strict Mode Is Worth the Initial Pain

```json
// tsconfig.json - Enable strict checks
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true
  }
}
```

Turning on `strictNullChecks` after six months of loose typing is a weekend project. Turning it on from day one is an afternoon of swearing followed by years of fewer null pointer... sorry, undefined errors.

### Path Aliases Save Your Sanity

```json
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@models/*": ["src/models/*"],
      "@utils/*": ["src/utils/*"]
    }
  }
}
```

```typescript
// Usage
import { User } from '@models/User';
import { formatDate } from '@utils/date';
```

`../../../models/User` doesn't scale. Neither does your patience for counting dots.

## Testing: Types and Assertions

```typescript
// test-utils.ts
import { expect } from 'chai';

export function assertUser(user: unknown): asserts user is User {
    if (!user || typeof user !== 'object') {
        throw new Error('Not a user');
    }
    
    if (!('id' in user) || !('name' in user)) {
        throw new Error('Invalid user structure');
    }
}

// test.ts
describe('UserService', () => {
    it('should create user', async () => {
        const user = await userService.create({
            name: 'John',
            email: 'john@example.com'
        });
        
        assertUser(user);
        expect(user.name).to.equal('John');
    });
});
```

Type predicates in tests bridge the gap between "the API returned something" and "TypeScript knows it's a User."

## Pitfalls We Stepped In (So You Don't Have To)

### Over-Engineering Types

```typescript
// BAD: Over-complicated
type ComplexType<T extends string, U extends number> = 
    T extends 'a' ? U extends 1 ? 'type1' : 'type2' : 'never';

// GOOD: Simple and clear
type Status = 'active' | 'inactive';
type UserRole = 'admin' | 'user';
```

If you need a whiteboard to explain your type, simplify it. Clever conditional types impress in blog posts; they confuse in code review.

### Suppressing Errors Instead of Fixing Them

```typescript
// BAD: Suppressing errors
// @ts-ignore
const result = someFunction();

// BAD: Using any
const result: any = someFunction();

// GOOD: Fix the types
const result = someFunction() as ExpectedType;
```

`@ts-ignore` is a TODO that compiles. We banned it in CI except with a required comment explaining why.

### Redefining Types You Already Have

```typescript
// BAD: Redefining types
interface CreateUserRequest {
    name: string;
    email: string;
}

interface UpdateUserRequest {
    name?: string;
    email?: string;
}

// GOOD: Use utility types
interface User {
    id: string;
    name: string;
    email: string;
}

type CreateUserRequest = Omit<User, 'id'>;
type UpdateUserRequest = Partial<Omit<User, 'id'>>;
```

One source of truth. When `User` gains a field, your request types update automatically.

## Build Configuration: Dev vs. Prod

```json
// tsconfig.prod.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "sourceMap": false,
    "removeComments": true,
    "declaration": false
  }
}
```

```json
// tsconfig.dev.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "sourceMap": true,
    "inlineSourceMap": false
  }
}
```

Source maps in dev, stripped in prod. Stack traces in production should point to compiled code; debugging locally should point to your actual source.

## What We Actually Did (Not a Checklist, a Sequence)

We enabled `allowJs` and added a baseline `tsconfig.json`. New code was TypeScript from day one. We installed `@types/` packages for every dependency that had them. Existing files migrated opportunistically — touch a file, convert a file.

We chased down `any` types like technical debt with interest. We enabled strict mode module by module, starting with the payment flow (highest stakes, highest payoff). CI ran `tsc --noEmit` on every pull request. No green build, no merge.

## The Bottom Line

TypeScript in production isn't about typing everything perfectly on day one. It's about making wrong assumptions expensive at compile time instead of catastrophic at runtime.

Start gradual. Enable strict mode as soon as you can stomach it. Treat `any` like a code smell. Use utility types instead of duplicating interfaces. Type your API boundaries first — that's where the bugs live.

The migration took months. The payoff started in weeks. Fewer rollbacks, faster refactors, and IDE autocomplete that actually works. For a team shipping JavaScript to production, that's not "extra steps." That's fewer 11 p.m. pages.

---

*Written September 2017, covering TypeScript 2.x patterns and tooling common at the time. Modern TypeScript has evolved significantly — but the migration lessons and strict-mode discipline still apply.*

---
layout: post
title: "TypeScript Advanced Types: A Deep Dive"
date: 2021-05-04
categories: [Deep Dive]
tags: [TypeScript, Types, JavaScript]
excerpt: "TypeScript's type system is a programming language at compile time. Conditional types, mapped types, and template literals aren't academic—they're how we build APIs that catch bugs before runtime."
---

I shipped a bug where `getUserById` returned a user object, but the caller expected an array. Runtime error in production. The function signature was `getUser(id: string): any`. TypeScript was installed. TypeScript wasn't helping.

`any` is an escape hatch that burns you. Advanced types are how you close the hatch—building type-level logic that catches entire categories of bugs at compile time. Not academic type theory. Practical API design: functions that return the right type based on input, objects that only allow valid property access, and domain types that can't be confused with each other.

Here's the advanced TypeScript I use weekly in production code.

## Conditional Types: Types That Branch

Conditional types select types based on conditions—`T extends U ? X : Y`:

```typescript
type IsString<T> = T extends string ? true : false;

type A = IsString<string>;  // true
type B = IsString<number>;  // false
```

This seems trivial until you use it for real problems:

```typescript
// Extract promise resolution type
type Awaited<T> = T extends Promise<infer U> ? U : T;

type Result = Awaited<Promise<string>>;  // string
type Direct = Awaited<number>;           // number
```

`infer` extracts a type from within another type. It's pattern matching for types.

### Extract and Exclude

```typescript
type EventHandler = 'onClick' | 'onSubmit' | 'onChange' | 'className' | 'id';

// Only event handlers
type Handlers = Extract<EventHandler, `on${string}`>;
// 'onClick' | 'onSubmit' | 'onChange'

// Everything except handlers
type Attributes = Exclude<EventHandler, `on${string}`>;
// 'className' | 'id'
```

I use this constantly in component libraries—separate HTML attributes from event handlers automatically.

### ReturnType and Parameters

```typescript
type ReturnType<T> = T extends (...args: any[]) => infer R ? R : never;

async function fetchUser(id: string): Promise<{ name: string }> {
    return { name: 'Alice' };
}

type User = Awaited<ReturnType<typeof fetchUser>>;
// { name: string }
```

Derive types from existing functions instead of duplicating them. Change the function, types update automatically.

## Mapped Types: Transform Object Types

Mapped types iterate over keys and transform values:

```typescript
type Readonly<T> = {
    readonly [P in keyof T]: T[P];
};

type Partial<T> = {
    [P in keyof T]?: T[P];
};

type Required<T> = {
    [P in keyof T]-?: T[P];  // -? removes optional
};
```

These are built into TypeScript. You use them daily. Understanding how they work lets you build custom versions:

```typescript
// Make all properties nullable
type Nullable<T> = {
    [P in keyof T]: T[P] | null;
};

// Make all properties async
type Asyncified<T> = {
    [P in keyof T]: () => Promise<T[P]>;
};

type User = { name: string; email: string };
type AsyncUser = Asyncified<User>;
// { name: () => Promise<string>; email: () => Promise<string> }
```

### Key Remapping (TypeScript 4.1+)

```typescript
type Getters<T> = {
    [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

type User = { name: string; age: number };
type UserGetters = Getters<User>;
// { getName: () => string; getAge: () => number }
```

`as` remaps keys during iteration. Combined with template literal types, you generate API surfaces from domain types.

## Template Literal Types: String Types as Logic

```typescript
type EventName<T extends string> = `on${Capitalize<T>}`;

type Click = EventName<'click'>;    // 'onClick'
type Submit = EventName<'submit'>;  // 'onSubmit'
```

### Type-Safe Route Paths

```typescript
type Path<T, Prefix extends string = ''> = T extends object
    ? {
        [K in keyof T & string]:
            | `${Prefix}${K}`
            | Path<T[K], `${Prefix}${K}.`>
    }[keyof T & string]
    : never;

type Config = {
    database: {
        host: string;
        port: number;
    };
    api: {
        timeout: number;
    };
};

type ConfigPath = Path<Config>;
// 'database' | 'database.host' | 'database.port' | 'api' | 'api.timeout'
```

Use with a type-safe config getter—autocomplete for nested paths, compile error for typos.

### CSS and Design Tokens

```typescript
type Spacing = 'sm' | 'md' | 'lg';
type CSSProperty = `margin-${Spacing}` | `padding-${Spacing}`;
// 'margin-sm' | 'margin-md' | 'margin-lg' | 'padding-sm' | ...
```

## Utility Types You'll Use Constantly

```typescript
// Pick specific properties
type UserPreview = Pick<User, 'id' | 'name'>;

// Omit sensitive properties
type PublicUser = Omit<User, 'password' | 'ssn'>;

// Record for dictionaries
type UserRoles = Record<string, 'admin' | 'member' | 'viewer'>;

// NonNullable removes null/undefined
type DefiniteString = NonNullable<string | null>;  // string
```

**Pro pattern:** derive API response types from domain types:

```typescript
type User = {
    id: string;
    name: string;
    email: string;
    password: string;
    createdAt: Date;
};

type UserResponse = Omit<User, 'password'> & {
    createdAt: string;  // serialized
};
```

## Type Guards: Runtime Checks That Narrow Types

```typescript
function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function processInput(input: unknown) {
    if (isString(input)) {
        console.log(input.toUpperCase());  // string, not unknown
    }
}
```

`value is string` tells TypeScript: if this returns true, the value is a string.

### Discriminated Unions: The Most Useful Pattern

```typescript
type Success<T> = { type: 'success'; data: T };
type Failure = { type: 'error'; message: string; code: number };
type Result<T> = Success<T> | Failure;

function handleResult<T>(result: Result<T>) {
    if (result.type === 'success') {
        console.log(result.data);     // T
    } else {
        console.error(result.code);   // number
    }
}
```

The shared `type` discriminator lets TypeScript narrow automatically. Use this instead of optional fields that create invalid states (`{ data?: T; error?: string }` allows both or neither).

## Branded Types: Prevent ID Confusion

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };

type UserId = Brand<string, 'UserId'>;
type OrderId = Brand<string, 'OrderId'>;

function getUser(id: UserId) { /* ... */ }
function getOrder(id: OrderId) { /* ... */ }

const userId = 'user-123' as UserId;
const orderId = 'order-456' as OrderId;

getUser(userId);   // OK
getUser(orderId);  // Compile error — OrderId is not UserId
```

Both are strings at runtime. At compile time, they're incompatible. Prevents passing `orderId` where `userId` is expected—bugs that are painfully common in stringly-typed APIs.

## Practical Patterns I Use Weekly

### Type-Safe API Client

```typescript
type Endpoint = '/users' | '/users/:id' | '/orders';

type Params<E extends Endpoint> = 
    E extends `/${infer Resource}/:id` ? { id: string } :
    E extends '/users' ? { page?: number } :
    Record<string, never>;

type Response<E extends Endpoint> =
    E extends '/users' | '/users/:id' ? User[] | User :
    E extends '/orders' ? Order[] :
    never;

async function api<E extends Endpoint>(
    endpoint: E,
    params?: Params<E>
): Promise<Response<E>> {
    // implementation
}
```

### Builder Pattern with Required Fields

```typescript
type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

class QueryBuilder<T> {
    private filters: Partial<T> = {};
    
    where<K extends keyof T>(key: K, value: T[K]): this {
        this.filters[key] = value;
        return this;
    }
    
    build(): Partial<T> {
        return this.filters;
    }
}
```

## When to Stop

Advanced types are powerful. They can also make code unreadable. Rules I follow:

1. **If a junior can't read it, simplify** — or document heavily
2. **Prefer inference** — let TypeScript figure it out when possible
3. **Don't recreate the standard library** — use built-in utility types
4. **Test your types** — [tsd](https://github.com/SamVerschueren/tsd) or `// @ts-expect-error` comments
5. **Runtime validation still needed** — types disappear at runtime; validate external data with Zod/io-ts

## Conclusion

Advanced TypeScript types aren't academic exercises. They're compile-time tests that make illegal states unrepresentable. The `getUserById` bug that returned the wrong shape? A conditional return type based on input parameters would have caught it before deploy.

Start with discriminated unions and type guards—they solve 80% of real problems. Add mapped types and utility types for API transformations. Reach for conditional types and template literals when building libraries or frameworks.

TypeScript's type system is Turing-complete. You don't need to use all of it. Use enough that `any` becomes rare, autocomplete becomes reliable, and refactoring doesn't require grep and prayer.

The best TypeScript code reads like JavaScript but fails at compile time when you make mistakes. Advanced types are how you get there.

---

*TypeScript advanced types from May 2021, covering conditional types, mapped types, and utility types.*

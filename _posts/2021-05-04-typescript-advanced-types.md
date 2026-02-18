---
layout: post
title: "TypeScript Advanced Types: A Deep Dive"
date: 2021-05-04
categories: [Deep Dive]
tags: [TypeScript, Types, JavaScript]
excerpt: "Master TypeScript advanced types: conditional types, mapped types, template literal types, utility types, and type-level programming patterns."
---

TypeScript's type system is powerful. After using advanced types in production, here's how to leverage them effectively.

## Conditional Types

### Basic Conditional Types

```typescript
type IsString<T> = T extends string ? true : false;

type A = IsString<string>; // true
type B = IsString<number>; // false
```

### Extract and Exclude

```typescript
type Extract<T, U> = T extends U ? T : never;
type Exclude<T, U> = T extends U ? never : T;

type T1 = Extract<'a' | 'b' | 'c', 'a' | 'b'>; // 'a' | 'b'
type T2 = Exclude<'a' | 'b' | 'c', 'a' | 'b'>; // 'c'
```

### Function Return Type

```typescript
type ReturnType<T> = T extends (...args: any[]) => infer R ? R : never;

function getString(): string {
    return 'hello';
}

type R = ReturnType<typeof getString>; // string
```

## Mapped Types

### Basic Mapped Type

```typescript
type Readonly<T> = {
    readonly [P in keyof T]: T[P];
};

type Partial<T> = {
    [P in keyof T]?: T[P];
};

type Required<T> = {
    [P in keyof T]-?: T[P];
};
```

### Key Remapping

```typescript
type Getters<T> = {
    [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

type User = {
    name: string;
    age: number;
};

type UserGetters = Getters<User>;
// {
//     getName: () => string;
//     getAge: () => number;
// }
```

## Template Literal Types

### String Manipulation

```typescript
type EventName<T extends string> = `on${Capitalize<T>}`;

type ClickEvent = EventName<'click'>; // 'onClick'
type SubmitEvent = EventName<'submit'>; // 'onSubmit'
```

### Path Types

```typescript
type Path<T> = T extends object
    ? {
        [K in keyof T]: K extends string
            ? K | `${K}.${Path<T[K]>}`
            : never;
    }[keyof T]
    : never;

type User = {
    name: string;
    address: {
        street: string;
        city: string;
    };
};

type UserPath = Path<User>;
// 'name' | 'address' | 'address.street' | 'address.city'
```

## Utility Types

### Pick and Omit

```typescript
type Pick<T, K extends keyof T> = {
    [P in K]: T[P];
};

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

type User = {
    id: string;
    name: string;
    email: string;
    password: string;
};

type PublicUser = Omit<User, 'password'>;
// { id: string; name: string; email: string; }
```

### Record

```typescript
type Record<K extends keyof any, T> = {
    [P in K]: T;
};

type UserRoles = Record<string, boolean>;
// { [key: string]: boolean; }
```

## Type Guards

### Custom Type Guards

```typescript
function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function process(value: unknown) {
    if (isString(value)) {
        // value is string here
        console.log(value.toUpperCase());
    }
}
```

### Discriminated Unions

```typescript
type Success<T> = {
    type: 'success';
    data: T;
};

type Error = {
    type: 'error';
    message: string;
};

type Result<T> = Success<T> | Error;

function handleResult<T>(result: Result<T>) {
    if (result.type === 'success') {
        // result is Success<T>
        console.log(result.data);
    } else {
        // result is Error
        console.error(result.message);
    }
}
```

## Branded Types

### Type Branding

```typescript
type Brand<T, B> = T & { __brand: B };

type UserId = Brand<string, 'UserId'>;
type ProductId = Brand<string, 'ProductId'>;

function createUserId(id: string): UserId {
    return id as UserId;
}

function getUser(id: UserId) {
    // Implementation
}

const userId = createUserId('123');
getUser(userId); // OK
getUser('123'); // Error: Type 'string' is not assignable to type 'UserId'
```

## Best Practices

1. **Use utility types** - Built-in helpers
2. **Create reusable types** - DRY principle
3. **Type guards** - Narrow types safely
4. **Document complex types** - Clear comments
5. **Test types** - Type-level tests
6. **Avoid over-engineering** - Keep it simple
7. **Use generics** - Reusable types
8. **Leverage inference** - Let TypeScript infer

## Conclusion

Advanced TypeScript types enable:
- Type safety
- Better DX
- Self-documenting code
- Compile-time checks

Start with utility types, then explore conditional and mapped types. The patterns shown here work for production code.

---

*TypeScript advanced types from May 2021, covering conditional types, mapped types, and utility types.*

---
layout: post
title: "TypeScript in Production: Lessons Learned"
date: 2017-09-07
categories: [Lessons Learned]
tags: [TypeScript, JavaScript, Production, Best Practices]
excerpt: "Real-world lessons from using TypeScript in production, covering type safety, build configurations, migration strategies, and common pitfalls to avoid."
---

TypeScript transformed how we write JavaScript. After migrating a large codebase to TypeScript and using it in production for over a year, here are the lessons that matter.

## Why TypeScript?

Benefits we experienced:
- **Fewer bugs**: Catch errors at compile time
- **Better IDE support**: Autocomplete, refactoring
- **Self-documenting**: Types serve as documentation
- **Easier refactoring**: Confidence when changing code

## Migration Strategy

### Gradual Migration

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

Migrate file by file:

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

### Using JSDoc for Gradual Typing

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

## Type Definitions

### Avoid `any`

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

### Use Union Types

```typescript
// Instead of any
type Status = 'pending' | 'approved' | 'rejected';

function updateStatus(status: Status) {
    // Type-safe status handling
}

// Compile error if invalid
updateStatus('invalid'); // Error!
```

### Generic Types

```typescript
// Reusable generic function
function getById<T>(id: string): Promise<T> {
    return db.findById(id);
}

// Usage with type inference
const user = await getById<User>('123');
const order = await getById<Order>('456');
```

## Common Patterns

### API Response Types

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

### Event Handlers

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

### Database Models

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

## Configuration

### Strict Mode

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

### Path Aliases

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

## Testing with TypeScript

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

## Common Pitfalls

### Over-Engineering Types

```typescript
// BAD: Over-complicated
type ComplexType<T extends string, U extends number> = 
    T extends 'a' ? U extends 1 ? 'type1' : 'type2' : 'never';

// GOOD: Simple and clear
type Status = 'active' | 'inactive';
type UserRole = 'admin' | 'user';
```

### Ignoring Type Errors

```typescript
// BAD: Suppressing errors
// @ts-ignore
const result = someFunction();

// BAD: Using any
const result: any = someFunction();

// GOOD: Fix the types
const result = someFunction() as ExpectedType;
```

### Not Using Utility Types

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

## Build Configuration

### Production Build

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

### Development Build

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

## Best Practices

1. **Enable strict mode** - Catch more errors
2. **Avoid `any`** - Use `unknown` if type is truly unknown
3. **Use interfaces for objects** - More extensible
4. **Use types for unions** - Better for complex types
5. **Leverage utility types** - `Partial`, `Pick`, `Omit`
6. **Document complex types** - Add comments
7. **Use const assertions** - For literal types
8. **Type external libraries** - Use `@types/` packages

## Migration Checklist

- [ ] Enable `allowJs` for gradual migration
- [ ] Add `tsconfig.json` with strict settings
- [ ] Install type definitions for dependencies
- [ ] Migrate new files to TypeScript
- [ ] Gradually migrate existing files
- [ ] Remove `any` types
- [ ] Enable strict mode
- [ ] Set up CI type checking

## Conclusion

TypeScript in production:
- Reduces bugs significantly
- Improves developer experience
- Makes refactoring safer
- Serves as documentation

Start with gradual migration, enable strict mode, and avoid `any`. The investment pays off quickly in fewer bugs and better code quality.

---

*TypeScript production lessons from September 2017, covering TypeScript 2.x patterns.*

---
layout: post
title: "Building a GraphQL API with Node.js and TypeScript"
date: 2018-11-19
categories: [How-To]
tags: [GraphQL, Node.js, TypeScript]
excerpt: "REST gave us twelve endpoints to fetch one user profile. GraphQL gave clients one query — and gave us N+1 queries until we learned TypeScript, codegen, and DataLoader."
---

The pitch for GraphQL is irresistible: clients ask for exactly what they need, one request, no over-fetching. The reality on day one is a resolver that calls the database once per field and a production outage that teaches you the phrase "N+1 query problem" very personally.

We adopted GraphQL in 2018 for a product API where mobile and web clients needed different shapes of the same data. REST meant either bloated responses or custom endpoints per client. GraphQL meant one schema — but only if we built it with type safety, code generation, and batching from the start.

Here's the stack that worked: **Node.js, TypeScript, Apollo Server 2.x, and GraphQL Code Generator**. Not because it's the only way — because it's the way that catches mistakes at compile time instead of at 2 AM.

## Project Setup: Dependencies Worth Installing Once

```bash
npm install apollo-server-express express graphql
npm install -D typescript @types/node @types/express ts-node nodemon
npm install -D @graphql-codegen/cli @graphql-codegen/typescript \
  @graphql-codegen/typescript-resolvers
```

TypeScript config — strict mode on, because loose types defeat the entire purpose:

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Schema-First: The Contract Comes Before the Code

We define the API in GraphQL SDL — a `.graphql` file that product, frontend, and backend can argue about before anyone writes a resolver:

```graphql
# src/schema/schema.graphql
type Query {
  users: [User!]!
  user(id: ID!): User
  posts: [Post!]!
  post(id: ID!): Post
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): Boolean!
}

type User {
  id: ID!
  name: String!
  email: String!
  posts: [Post!]!
  createdAt: String!
  updatedAt: String!
}

type Post {
  id: ID!
  title: String!
  content: String!
  author: User!
  createdAt: String!
}

input CreateUserInput {
  name: String!
  email: String!
}

input UpdateUserInput {
  name: String
  email: String
}
```

Schema-first means the GraphQL file is the source of truth. Resolvers implement the contract; they don't invent it ad hoc.

## Code Generation: Let the Machine Write the Boring Types

Hand-writing TypeScript interfaces that mirror your GraphQL schema is a duplication machine. GraphQL Code Generator reads your schema and produces resolver types that enforce correctness:

```yaml
# codegen.yml
schema: src/schema/schema.graphql
generates:
  src/generated/types.ts:
    plugins:
      - typescript
      - typescript-resolvers
    config:
      useIndexSignature: true
      contextType: ../context#Context
```

Run it whenever the schema changes:

```bash
npm run codegen
# Generates src/generated/types.ts
```

Now when you typo a field name in a resolver, TypeScript yells at you in the IDE — not your users in production.

## Type-Safe Resolvers: Thin Wrappers, Fat Services

Resolvers should orchestrate, not implement business logic. Keep them thin; put the real work in services:

```typescript
// src/resolvers/user.ts
import { Resolvers } from '../generated/types';
import { Context } from '../context';
import { UserService } from '../services/userService';

export const userResolvers: Resolvers<Context> = {
    Query: {
        users: async (parent, args, context) => {
            return await context.userService.getAllUsers();
        },
        user: async (parent, args, context) => {
            return await context.userService.getUserById(args.id);
        }
    },
    Mutation: {
        createUser: async (parent, args, context) => {
            return await context.userService.createUser(args.input);
        },
        updateUser: async (parent, args, context) => {
            return await context.userService.updateUser(args.id, args.input);
        },
        deleteUser: async (parent, args, context) => {
            await context.userService.deleteUser(args.id);
            return true;
        }
    },
    User: {
        posts: async (parent, args, context) => {
            return await context.postService.getPostsByUserId(parent.id);
        }
    }
};
```

The `Resolvers<Context>` type ensures every field handler matches the schema. Missing a required resolver? Compile error. Wrong return type? Compile error. This is the payoff for the codegen setup.

## Context: Dependency Injection Without the Framework Drama

Apollo's `context` function is your per-request dependency injection container:

```typescript
// src/context.ts
import { UserService } from './services/userService';
import { PostService } from './services/postService';

export interface Context {
    userService: UserService;
    postService: PostService;
    userId?: string;
}

export function createContext(): Context {
    return {
        userService: new UserService(),
        postService: new PostService()
    };
}
```

Pass services through context, not imports in resolvers. Testing becomes "swap the context," not "mock seventeen modules."

## Service Layer: Where the Database Actually Gets Touched

```typescript
// src/services/userService.ts
import { User, CreateUserInput, UpdateUserInput } from '../generated/types';
import { db } from '../db';

export class UserService {
    async getAllUsers(): Promise<User[]> {
        return await db.users.findMany();
    }
    
    async getUserById(id: string): Promise<User | null> {
        return await db.users.findUnique({ where: { id } });
    }
    
    async createUser(input: CreateUserInput): Promise<User> {
        return await db.users.create({
            data: {
                name: input.name,
                email: input.email
            }
        });
    }
    
    async updateUser(id: string, input: UpdateUserInput): Promise<User> {
        return await db.users.update({
            where: { id },
            data: {
                ...(input.name && { name: input.name }),
                ...(input.email && { email: input.email })
            }
        });
    }
    
    async deleteUser(id: string): Promise<void> {
        await db.users.delete({ where: { id } });
    }
}
```

Generated types flow from schema → service → resolver. Change the schema, run codegen, fix what TypeScript flags. It's a tight loop.

## Apollo Server: Wire It Together

```typescript
// src/server.ts
import express from 'express';
import { ApolloServer } from 'apollo-server-express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolvers } from './resolvers';
import { createContext } from './context';

const typeDefs = readFileSync(
    join(__dirname, 'schema/schema.graphql'),
    'utf-8'
);

const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: ({ req }) => {
        const context = createContext();
        
        // Extract user from token
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token) {
            context.userId = verifyToken(token);
        }
        
        return context;
    },
    formatError: (error) => {
        console.error(error);
        return {
            message: error.message,
            code: error.extensions?.code
        };
    }
});

const app = express();

async function start() {
    await server.start();
    server.applyMiddleware({ app, path: '/graphql' });
    
    app.listen(4000, () => {
        console.log(`Server ready at http://localhost:4000${server.graphqlPath}`);
    });
}

start();
```

`formatError` is your last line of defense against leaking stack traces to clients. Log the full error server-side; return a sanitized message client-side.

## Resolver Composition: Keep the Index File Boring

```typescript
// src/resolvers/index.ts
import { Resolvers } from '../generated/types';
import { userResolvers } from './user';
import { postResolvers } from './post';

export const resolvers: Resolvers = {
    Query: {
        ...userResolvers.Query,
        ...postResolvers.Query
    },
    Mutation: {
        ...userResolvers.Mutation,
        ...postResolvers.Mutation
    },
    User: userResolvers.User,
    Post: postResolvers.Post
};
```

Split resolvers by domain (`user.ts`, `post.ts`). The index file merges them. When the schema grows, you add files — not thousand-line resolver god objects.

## DataLoader: The N+1 Vaccine

Here's the scenario that burns newcomers: a query fetches 10 posts, each with an author. Naive resolvers call `getUserById` ten times — one per post. DataLoader batches those into one query:

```typescript
// src/loaders/userLoader.ts
import DataLoader from 'dataloader';
import { User } from '../generated/types';
import { db } from '../db';

export function createUserLoader() {
    return new DataLoader<string, User>(async (userIds) => {
        const users = await db.users.findMany({
            where: { id: { in: userIds } }
        });
        
        const userMap = new Map(users.map(user => [user.id, user]));
        return userIds.map(id => userMap.get(id) || null);
    });
}

// Add to context
export interface Context {
    userService: UserService;
    postService: PostService;
    userLoader: ReturnType<typeof createUserLoader>;
    userId?: string;
}

// Use in resolver
User: {
    posts: async (parent, args, context) => {
        // DataLoader batches requests
        return await context.postLoader.loadMany(parent.postIds);
    }
}
```

**Critical detail:** Create a new DataLoader instance **per request** in your context function. Sharing loaders across requests breaks batching and causes cache leaks between users.

We add DataLoader on day one now. Retrofitting it after launch means profiling, refactoring, and explaining to leadership why "the fast API" got slow.

## Testing: Execute Operations, Not Implementation Details

```typescript
// src/__tests__/user.test.ts
import { ApolloServer } from 'apollo-server';
import { typeDefs } from '../schema';
import { resolvers } from '../resolvers';

const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: createMockContext()
});

describe('User queries', () => {
    it('should fetch all users', async () => {
        const query = `
            query {
                users {
                    id
                    name
                    email
                }
            }
        `;
        
        const result = await server.executeOperation({ query });
        
        expect(result.errors).toBeUndefined();
        expect(result.data?.users).toBeDefined();
    });
});
```

Test GraphQL operations the way clients call them. Mock the context services, not internal resolver functions — your tests should survive refactors.

## Error Handling: Typed Errors, Clear Messages

```typescript
// src/errors.ts
export class UserNotFoundError extends Error {
    constructor(id: string) {
        super(`User with id ${id} not found`);
        this.name = 'UserNotFoundError';
    }
}

// In resolver
user: async (parent, args, context) => {
    const user = await context.userService.getUserById(args.id);
    if (!user) {
        throw new UserNotFoundError(args.id);
    }
    return user;
}
```

Map domain errors to GraphQL error extensions (`NOT_FOUND`, `VALIDATION_ERROR`) in `formatError` so clients can handle them programmatically.

## Validation: Before the Service, Not After the Damage

```typescript
// src/validators/userValidator.ts
import { CreateUserInput } from '../generated/types';

export function validateCreateUserInput(input: CreateUserInput): void {
    if (!input.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        throw new Error('Invalid email format');
    }
    
    if (input.name.length < 2) {
        throw new Error('Name must be at least 2 characters');
    }
}

// In resolver
createUser: async (parent, args, context) => {
    validateCreateUserInput(args.input);
    return await context.userService.createUser(args.input);
}
```

GraphQL validates types; your validators validate business rules. "String!" means non-null — it doesn't mean "valid email address."

## What We'd Tell Past Us

Use codegen from commit one — hand-written resolver types drift from the schema silently. Keep resolvers thin and services thick. DataLoader isn't optional for relational data. Validate inputs before they hit the database. Test with `executeOperation`, not by calling resolver functions directly. And monitor resolver-level timing — GraphQL's flexibility makes it easy to ship accidentally expensive queries.

## The Bottom Line

TypeScript plus GraphQL plus codegen gives you a schema that's enforced at compile time, not discovered in production. Apollo Server handles the protocol; your job is clean resolvers, batched data loading, and services that do the actual work.

GraphQL isn't magic — it's a contract. TypeScript makes sure you keep it.

---

*Written November 2018, covering Apollo Server 2.0+ and GraphQL Code Generator. Apollo Server 3/4 and the GraphQL ecosystem have evolved — check current docs for server setup and plugin APIs.*

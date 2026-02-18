---
layout: post
title: "Building a GraphQL API with Node.js and TypeScript"
date: 2018-11-19
categories: [How-To]
tags: [GraphQL, Node.js, TypeScript]
excerpt: "Build a production-ready GraphQL API using Node.js, TypeScript, Apollo Server, and code generation. Learn type-safe resolvers, schema design, and best practices."
---

TypeScript brings type safety to GraphQL APIs. After building production GraphQL APIs with TypeScript, here's how to set it up effectively.

## Project Setup

### Dependencies

```bash
npm install apollo-server-express express graphql
npm install -D typescript @types/node @types/express ts-node nodemon
npm install -D @graphql-codegen/cli @graphql-codegen/typescript \
  @graphql-codegen/typescript-resolvers
```

### TypeScript Configuration

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

## Schema Definition

### Schema-First Approach

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

## Code Generation

### Codegen Configuration

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

### Generate Types

```bash
npm run codegen
# Generates src/generated/types.ts
```

## Type-Safe Resolvers

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

## Context Type

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

## Service Layer

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

## Apollo Server Setup

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

## Resolvers Index

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

## DataLoader for N+1

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

## Testing

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

## Error Handling

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

## Validation

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

## Best Practices

1. **Use code generation** - Type-safe resolvers
2. **Separate concerns** - Services, resolvers, loaders
3. **Use DataLoader** - Prevent N+1 queries
4. **Validate inputs** - Before processing
5. **Handle errors** - Proper error types
6. **Test resolvers** - Unit and integration tests
7. **Use context** - Dependency injection
8. **Monitor performance** - Track resolver performance

## Conclusion

TypeScript + GraphQL enables:
- Type-safe resolvers
- Better developer experience
- Catch errors at compile time
- Auto-completion in IDEs

Start with schema-first, generate types, and build type-safe resolvers. The patterns shown here work for production APIs.

---

*GraphQL API with Node.js and TypeScript from November 2018, covering Apollo Server 2.0+ and code generation.*

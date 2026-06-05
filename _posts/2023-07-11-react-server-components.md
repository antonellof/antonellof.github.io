---
layout: post
title: "React Server Components: A New Paradigm"
date: 2023-07-11
categories: [How-To]
tags: [React, Server Components, Next.js]
excerpt: "I deleted 40KB of JavaScript from our bundle by moving data fetching to the server. React Server Components aren't hype — they're the best answer to 'why is my React app so heavy?'"
---

Our Next.js app's JavaScript bundle was 340KB gzipped. For a dashboard that mostly displayed database records in tables. Users on corporate laptops with aggressive antivirus software waited four seconds before they could click anything. The data itself arrived in 200ms from the API — the other 3.8 seconds were React hydrating a forest of `useEffect` hooks that fetched data the server already had access to.

I'd been skeptical of React Server Components since the announcement. Another paradigm shift? Another "this changes everything" blog post? I had a production app with real users and no patience for science projects.

Then I moved one page — a user list — to a Server Component. Bundle size for that route dropped by 40KB. Time to interactive improved by 1.2 seconds. The code got *simpler*, not more complex. I was annoyed it worked that well.

## The Mental Model Shift

For years, React's contract was: JavaScript runs in the browser, components render UI, data fetching happens client-side (or you bolt on SSR as a separate concern). Server Components break that contract deliberately.

**Server Components:**
- Run on the server only — zero JavaScript sent to the browser
- Can directly access databases, file systems, internal APIs
- Cannot use state, effects, or browser APIs
- Render to a serializable format streamed to the client

**Client Components:**
- Run in the browser — the React you already know
- Handle interactivity: clicks, forms, animations, browser APIs
- Marked explicitly with `'use client'`

The insight that clicked for me: most of your React tree doesn't need interactivity. A user table doesn't need `useState`. A product listing doesn't need `useEffect`. A blog post doesn't need hydration. These are display components that fetch data and render HTML. Server Components let them stay on the server.

Read the [React Server Components RFC](https://github.com/reactjs/rfcs/blob/main/text/0188-server-components.md) for the full specification.

## Server Components in Practice

### The Default Is Server

In Next.js App Router, every component is a Server Component unless you opt out:

```typescript
// app/users/page.tsx — Server Component by default
async function UsersPage() {
    const users = await db.users.findMany();

    return (
        <div>
            <h1>Users</h1>
            {users.map(user => (
                <UserCard key={user.id} user={user} />
            ))}
        </div>
    );
}
```

No `getServerSideProps`. No API route intermediary. No `useEffect` + `fetch` + loading state + error state. The component is an `async` function that queries the database and returns JSX. This is what backend developers always wished frontend looked like.

**What I removed from the client-bundle version of this page:**

- `useState` for users, loading, and error states
- `useEffect` for data fetching on mount
- The `/api/users` route handler (still useful for mutations, not needed for reads)
- Three npm packages for data fetching utilities
- 40KB of JavaScript

### Client Components: Only Where Needed

Interactivity still lives in the browser:

```typescript
'use client';

import { useState } from 'react';

export function Counter() {
    const [count, setCount] = useState(0);

    return (
        <button onClick={() => setCount(count + 1)}>
            Count: {count}
        </button>
    );
}
```

The `'use client'` directive marks the boundary. Everything imported by a Client Component is also bundled for the browser. Keep Client Components small and leaf-level — a button, a form, a modal — not entire page layouts.

**My rule of thumb:** if it doesn't respond to user input, it's a Server Component.

### Composition: Server Wrapping Client

This pattern took me a day to internalize:

```typescript
// app/users/page.tsx — Server Component
import { UserTable } from './UserTable';       // Server Component
import { UserSearch } from './UserSearch';     // Client Component ('use client')
import { db } from '@/lib/db';

export default async function UsersPage() {
    const users = await db.users.findMany();

    return (
        <div>
            <h1>Users</h1>
            <UserSearch initialUsers={users} />
            <UserTable users={users} />
        </div>
    );
}
```

```typescript
// UserSearch.tsx — Client Component
'use client';

import { useState } from 'react';

export function UserSearch({ initialUsers }) {
    const [query, setQuery] = useState('');
    const filtered = initialUsers.filter(u =>
        u.name.toLowerCase().includes(query.toLowerCase())
    );

    return (
        <div>
            <input value={query} onChange={e => setQuery(e.target.value)} />
            {/* render filtered users */}
        </div>
    );
}
```

Server Component fetches data, passes it as props to Client Component. The data is serialized in the RSC payload — no extra network request. Client Component handles the interactive filtering.

**The constraint:** props passed from Server to Client Components must be serializable. No functions, no class instances, no `Date` objects (use strings). This feels restrictive until you realize most props are plain data anyway.

## Data Fetching: The Part That Actually Changed

Before RSC, our data fetching looked like this:

```
Browser → API Route → Database → API Route → Browser → React renders
```

With RSC:

```
Server Component → Database → Server Component renders → Stream to browser
```

One hop instead of three. No JSON serialization in the middle. No loading spinners for initial data. No waterfall of `useEffect` calls where the parent fetches users, then the child fetches permissions, then the grandchild fetches preferences.

### Parallel Data Fetching

```typescript
export default async function DashboardPage() {
    // These run in parallel, not sequentially
    const [users, orders, metrics] = await Promise.all([
        db.users.count(),
        db.orders.findRecent(10),
        analytics.getMetrics(),
    ]);

    return (
        <div>
            <MetricCards metrics={metrics} />
            <RecentOrders orders={orders} />
            <UserCount count={users} />
        </div>
    );
}
```

In the `useEffect` world, this parallelization required careful orchestration or a data-fetching library like React Query. In RSC, it's just `Promise.all` in an async function. Boring. Correct. Fast.

### Streaming and Suspense

For slow data sources, RSC supports streaming with Suspense:

```typescript
import { Suspense } from 'react';

export default function Page() {
    return (
        <div>
            <h1>Dashboard</h1>
            <FastMetrics />  {/* renders immediately */}
            <Suspense fallback={<Skeleton />}>
                <SlowReport />  {/* streams when ready */}
            </Suspense>
        </div>
    );
}

async function SlowReport() {
    const report = await generateExpensiveReport(); // takes 3 seconds
    return <ReportTable data={report} />;
}
```

The page shell renders immediately. The slow report streams in when ready. Users see content progressively instead of staring at a blank page.

See [Next.js streaming documentation](https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming) for patterns.

## What I Got Wrong Initially

### Mistake: Making Everything a Client Component

Our first App Router migration copied pages verbatim and added `'use client'` to everything because "it was easier." We got SSR without any RSC benefits. Bundle size barely changed.

**Fix:** Start with Server Components as default. Add `'use client'` only when you hit a hook or browser API.

### Mistake: Fetching in Client Components When Server Would Work

```typescript
// Bad: client-side fetch for data the server already has
'use client';
export function UserList() {
    const [users, setUsers] = useState([]);
    useEffect(() => {
        fetch('/api/users').then(r => r.json()).then(setUsers);
    }, []);
    // ...
}
```

```typescript
// Good: server fetch, pass data down
export default async function Page() {
    const users = await db.users.findMany();
    return <UserList users={users} />;
}
```

### Mistake: Putting Database Imports in Client Components

```typescript
'use client';
import { db } from '@/lib/db'; // This will break — db doesn't run in browser
```

The compiler catches this, but the error message confused two junior developers on our team. Document the server/client boundary clearly in your codebase.

## Performance Numbers (Our App)

| Metric | Pages Router (client fetch) | App Router (RSC) |
|--------|---------------------------|------------------|
| JS bundle (dashboard) | 340KB | 180KB |
| Time to interactive | 4.1s | 2.3s |
| First contentful paint | 1.8s | 0.9s |
| API round-trips on load | 4 | 0 |
| Lines of data-fetching code | ~120/page | ~5/page |

Your numbers will differ. The direction — smaller bundles, faster paint, less code — is consistent across teams I've talked to.

## When RSC Isn't the Answer

- **Highly interactive apps** (Figma-like tools, real-time collaborative editors) — most components need client state
- **Offline-first applications** — Server Components require a server, obviously
- **Pages Router apps that work fine** — migration cost may exceed benefit
- **Teams unfamiliar with the server/client boundary** — the paradigm shift has a learning curve

RSC shines brightest in data-heavy applications: dashboards, admin panels, e-commerce listings, content sites. Places where you display a lot and interact a little.

## Migration Strategy (If You're on Pages Router)

We migrated incrementally over six weeks:

1. **New pages in App Router** — new features used `app/` directory
2. **One high-traffic page** — migrated dashboard first for maximum impact
3. **Shared components audited** — tagged each as server-safe or client-required
4. **API routes kept for mutations** — POST/PUT/DELETE still go through API routes or Server Actions
5. **Old pages migrated on touch** — when modifying a Pages Router page, consider moving it

We didn't big-bang migrate. Both routers coexisted for two months. Next.js supports this officially.

## Server Actions: The Companion Feature

Server Actions (stable in Next.js 14, experimental in 2023) let Client Components call server functions:

```typescript
// actions.ts
'use server';

export async function createUser(formData: FormData) {
    const name = formData.get('name') as string;
    await db.users.create({ data: { name } });
    revalidatePath('/users');
}
```

```typescript
// UserForm.tsx — Client Component
'use client';

import { createUser } from './actions';

export function UserForm() {
    return (
        <form action={createUser}>
            <input name="name" />
            <button type="submit">Create</button>
        </form>
    );
}
```

No API route. No `fetch`. Form submission calls the server directly. Combined with RSC for reads, you can build full CRUD without writing API endpoints.

## Practical Takeaways

React Server Components aren't a replacement for React — they're a correction. Most React apps sent too much JavaScript to the browser to do work the server could do faster and simpler.

**Adopt RSC when:**

- Your bundle is bloated with data-fetching code
- Pages are mostly display with islands of interactivity
- You're starting a new Next.js project (App Router is the default)
- Time to interactive matters for your users

**Start here:**

1. New pages as Server Components by default
2. `'use client'` only for interactive leaf components
3. Fetch data in Server Components, pass as props
4. Use Suspense for slow data sources
5. Measure bundle size before and after — the numbers sell the migration

The user table that started my RSC journey still runs as a Server Component today. No `useEffect`. No loading spinner. No API route. Just an async function that queries the database and returns HTML. Sometimes the best frontend architecture is admitting the frontend doesn't need to do everything.

---

*React Server Components — July 2023. See the [Next.js App Router docs](https://nextjs.org/docs/app) and [React documentation](https://react.dev/reference/rsc/server-components) for current APIs.*

---
layout: post
title: "React Hooks: A Complete Guide"
date: 2019-07-23
categories: [How-To]
tags: [React, Hooks, JavaScript]
excerpt: "React Hooks killed the class component — and my weekend. Here's the practical guide I wish I'd had when useEffect betrayed me at 2am."
render_with_liquid: false
---

I remember the exact moment hooks broke my brain.

I'd spent three years writing React class components. `componentDidMount`, `componentWillUnmount`, the whole lifecycle dance. Then React 16.8 dropped and suddenly everyone was writing `useState` in a functional component and acting like it was obvious. It was not obvious. My first `useEffect` ran eleven times, spawned a memory leak, and somehow still didn't fetch the user data.

Six months and two production apps later, hooks clicked. Not because the API is complicated — it's actually elegant — but because you have to unlearn some habits that classes trained into you. This is the guide I wanted during that unlearning phase: practical, opinionated, and free of the "just read the docs" energy that haunted the React community in 2019.

## What Hooks Actually Are (And Why They Exist)

Before hooks, sharing stateful logic between components meant higher-order components, render props, or copy-pasting the same `componentDidMount` boilerplate until you questioned your career choices. Class components worked, but they made simple things feel ceremonious.

Hooks let functional components do everything classes could — state, lifecycle, context, refs — without the `this` binding gymnastics or the mental overhead of "which lifecycle method does this belong in?"

The rules sound strict but exist for good reason:

- Call hooks only at the top level of your component (no loops, no conditions)
- Call hooks only from React function components or custom hooks
- Name custom hooks starting with `use` so everyone knows the rules apply

Break these rules and React can't guarantee hook order between renders. Things get weird fast.

## useState: State Without the Ceremony

`useState` is the gateway drug. One line, and your functional component has memory.

### The Basics

```javascript
import React, { useState } from 'react';

function Counter() {
    const [count, setCount] = useState(0);
    
    return (
        <div>
            <p>Count: {count}</p>
            <button onClick={() => setCount(count + 1)}>
                Increment
            </button>
        </div>
    );
}
```

Simple. Readable. No constructor, no `this.state`, no `this.setState` callback hell.

### Multiple State Variables (Please Do This)

A common beginner mistake: cramming unrelated state into one object because classes made you think in terms of a single `this.state` blob. Separate concerns into separate hooks:

```javascript
function Form() {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [age, setAge] = useState(0);
    
    return (
        <form>
            <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
            />
            <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
            />
            <input
                type="number"
                value={age}
                onChange={(e) => setAge(parseInt(e.target.value))}
                placeholder="Age"
            />
        </form>
    );
}
```

When one field updates, React only re-renders what depends on it. Your future self debugging a form at midnight will thank you.

### Functional Updates: The Pattern You'll Need Eventually

If you update state based on the previous value — especially in rapid clicks or async callbacks — don't trust the closure:

```javascript
function Counter() {
    const [count, setCount] = useState(0);
    
    const increment = () => {
        setCount(prevCount => prevCount + 1);
    };
    
    const decrement = () => {
        setCount(prevCount => prevCount - 1);
    };
    
    return (
        <div>
            <button onClick={decrement}>-</button>
            <span>{count}</span>
            <button onClick={increment}>+</button>
        </div>
    );
}
```

The functional form (`prev => prev + 1`) always gets the latest value. The direct form (`count + 1`) gets whatever `count` was when that function was created. In a counter it's annoying. In a payment flow it's expensive.

## useEffect: Side Effects and the Dependency Array Trap

`useEffect` is where hooks earn their reputation. It replaces `componentDidMount`, `componentDidUpdate`, and `componentWillUnmount` with one API — which sounds great until you forget the dependency array and wonder why your API is getting hammered.

Think of `useEffect` as: "after React paints the screen, do this thing."

### Fetching Data (The Classic Use Case)

```javascript
import React, { useState, useEffect } from 'react';

function UserProfile({ userId }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    
    useEffect(() => {
        async function fetchUser() {
            const response = await fetch(`/api/users/${userId}`);
            const data = await response.json();
            setUser(data);
            setLoading(false);
        }
        
        fetchUser();
    }, [userId]); // Run when userId changes
    
    if (loading) return <div>Loading...</div>;
    return <div>{user?.name}</div>;
}
```

That `[userId]` dependency array is not optional decoration. Without it, you fetch once on mount and never again — even when the user navigates to a different profile. With it wrong, you fetch on every render and DDOS your own API. Ask me how I know.

### Cleanup: Don't Leak Timers (Or Dignity)

Effects that subscribe to something must unsubscribe. The return function is your cleanup:

```javascript
function Timer() {
    const [seconds, setSeconds] = useState(0);
    
    useEffect(() => {
        const interval = setInterval(() => {
            setSeconds(prev => prev + 1);
        }, 1000);
        
        return () => clearInterval(interval);
    }, []); // Run once on mount
    
    return <div>Seconds: {seconds}</div>;
}
```

Empty dependency array `[]` means "run once on mount, clean up on unmount." Perfect for subscriptions, timers, and event listeners. Skip cleanup and your unmounted component keeps ticking in the background like a ghost in the machine.

### Multiple Effects: Separate Concerns

Don't stuff unrelated side effects into one `useEffect` just because you can. Split them:

```javascript
function UserProfile({ userId }) {
    const [user, setUser] = useState(null);
    const [posts, setPosts] = useState([]);
    
    useEffect(() => {
        fetch(`/api/users/${userId}`)
            .then(res => res.json())
            .then(setUser);
    }, [userId]);
    
    useEffect(() => {
        fetch(`/api/users/${userId}/posts`)
            .then(res => res.json())
            .then(setPosts);
    }, [userId]);
    
    return (
        <div>
            <h1>{user?.name}</h1>
            <ul>
                {posts.map(post => (
                    <li key={post.id}>{post.title}</li>
                ))}
            </ul>
        </div>
    );
}
```

Each effect has one job. When posts fetching breaks, you know exactly where to look.

## useContext: Prop Drilling Escape Hatch

Context solves the "pass this theme down through seven components that don't care about it" problem. It's not a state management replacement — it's a broadcast mechanism.

```javascript
import React, { createContext, useContext, useState } from 'react';

const ThemeContext = createContext();

function ThemeProvider({ children }) {
    const [theme, setTheme] = useState('light');
    
    return (
        <ThemeContext.Provider value={{ theme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within ThemeProvider');
    }
    return context;
}

function App() {
    return (
        <ThemeProvider>
            <ThemedButton />
        </ThemeProvider>
    );
}

function ThemedButton() {
    const { theme, setTheme } = useTheme();
    
    return (
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            Current theme: {theme}
        </button>
    );
}
```

The custom `useTheme` hook with the guard clause is a pattern worth stealing. Without it, you get `undefined` errors that send you on a three-hour archaeology expedition through your component tree.

Context re-renders every consumer when the value changes. For frequently updating global state, consider whether you need context at all — or whether a proper state library makes more sense. In 2019, that conversation usually ended with Redux or MobX. Today it might end with Zustand or Jotai. The principle holds: context is for data that changes rarely and is read widely.

## useReducer: When useState Gets Awkward

If your state updates involve multiple sub-values, complex transitions, or the next state depends on the previous one in non-trivial ways, `useReducer` gives you predictable structure:

```javascript
import React, { useReducer } from 'react';

const initialState = { count: 0 };

function reducer(state, action) {
    switch (action.type) {
        case 'increment':
            return { count: state.count + 1 };
        case 'decrement':
            return { count: state.count - 1 };
        case 'reset':
            return { count: 0 };
        default:
            throw new Error();
    }
}

function Counter() {
    const [state, dispatch] = useReducer(reducer, initialState);
    
    return (
        <div>
            <p>Count: {state.count}</p>
            <button onClick={() => dispatch({ type: 'increment' })}>
                +
            </button>
            <button onClick={() => dispatch({ type: 'decrement' })}>
                -
            </button>
            <button onClick={() => dispatch({ type: 'reset' })}>
                Reset
            </button>
        </div>
    );
}
```

I reach for `useReducer` when I catch myself writing `setState` logic that looks like a switch statement anyway. The reducer pattern forces you to think about state transitions explicitly — which pays off when you're debugging why the checkout flow landed in an impossible state.

## Custom Hooks: Where Hooks Become Actually Powerful

The real revolution isn't `useState`. It's custom hooks — reusable bundles of stateful logic that compose like Lego bricks.

### Data Fetching Hook

Every team in 2019 reinvented this wheel. Here's a solid version:

```javascript
function useFetch(url) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    
    useEffect(() => {
        async function fetchData() {
            try {
                setLoading(true);
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                const json = await response.json();
                setData(json);
            } catch (err) {
                setError(err);
            } finally {
                setLoading(false);
            }
        }
        
        fetchData();
    }, [url]);
    
    return { data, loading, error };
}

// Usage
function UserProfile({ userId }) {
    const { data: user, loading, error } = useFetch(`/api/users/${userId}`);
    
    if (loading) return <div>Loading...</div>;
    if (error) return <div>Error: {error.message}</div>;
    return <div>{user.name}</div>;
}
```

Now every component that needs data gets the same loading/error/success behavior. Fix a race condition once, fix it everywhere.

Production note from painful experience: this hook doesn't cancel in-flight requests when `url` changes. For a blog post example it's fine. For production, add an `AbortController` or an `isMounted` guard. Your users navigate faster than your API responds.

### Local Storage Hook

Persistence without the "why did my state reset on refresh" surprise:

```javascript
function useLocalStorage(key, initialValue) {
    const [storedValue, setStoredValue] = useState(() => {
        try {
            const item = window.localStorage.getItem(key);
            return item ? JSON.parse(item) : initialValue;
        } catch (error) {
            return initialValue;
        }
    });
    
    const setValue = (value) => {
        try {
            const valueToStore = value instanceof Function ? value(storedValue) : value;
            setStoredValue(valueToStore);
            window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch (error) {
            console.error(error);
        }
    };
    
    return [storedValue, setValue];
}

// Usage
function Settings() {
    const [theme, setTheme] = useLocalStorage('theme', 'light');
    
    return (
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            Theme: {theme}
        </button>
    );
}
```

The lazy initializer (`useState(() => ...)`) avoids reading localStorage on every render. Small detail, real performance win.

## Performance: useMemo and useCallback (Use Sparingly)

Here's the uncomfortable truth about hooks-era React: most performance problems are architectural, not missing `useMemo`. That said, when you have genuinely expensive computations or child components that re-render unnecessarily, these hooks help.

### useMemo: Cache Expensive Calculations

```javascript
import React, { useState, useMemo } from 'react';

function ExpensiveComponent({ items, filter }) {
    const filteredItems = useMemo(() => {
        return items.filter(item => item.category === filter);
    }, [items, filter]);
    
    return (
        <ul>
            {filteredItems.map(item => (
                <li key={item.id}>{item.name}</li>
            ))}
        </ul>
    );
}
```

`useMemo` recalculates only when `items` or `filter` change. Filtering a hundred items? Don't bother. Filtering ten thousand items on every keystroke? Now we're talking.

### useCallback: Stable Function References

```javascript
import React, { useState, useCallback } from 'react';

function Parent() {
    const [count, setCount] = useState(0);
    
    const handleClick = useCallback(() => {
        setCount(count + 1);
    }, [count]);
    
    return <Child onClick={handleClick} />;
}

const Child = React.memo(({ onClick }) => {
    return <button onClick={onClick}>Click me</button>;
});
```

`useCallback` shines when you pass callbacks to `React.memo`-wrapped children. Without it, a new function reference on every parent render defeats memoization entirely. The parent re-renders, creates a new `handleClick`, child thinks props changed, child re-renders. You added `React.memo` for nothing.

My rule of thumb in 2019: don't reach for these until you measure a problem. Premature memoization makes code harder to read for marginal gains.

## Patterns That Survive Production

### Form Handling Hook

Forms are where hooks really shine — controlled inputs with clean handlers:

```javascript
function useForm(initialValues) {
    const [values, setValues] = useState(initialValues);
    
    const handleChange = (e) => {
        const { name, value } = e.target;
        setValues(prev => ({
            ...prev,
            [name]: value
        }));
    };
    
    const handleSubmit = (onSubmit) => (e) => {
        e.preventDefault();
        onSubmit(values);
    };
    
    return { values, handleChange, handleSubmit };
}

// Usage
function LoginForm() {
    const { values, handleChange, handleSubmit } = useForm({
        email: '',
        password: ''
    });
    
    const onSubmit = (data) => {
        console.log('Submit:', data);
    };
    
    return (
        <form onSubmit={handleSubmit(onSubmit)}>
            <input
                name="email"
                value={values.email}
                onChange={handleChange}
            />
            <input
                name="password"
                type="password"
                value={values.password}
                onChange={handleChange}
            />
            <button type="submit">Login</button>
        </form>
    );
}
```

Extract this once, use it in every form. Your login page, settings page, and checkout flow all share the same behavior.

## What I Learned the Hard Way

**Hooks belong at the top level.** Putting `useState` inside an `if` block works until it doesn't, and when it doesn't, the error messages are cryptic enough to make you consider Vue.

**Dependency arrays are a feature, not bureaucracy.** The exhaustive-deps ESLint rule annoyed everyone in 2019. It also prevented an entire category of stale-closure bugs. Enable it. Apologize to your past self.

**Cleanup is not optional.** Timers, subscriptions, and fetch requests all need teardown. React 18's Strict Mode will mount, unmount, and remount your components in development specifically to catch missing cleanup. It's annoying and correct.

**Custom hooks are the real product.** `useState` and `useEffect` are primitives. Custom hooks are where your team's conventions live — how you fetch data, handle forms, manage auth, track analytics. Invest there.

**Don't memoize everything.** Profile first. Most re-renders are cheap. The ones that aren't usually point to a design problem — too much state in the wrong place, context values that change too often, components doing too many jobs.

**Test hooks with React Testing Library.** Render the component that uses the hook, interact with it like a user would, assert on DOM output. Testing hooks in isolation is possible but usually unnecessary.

## Where to Start

If you're migrating from class components in 2019, here's a sane progression:

1. **Start with `useState` and `useEffect`** — they cover 80% of what you were doing with classes
2. **Extract custom hooks** the moment you copy-paste the same logic twice
3. **Add `useContext`** when prop drilling makes you miserable
4. **Reach for `useReducer`** when state transitions get complicated
5. **Optimize last** with `useMemo`/`useCallback` only after you measure

Hooks didn't kill class components because they were trendy. They won because they made stateful logic composable in a way classes never could. Once the dependency array clicks, you'll wonder how you tolerated `this.setState` for so long.

Just... maybe don't deploy your first `useEffect` on a Friday afternoon.

---

*Written July 2019, covering React 16.8+ hooks. The API has evolved since (React 18 concurrent features, stricter Strict Mode), but these patterns remain the foundation of modern React development.*

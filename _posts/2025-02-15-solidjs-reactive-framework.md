---
layout: post
title: "SolidJS: A Reactive UI Framework"
date: 2025-02-15
categories: [How-To]
tags: [SolidJS, React, Frontend, Framework]
excerpt: "Build reactive UIs with SolidJS: fine-grained reactivity, performance benefits, component patterns, and how SolidJS compares to React."
---

[SolidJS](https://www.solidjs.com/) is what happens when you take React's API and throw away the virtual DOM. Created by [Ryan Carniato](https://github.com/ryansolid), Solid delivers React-like DX with performance that rivals vanilla JavaScript.

I discovered Solid while optimizing a React dashboard that re-rendered too often. The app was functional but sluggish—every state change triggered component re-renders up the tree. Solid's fine-grained reactivity meant updates only touched the exact DOM nodes that needed changing. The same app in Solid felt instant.

The key insight: **React's virtual DOM is a workaround, not a feature**. Solid compiles JSX to real DOM operations at build time, eliminating the reconciliation overhead entirely. Updates go straight to the DOM with surgical precision.

## How Solid Differs from React

**No Virtual DOM** - Solid compiles JSX to efficient DOM updates. No diffing, no reconciliation.

**Fine-grained reactivity** - State changes update only affected DOM nodes, not entire component trees.

**Real JSX** - JSX in Solid maps to actual DOM elements, not function calls that return descriptions of elements.

**No rules of hooks** - Solid's primitives (`createSignal`, `createEffect`) work anywhere, not just component top level.

**Smaller bundle** - ~7KB vs React's ~45KB (gzipped). Every byte matters for initial load.

Check out [Solid's reactivity documentation](https://www.solidjs.com/guides/reactivity) for deep technical details.

## Signals: Solid's Reactive Primitives

Signals are Solid's state management. Think React's `useState`, but they're getters/setters that automatically track dependencies.

### Basic Component

```jsx
import { createSignal } from 'solid-js';

function Counter() {
    // createSignal returns [getter, setter]
    const [count, setCount] = createSignal(0);
    
    return (
        <div>
            {/* Call count() to read value */}
            <p>Count: {count()}</p>
            
            {/* Updates only the text node, not the whole component */}
            <button onClick={() => setCount(count() + 1)}>
                Increment
            </button>
        </div>
    );
}
```

**Key difference from React**: You call `count()` to read the value. This function call establishes the dependency relationship—Solid knows exactly which DOM nodes depend on which signals.

### Effects: Reactive Side Effects

```jsx
import { createSignal, createEffect } from 'solid-js';

function App() {
    const [name, setName] = createSignal('World');
    
    // createEffect runs immediately and re-runs when dependencies change
    createEffect(() => {
        console.log(`Hello, ${name()}!`);
        // Automatically tracks name() as dependency
    });
    
    return (
        <div>
            <input 
                type="text"
                value={name()} 
                onInput={(e) => setName(e.target.value)} 
            />
            <p>Hello, {name()}!</p>
        </div>
    );
}
```

**No dependency array needed** - Solid automatically tracks which signals you read. In React, you'd write:
```jsx
useEffect(() => { ... }, [name])  // Manual dependency tracking
```

In Solid, just reading `name()` inside the effect establishes the dependency.

### Derived State (Memos)

```jsx
import { createSignal, createMemo } from 'solid-js';

function ExpensiveComputation() {
    const [count, setCount] = createSignal(0);
    const [multiplier, setMultiplier] = createSignal(2);
    
    // createMemo caches the result until dependencies change
    const result = createMemo(() => {
        console.log('Computing...');
        return count() * multiplier();
    });
    
    return (
        <div>
            <p>Result: {result()}</p>  {/* Reads cached value */}
            <button onClick={() => setCount(count() + 1)}>Increment</button>
        </div>
    );
}
```

Memos are like React's `useMemo`, but again, no dependency array—Solid tracks automatically.

### Stores: Nested Reactive State

For complex state, use [Solid's stores](https://www.solidjs.com/tutorial/stores_createstore):

```jsx
import { createStore } from 'solid-js/store';

function TodoList() {
    const [todos, setTodos] = createStore([
        { id: 1, text: 'Learn Solid', done: false },
        { id: 2, text: 'Build app', done: false }
    ]);
    
    // Update nested property - only that property reactively updates
    const toggleTodo = (id) => {
        setTodos(
            (todo) => todo.id === id,  // Find todo
            'done', (done) => !done     // Toggle done
        );
    };
    
    return (
        <ul>
            {/* For loops are reactive in Solid */}
            <For each={todos}>
                {(todo) => (
                    <li 
                        style={{ 
                            'text-decoration': todo.done ? 'line-through' : 'none' 
                        }}
                        onClick={() => toggleTodo(todo.id)}
                    >
                        {todo.text}
                    </li>
                )}
            </For>
        </ul>
    );
}
```

Stores give you granular updates—changing `todos[0].done` only updates that specific list item's DOM, not the entire list.

## Performance: Why Solid is Fast

Solid consistently ranks at the top of [JS Framework Benchmarks](https://krausest.github.io/js-framework-benchmark/current.html), often trading places with vanilla JS.

### Benchmark Results (from js-framework-benchmark)

| Framework | Create 1,000 rows | Update every 10th | Remove row | Startup time |
|-----------|-------------------|-------------------|------------|--------------|
| Vanilla JS | 1.0x | 1.0x | 1.0x | 1.0x |
| **SolidJS** | **1.1x** | **1.0x** | **1.1x** | **1.1x** |
| Svelte | 1.2x | 1.3x | 1.2x | 1.3x |
| Vue 3 | 1.3x | 1.4x | 1.2x | 1.5x |
| React | 1.7x | 2.4x | 1.3x | 2.1x |

(Lower is better. Solid performs within ~10% of vanilla JS)

### Why the Speed?

**1. No Virtual DOM overhead** - React diffs two virtual trees on every update. Solid updates the DOM directly.

**2. Compilation over runtime** - Solid's JSX is compiled to DOM instructions at build time:

```jsx
// You write:
<h1>Hello {name()}</h1>

// Solid compiles to something like:
const el = document.createElement('h1');
el.firstChild.data = 'Hello ';
createEffect(() => el.firstChild.nextSibling.data = name());
```

**3. Granular updates** - When `name()` changes, only that text node updates. Not the `<h1>`, not the component—just the text node.

**4. Component functions run once** - Unlike React where components re-run on every render:

```jsx
// React: This logs on every state change
function Component() {
    console.log('Rendering!');
    const [count, setCount] = useState(0);
    return <div>{count}</div>;
}

// Solid: This logs once
function Component() {
    console.log('Rendering!');  // Only runs once!
    const [count, setCount] = createSignal(0);
    return <div>{count()}</div>;
}
```

### Bundle Size

| Framework | Minified + Gzipped |
|-----------|-------------------|
| SolidJS | 7 KB |
| Preact | 11 KB |
| Vue 3 | 34 KB |
| React + ReactDOM | 45 KB |
| Angular | 62 KB |

For production apps, check [Bundlephobia](https://bundlephobia.com/package/solid-js).

## Migrating from React

Solid's API is intentionally React-like to ease migration. Here are the key differences:

### State

```jsx
// React
const [count, setCount] = useState(0);
useEffect(() => { console.log(count); }, [count]);

// Solid
const [count, setCount] = createSignal(0);
createEffect(() => { console.log(count()); });  // No dependency array!
```

**Key differences:**
- Call the getter: `count()` not `count`
- No dependency arrays - automatic tracking
- Effects run synchronously, not after render

### Conditional Rendering

```jsx
// React
{isLoggedIn && <Dashboard />}
{isLoggedIn ? <Dashboard /> : <Login />}

// Solid - use Show for conditionals
<Show when={isLoggedIn()}>
    <Dashboard />
</Show>

<Show when={isLoggedIn()} fallback={<Login />}>
    <Dashboard />
</Show>
```

Using `<Show>` is important—it ensures reactivity. The condition is only evaluated once, and the component mounts/unmounts efficiently.

### Lists

```jsx
// React
{items.map(item => <Item data={item} key={item.id} />)}

// Solid - use For
<For each={items()}>
    {(item, index) => <Item data={item} />}
</For>

// Or Index for keying by index
<Index each={items()}>
    {(item, index) => <Item data={item()} />}
</Index>
```

`<For>` is optimized for minimal DOM operations. It only updates changed items, not the entire list.

### Event Handlers

```jsx
// React - synthetic events
onClick={(e) => handleClick(e)}

// Solid - real DOM events, no synthetic events
onClick={(e) => handleClick(e)}  // Same syntax, but it's the real DOM event
```

Solid uses native DOM events—no synthetic event system means less overhead.

### Context

```jsx
// React
const ThemeContext = createContext();
const theme = useContext(ThemeContext);

// Solid - similar but typed
const ThemeContext = createContext();
const theme = useContext(ThemeContext);
```

Context API is nearly identical. No surprises here.

## When to Use Solid

**Choose Solid when:**
- ✅ Performance is critical (dashboards, data visualizations, games)
- ✅ You want React-like DX but better performance
- ✅ Bundle size matters (mobile, slow connections)
- ✅ You're building a new project (migration cost is low)
- ✅ Your team knows React (learning curve is gentle)

**Stick with React when:**
- You have a large existing React codebase (migration cost)
- You need React Native (Solid is web-only)
- You rely heavily on React's ecosystem (though Solid's is growing)

## Ecosystem and Tools

**UI Libraries:**
- [Solid UI](https://www.solid-ui.com/) - Component library
- [Hope UI](https://hope-ui.com/) - Accessible components
- [Kobalte](https://kobalte.dev/) - Unstyled, accessible primitives

**Routing:**
- [Solid Router](https://github.com/solidjs/solid-router) - Official router
- [Solid App Router](https://github.com/solidjs/solid-start) - File-based routing with Solid Start

**State Management:**
- Built-in stores usually sufficient
- [Solid Query](https://tanstack.com/query/latest/docs/framework/solid/overview) - Data fetching

**Meta-Frameworks:**
- [Solid Start](https://start.solidjs.com/) - Full-stack framework (like Next.js for Solid)
- [SolidHack](https://hack.solidjs.com/) - Starter templates

**Dev Tools:**
- [Solid DevTools](https://github.com/thetarnav/solid-devtools) - Browser extension
- Built-in TypeScript support

## Production Best Practices

1. **Use TypeScript** - Solid's type inference is excellent
2. **Leverage compilation** - Let the compiler optimize
3. **Test with [Solid Testing Library](https://github.com/solidjs/solid-testing-library)** - Similar to React Testing Library
4. **Profile with browser DevTools** - Solid's updates are visible in the DOM
5. **Use `<Show>` and `<For>`** - Not raw conditionals/maps (they're not reactive)
6. **Batch updates** - Use `batch()` for multiple signal updates
7. **Lazy load components** - `const Comp = lazy(() => import('./Comp'))`

## Conclusion

Solid proves that fine-grained reactivity beats virtual DOM for most applications. By compiling JSX to efficient DOM operations and eliminating unnecessary re-renders, Solid delivers React-like DX with near-vanilla-JS performance.

The 7KB bundle and top-tier benchmark results aren't theoretical—they translate to faster load times and more responsive UIs. For performance-critical applications where every frame matters, Solid is the right choice.

Ryan Carniato and the Solid community have built something genuinely novel: a reactive framework that's both powerful and minimal. If you're starting a new project and React's re-rendering model has ever frustrated you, give Solid a weekend. You might not go back.

**Further Resources:**
- [SolidJS Documentation](https://www.solidjs.com/docs/latest) - Comprehensive guides
- [Interactive Tutorial](https://www.solidjs.com/tutorial/introduction_basics) - Learn by doing
- [Solid Playground](https://playground.solidjs.com/) - Try it in browser
- [Ryan Carniato's YouTube](https://www.youtube.com/@ryansolid) - Deep dives from the creator
- [Solid Discord](https://discord.com/invite/solidjs) - Active community
- [JS Framework Benchmark](https://krausest.github.io/js-framework-benchmark/current.html) - Performance data
- [Solid vs React](https://www.solidjs.com/guides/comparison#react) - Official comparison

---

*SolidJS reactive framework from February 2025 — updated with production guidance.*

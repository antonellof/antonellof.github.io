---
layout: post
title: "React Component Patterns: Composition vs Inheritance"
date: 2017-02-18
categories: [Architecture]
tags: [React, JavaScript, Component Design, Patterns]
excerpt: "I once inherited a React app with a 400-line BaseComponent class. Here's how composition, HOCs, render props, and hooks saved my sanity—and how to pick the right pattern without creating a wrapper hell nightmare."
---

# React Component Patterns: Composition vs Inheritance

I once inherited a React codebase where someone had built a `BaseComponent` class with 400 lines of shared logic. Authentication checks, data fetching, error boundaries, analytics hooks—all crammed into one inheritance tree. Changing one behavior meant praying you didn't break twelve screens you'd never heard of.

React's official guidance is blunt: **use composition, not inheritance.** They're not being philosophical. They're trying to save you from the exact mess I walked into.

After building (and refactoring) several production React apps, here's what I've learned about the patterns that actually scale—and the ones that create beautiful diagrams in architecture meetings and beautiful disasters in git blame.

## Composition: The Default Move

React gives you components. You build bigger components from smaller ones. No `extends`, no fragile base classes, no "which method did the child override?"

```jsx
// Instead of inheritance
class Button extends BaseComponent { }

// Use composition
function Button({ children, onClick, variant }) {
    return (
        <button 
            className={`btn btn-${variant}`}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

// Compose components
function App() {
    return (
        <div>
            <Button variant="primary" onClick={handleClick}>
                Click Me
            </Button>
            <Button variant="secondary">
                Cancel
            </Button>
        </div>
    );
}
```

The `children` prop is doing the heavy lifting here. Your `Button` doesn't know or care what's inside it—a label, an icon, a loading spinner. That's flexibility inheritance struggles to match without abstract methods and template-method patterns that make everyone miserable.

Start here. Stay here until you have a specific reason to leave.

## Container vs Presentational: Separate "What" From "How It Looks"

One of the most useful mental models from React's early days: split components into containers (data, state, side effects) and presentational components (pure rendering).

```jsx
// Container Component (Smart)
class UserListContainer extends React.Component {
    state = { users: [], loading: true };
    
    componentDidMount() {
        fetch('/api/users')
            .then(res => res.json())
            .then(users => this.setState({ users, loading: false }));
    }
    
    render() {
        return (
            <UserList 
                users={this.state.users}
                loading={this.state.loading}
            />
        );
    }
}

// Presentational Component (Dumb)
function UserList({ users, loading }) {
    if (loading) return <div>Loading...</div>;
    
    return (
        <ul>
            {users.map(user => (
                <li key={user.id}>{user.name}</li>
            ))}
        </ul>
    );
}
```

Why bother? Three reasons that mattered in 2017 and still matter now:

**Testability.** `UserList` is a pure function of props. You can test every visual state—loading, empty, populated—without mocking `fetch`.

**Reusability.** Need the same list UI with data from Redux instead of local state? Swap the container, keep the presentational component.

**Designer collaboration.** "Dumb" components have obvious props. Hand a designer the prop interface and they can reason about what the UI can do without reading your Redux middleware.

The pattern isn't gospel—hooks blurred the container/presentational line—but the *separation of concerns* absolutely is.

## Higher-Order Components: Power With a Side of Wrapper Hell

HOCs wrap a component to inject behavior. Think of them as decorators for React components:

```jsx
// HOC for data fetching
function withData(WrappedComponent, dataSource) {
    return class extends React.Component {
        state = { data: null, loading: true, error: null };
        
        componentDidMount() {
            dataSource()
                .then(data => this.setState({ data, loading: false }))
                .catch(error => this.setState({ error, loading: false }));
        }
        
        render() {
            const { data, loading, error } = this.state;
            
            if (loading) return <div>Loading...</div>;
            if (error) return <div>Error: {error.message}</div>;
            
            return <WrappedComponent data={data} {...this.props} />;
        }
    };
}

// Usage
const UserListWithData = withData(
    UserList,
    () => fetch('/api/users').then(res => res.json())
);
```

HOCs shine for **cross-cutting concerns**—things every component needs but shouldn't implement itself:

```jsx
// HOC for authentication
function withAuth(WrappedComponent) {
    return class extends React.Component {
        componentDidMount() {
            if (!this.props.isAuthenticated) {
                this.props.history.push('/login');
            }
        }
        
        render() {
            if (!this.props.isAuthenticated) {
                return null;
            }
            
            return <WrappedComponent {...this.props} />;
        }
    };
}

// HOC for logging
function withLogging(WrappedComponent) {
    return class extends React.Component {
        componentDidMount() {
            console.log(`Component ${WrappedComponent.name} mounted`);
        }
        
        render() {
            return <WrappedComponent {...this.props} />;
        }
    };
}

// Compose multiple HOCs
const EnhancedComponent = withLogging(withAuth(withData(UserList)));
```

The problem with that last line? **Wrapper hell.** Open React DevTools and you see `withLogging(withAuth(withData(UserList)))` nesting like a Russian doll collection. Debugging props means tracing through four layers. Static analysis tools lose their minds.

HOCs also create subtle bugs with prop forwarding—does your HOC pass through `ref`? What about props the wrapped component needs but the HOC doesn't know about?

Use HOCs when you genuinely need to wrap *multiple unrelated components* with the same logic (auth, analytics, error boundaries). Use them sparingly. If you're stacking more than two, pause and ask if a render prop or hook would be clearer.

## Render Props: "Here's My State, You Paint It"

Render props flip the HOC model. Instead of wrapping your component, the parent provides a function that *you* call with state:

```jsx
// Data fetching component with render prop
class DataFetcher extends React.Component {
    state = { data: null, loading: true, error: null };
    
    componentDidMount() {
        this.props.fetch()
            .then(data => this.setState({ data, loading: false }))
            .catch(error => this.setState({ error, loading: false }));
    }
    
    render() {
        return this.props.render(this.state);
    }
}

// Usage
function App() {
    return (
        <DataFetcher
            fetch={() => fetch('/api/users').then(res => res.json())}
            render={({ data, loading, error }) => {
                if (loading) return <div>Loading...</div>;
                if (error) return <div>Error: {error.message}</div>;
                return <UserList users={data} />;
            }}
        />
    );
}
```

The caller controls rendering. `DataFetcher` owns the data lifecycle but doesn't dictate what loading looks like. Different screens can show spinners, skeletons, or nothing—same data logic.

### Children as Function

Same pattern, nicer syntax when it fits:

```jsx
// Mouse position tracker
class MouseTracker extends React.Component {
    state = { x: 0, y: 0 };
    
    handleMouseMove = (event) => {
        this.setState({
            x: event.clientX,
            y: event.clientY
        });
    };
    
    render() {
        return (
            <div onMouseMove={this.handleMouseMove}>
                {this.props.children(this.state)}
            </div>
        );
    }
}

// Usage
function App() {
    return (
        <MouseTracker>
            {({ x, y }) => (
                <div>
                    Mouse position: {x}, {y}
                </div>
            )}
        </MouseTracker>
    );
}
```

Render props are explicit. You can see exactly what data flows where. The trade-off: JSX gets verbose, and inline render functions can defeat `React.memo` optimizations if you're not careful about referential equality.

Reach for render props when the *rendering* needs to vary significantly across consumers, or when you want to avoid HOC wrapper nesting.

## Compound Components: Components That Know Each Other

Sometimes components are meant to work as a set—tabs, accordions, select menus. Compound components share implicit state through React's children API:

```jsx
// Tabs component
class Tabs extends React.Component {
    state = { activeIndex: 0 };
    
    render() {
        const children = React.Children.map(
            this.props.children,
            (child, index) => {
                return React.cloneElement(child, {
                    isActive: index === this.state.activeIndex,
                    onClick: () => this.setState({ activeIndex: index })
                });
            }
        );
        
        return <div className="tabs">{children}</div>;
    }
}

function Tab({ isActive, onClick, children }) {
    return (
        <div
            className={`tab ${isActive ? 'active' : ''}`}
            onClick={onClick}
        >
            {children}
        </div>
    );
}

// Usage
function App() {
    return (
        <Tabs>
            <Tab>Tab 1</Tab>
            <Tab>Tab 2</Tab>
            <Tab>Tab 3</Tab>
        </Tabs>
    );
}
```

The API is elegant—`<Tabs><Tab>...</Tab></Tabs>` reads like HTML. The implementation uses `cloneElement`, which React's team has gently discouraged. Context API (available since React 16.3) is the modern alternative for sharing state among compound children without prop injection magic.

Still, compound components remain the right pattern for UI kits and design systems where you want intuitive, declarative APIs.

## Controlled vs Uncontrolled: Who Owns the Input State?

### Controlled Components

React owns the value. Every keystroke flows through state:

```jsx
class ControlledInput extends React.Component {
    state = { value: '' };
    
    handleChange = (event) => {
        this.setState({ value: event.target.value });
    };
    
    render() {
        return (
            <input
                value={this.state.value}
                onChange={this.handleChange}
            />
        );
    }
}
```

Controlled inputs are the React default for good reason: you can validate on every keystroke, format values, disable submission when invalid, reset forms programmatically. The cost is more code and slightly more re-renders.

### Uncontrolled Components

The DOM owns the value. You read it when you need it:

```jsx
class UncontrolledInput extends React.Component {
    inputRef = React.createRef();
    
    handleSubmit = () => {
        console.log('Value:', this.inputRef.current.value);
    };
    
    render() {
        return (
            <div>
                <input ref={this.inputRef} />
                <button onClick={this.handleSubmit}>Submit</button>
            </div>
        );
    }
}
```

Uncontrolled is fine for simple forms where you grab values on submit and don't need live validation. File inputs are inherently uncontrolled. Don't fight the DOM on those.

The classic React mistake: switching between controlled and uncontrolled (toggling between `value={state}` and `value={undefined}`). Pick one model per input and commit.

## Custom Hooks: The Plot Twist (React 16.8+)

I'm writing this in February 2017, and hooks aren't here yet—but they're coming, and they'll change the calculus for everything above. Worth a forward-looking section because this is the pattern that eventually replaced most of our HOCs and render props:

```jsx
// Custom hook for data fetching
function useData(fetchFn) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    
    useEffect(() => {
        fetchFn()
            .then(data => {
                setData(data);
                setLoading(false);
            })
            .catch(err => {
                setError(err);
                setLoading(false);
            });
    }, []);
    
    return { data, loading, error };
}

// Usage
function UserList() {
    const { data, loading, error } = useData(
        () => fetch('/api/users').then(res => res.json())
    );
    
    if (loading) return <div>Loading...</div>;
    if (error) return <div>Error: {error.message}</div>;
    
    return (
        <ul>
            {data.map(user => (
                <li key={user.id}>{user.name}</li>
            ))}
        </ul>
    );
}
```

No wrapper components. No render prop indentation. Just a function that returns state. The logic is colocated with the component that uses it, composable via plain function calls, and trivially testable in isolation.

When hooks land, most of our `withData` HOCs and `DataFetcher` render props will get deleted. Not because those patterns were wrong—they solved real problems in React 15—but because hooks solve the same problems with less ceremony.

## Choosing a Pattern (Without Overthinking It)

There's no pattern olympics. There's "what makes this codebase easier to change in six months."

**Reach for composition** when you're building UI from pieces. This is your default for layout, styling, and structural reuse.

**Reach for container/presentational separation** when data fetching and rendering are getting tangled. Even with hooks, the *idea* of separating concerns persists.

**Reach for HOCs** when you need to inject cross-cutting behavior into many unrelated class components—auth guards, analytics, legacy connect() patterns. Go easy on stacking.

**Reach for render props** when consumers need full control over rendering and you want to share stateful logic without wrapper nesting. Great for libraries.

**Reach for compound components** when you're building a cohesive UI primitive (tabs, menus, modals) with an intuitive declarative API.

**Reach for hooks** (once available) when you're in functional components and want to share stateful logic without any of the above ceremony.

If you're debating HOC vs render prop vs hook for the same problem, you're probably fine with any of them. Pick the one your team reads most easily and move on.

## What I'd Tell Past Me

Don't build a `BaseComponent`. Don't stack six HOCs because each one solved one problem in isolation. Don't make every input controlled if you only read values on submit.

Do keep components small and focused—one job per component isn't dogma, it's damage control. Do document your component props (even just JSDoc). Do test presentational components with straightforward prop fixtures.

The pattern you choose matters less than whether a new teammate can understand your component in thirty seconds.

## The Bottom Line

React's component model rewards composition at every level:

- Build complex UIs from simple, focused components
- Share logic through HOCs, render props, or (soon) hooks—pick based on ergonomics, not ideology
- Separate data concerns from presentation when they start fighting
- Controlled inputs by default; uncontrolled when the DOM should win

Start with plain composition. Add abstraction only when you feel the pain of duplication—not when you see a pattern that looks clever in a blog post.

That 400-line `BaseComponent` I inherited? We killed it with a combination of composition, a few targeted HOCs, and render props where rendering flexibility mattered. Six months later, the team was shipping features instead of archaeology expeditions.

---

*React component patterns from February 2017, covering React 15.x class components, HOCs, and render props. Hooks (React 16.8+) would arrive the following year and reshape most of this advice—for the better.*

---
layout: post
title: "React Component Patterns: Composition vs Inheritance"
date: 2017-02-18
categories: [Architecture]
tags: [React, JavaScript, Component Design, Patterns]
excerpt: "Explore React component composition patterns, higher-order components, render props, and when to use each approach. Learn how to build reusable, maintainable React components."
---

React's component model encourages composition over inheritance. After building complex React applications, I've learned that choosing the right pattern makes the difference between maintainable code and a tangled mess. Here are the patterns that work in production.

## Composition Over Inheritance

React's philosophy: "Composition is more powerful than inheritance." This means building complex UIs by combining simple components rather than extending base classes.

### Basic Composition

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

## Container vs Presentational Components

Separate data logic from presentation:

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

## Higher-Order Components (HOCs)

HOCs wrap components to add functionality:

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

### Multiple HOCs

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

## Render Props Pattern

Render props pass a function as a prop that returns JSX:

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

### Children as Function

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

## Compound Components

Components that work together:

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

## Controlled vs Uncontrolled Components

### Controlled Components

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

### Uncontrolled Components

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

## Custom Hooks (React 16.8+)

Hooks provide a cleaner alternative to HOCs and render props:

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

## When to Use Each Pattern

### Use HOCs when:
- Adding cross-cutting concerns (auth, logging, analytics)
- Need to wrap multiple components with same logic
- Working with class components

### Use Render Props when:
- Need flexibility in rendering
- Sharing stateful logic
- Want explicit control over rendering

### Use Hooks when:
- Using functional components
- Need to share stateful logic
- Want cleaner, more readable code

### Use Composition when:
- Building UI from smaller pieces
- Need flexibility in component structure
- Creating reusable components

## Best Practices

1. **Prefer composition** - Build complex components from simple ones
2. **Keep components focused** - Single responsibility principle
3. **Use HOCs sparingly** - Can create prop drilling issues
4. **Document component APIs** - Make props and usage clear
5. **Test components in isolation** - Easier to test simple components

## Conclusion

React's composition model is powerful:
- Build complex UIs from simple components
- Reuse logic with HOCs, render props, or hooks
- Keep components focused and testable
- Choose the right pattern for your use case

Start with simple composition, then add HOCs or render props when you need to share logic. With React 16.8+, hooks often provide the cleanest solution.

---

*React component patterns from February 2017, covering React 15.x patterns before hooks were introduced.*

---
layout: post
title: "React Hooks: A Complete Guide"
date: 2019-07-15
categories: [How-To]
tags: [React, Hooks, JavaScript]
excerpt: "Master React Hooks: useState, useEffect, useContext, useReducer, custom hooks, and performance optimization. Learn how to build modern React applications with hooks."
---

React Hooks revolutionized React development. After building production apps with hooks, here's a complete guide to using them effectively.

## What are Hooks?

Hooks let you:
- Use state in functional components
- Access lifecycle methods
- Share logic between components
- Avoid class components

## useState

### Basic Usage

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

### Multiple State Variables

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

### Functional Updates

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

## useEffect

### Basic Usage

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

### Cleanup

```javascript
function Timer() {
    const [seconds, setSeconds] = useState(0);
    
    useEffect(() => {
        const interval = setInterval(() => {
            setSeconds(prev => prev + 1);
        }, 1000);
        
        // Cleanup function
        return () => clearInterval(interval);
    }, []); // Run once on mount
    
    return <div>Seconds: {seconds}</div>;
}
```

### Multiple Effects

```javascript
function UserProfile({ userId }) {
    const [user, setUser] = useState(null);
    const [posts, setPosts] = useState([]);
    
    // Fetch user
    useEffect(() => {
        fetch(`/api/users/${userId}`)
            .then(res => res.json())
            .then(setUser);
    }, [userId]);
    
    // Fetch posts
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

## useContext

### Create Context

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

## useReducer

### Complex State

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

## Custom Hooks

### Data Fetching Hook

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

### Local Storage Hook

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

## Performance Optimization

### useMemo

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

### useCallback

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

## Best Practices

1. **Only call hooks at top level** - Not in loops/conditions
2. **Use dependency arrays** - Prevent unnecessary re-renders
3. **Cleanup effects** - Prevent memory leaks
4. **Create custom hooks** - Reuse logic
5. **Use useMemo/useCallback** - Optimize performance
6. **Follow naming convention** - Start with "use"
7. **Extract complex logic** - Keep components simple
8. **Test hooks** - Use React Testing Library

## Common Patterns

### Form Handling

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

## Conclusion

React Hooks enable:
- Functional components with state
- Reusable logic
- Better performance
- Cleaner code

Start with useState and useEffect, then explore custom hooks. The patterns shown here work for production applications.

---

*React Hooks complete guide from July 2019, covering React 16.8+ features.*

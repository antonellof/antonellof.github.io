---
layout: post
title: "Building a Design System for React Applications"
date: 2020-10-15
categories: [How-To]
tags: [React, Design System, UI]
excerpt: "Create a design system for React applications: component library, tokens, documentation, and best practices for building consistent UIs."
---

Design systems ensure consistency across applications. After building production design systems, here's how to create one effectively.

## What is a Design System?

A design system includes:
- **Components** - Reusable UI elements
- **Tokens** - Design values (colors, spacing)
- **Documentation** - Usage guidelines
- **Tools** - Development utilities

## Project Structure

```
design-system/
├── src/
│   ├── components/
│   ├── tokens/
│   ├── utils/
│   └── index.ts
├── stories/
├── docs/
└── package.json
```

## Design Tokens

### Colors

```typescript
// tokens/colors.ts
export const colors = {
    primary: {
        50: '#f0f9ff',
        100: '#e0f2fe',
        500: '#0ea5e9',
        900: '#0c4a6e',
    },
    gray: {
        50: '#f9fafb',
        100: '#f3f4f6',
        500: '#6b7280',
        900: '#111827',
    },
};

export type ColorScale = typeof colors.primary;
```

### Spacing

```typescript
// tokens/spacing.ts
export const spacing = {
    xs: '0.25rem',   // 4px
    sm: '0.5rem',    // 8px
    md: '1rem',      // 16px
    lg: '1.5rem',    // 24px
    xl: '2rem',      // 32px
};

export type Spacing = keyof typeof spacing;
```

### Typography

```typescript
// tokens/typography.ts
export const typography = {
    fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Fira Code', 'monospace'],
    },
    fontSize: {
        xs: '0.75rem',
        sm: '0.875rem',
        base: '1rem',
        lg: '1.125rem',
        xl: '1.25rem',
    },
    fontWeight: {
        normal: 400,
        medium: 500,
        semibold: 600,
        bold: 700,
    },
};
```

## Components

### Button Component

```typescript
// components/Button.tsx
import React from 'react';
import { colors, spacing } from '../tokens';

interface ButtonProps {
    variant?: 'primary' | 'secondary' | 'outline';
    size?: 'sm' | 'md' | 'lg';
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
    variant = 'primary',
    size = 'md',
    children,
    onClick,
    disabled = false,
}) => {
    const baseStyles = {
        padding: spacing.md,
        borderRadius: '0.375rem',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
    };
    
    const variantStyles = {
        primary: {
            backgroundColor: colors.primary[500],
            color: 'white',
        },
        secondary: {
            backgroundColor: colors.gray[500],
            color: 'white',
        },
        outline: {
            backgroundColor: 'transparent',
            border: `1px solid ${colors.primary[500]}`,
            color: colors.primary[500],
        },
    };
    
    const sizeStyles = {
        sm: { padding: spacing.sm, fontSize: '0.875rem' },
        md: { padding: spacing.md, fontSize: '1rem' },
        lg: { padding: spacing.lg, fontSize: '1.125rem' },
    };
    
    return (
        <button
            style={{
                ...baseStyles,
                ...variantStyles[variant],
                ...sizeStyles[size],
            }}
            onClick={onClick}
            disabled={disabled}
        >
            {children}
        </button>
    );
};
```

### Input Component

```typescript
// components/Input.tsx
import React from 'react';
import { colors, spacing } from '../tokens';

interface InputProps {
    type?: 'text' | 'email' | 'password';
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    error?: string;
}

export const Input: React.FC<InputProps> = ({
    type = 'text',
    placeholder,
    value,
    onChange,
    error,
}) => {
    return (
        <div>
            <input
                type={type}
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                style={{
                    padding: spacing.md,
                    border: '1px solid ' + (error ? colors.error : colors.gray[300]),
                    borderRadius: '0.375rem',
                    width: '100%',
                }}
            />
            {error && (
                <div style={{ color: colors.error, marginTop: spacing.xs }}>
                    {error}
                </div>
            )}
        </div>
    );
};
```

## Storybook

### Setup

```bash
npx sb init
```

### Story Example

```typescript
// Button.stories.tsx
import { Button } from './Button';

export default {
    title: 'Components/Button',
    component: Button,
};

export const Primary = {
    args: {
        variant: 'primary',
        children: 'Click me',
    },
};

export const Secondary = {
    args: {
        variant: 'secondary',
        children: 'Click me',
    },
};

export const Outline = {
    args: {
        variant: 'outline',
        children: 'Click me',
    },
};
```

## Documentation

### Component Documentation

```markdown
# Button Component

## Usage

\`\`\`tsx
import { Button } from '@design-system/components';

<Button variant="primary" onClick={handleClick}>
    Click me
</Button>
\`\`\`

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| variant | 'primary' \| 'secondary' \| 'outline' | 'primary' | Button style |
| size | 'sm' \| 'md' \| 'lg' | 'md' | Button size |
| disabled | boolean | false | Disable button |
```

## Best Practices

1. **Consistent naming** - Clear component names
2. **TypeScript** - Type safety
3. **Documentation** - Usage examples
4. **Accessibility** - ARIA attributes
5. **Testing** - Component tests
6. **Versioning** - Semantic versioning
7. **Changelog** - Track changes
8. **Examples** - Storybook stories

## Conclusion

Design systems provide:
- Consistency
- Reusability
- Maintainability
- Developer experience

Start with tokens, then build components. The patterns shown here create production-ready design systems.

---

*Building design systems for React from October 2020, covering components, tokens, and documentation.*

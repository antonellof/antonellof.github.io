---
layout: post
title: "Building a Design System for React Applications"
date: 2020-10-20
categories: [How-To]
tags: [React, Design System, UI]
excerpt: "Three React apps, three different button styles, zero consistency. Building a design system fixed the UI chaos—and gave us Storybook, design tokens, and the hardest lesson: adoption is harder than implementation."
---

We had three React applications and approximately seven different "primary button" styles. Blue buttons. Slightly different blue buttons. Blue buttons with wrong padding. One team used Material-UI, another had custom CSS, the third copy-pasted Bootstrap components from 2016.

Users didn't consciously notice. But the product felt unpolished—like three companies had built it. Design reviews became arguments about hex codes. Every new feature started with "which button component do we use?"

A design system fixed this. Not a Figma file nobody read—a published npm package with tokens, components, Storybook documentation, and TypeScript types. One `Button` component. One source of truth. Three apps importing the same package.

Building it taught me that the hard part isn't the components—it's tokens, documentation, and getting teams to actually use the thing.

## What a Design System Actually Is

A design system is three things:

1. **Design tokens** — the atoms (colors, spacing, typography, shadows)
2. **Components** — the molecules (Button, Input, Card, Modal)
3. **Documentation** — how to use them (Storybook, usage guidelines, do's and don'ts)

It's not a component library alone. Without tokens, every component hardcodes `#0ea5e9` and drifts. Without docs, developers guess at props and invent variants.

## Project Structure

```
design-system/
├── src/
│   ├── components/       # Button, Input, Card...
│   ├── tokens/           # colors, spacing, typography
│   ├── utils/            # cn(), theme helpers
│   └── index.ts          # Public exports
├── stories/              # Storybook stories
├── docs/                 # Usage guidelines
└── package.json          # Published as @company/design-system
```

Publish as an internal npm package. Apps install it like any dependency. Version with semver—breaking prop changes are major version bumps.

## Design Tokens: The Foundation

Tokens are named design decisions. Change `--color-primary-500` once, every component updates.

### Colors

```typescript
// tokens/colors.ts
export const colors = {
    primary: {
        50: '#f0f9ff',
        100: '#e0f2fe',
        500: '#0ea5e9',
        600: '#0284c7',
        900: '#0c4a6e',
    },
    gray: {
        50: '#f9fafb',
        100: '#f3f4f6',
        500: '#6b7280',
        900: '#111827',
    },
    error: '#ef4444',
    success: '#22c55e',
};
```

Use a scale (50-900) for each color family. Components reference `colors.primary[500]`, not raw hex. When brand updates the primary blue, one file changes.

### Spacing

```typescript
export const spacing = {
    xs: '0.25rem',   // 4px
    sm: '0.5rem',    // 8px
    md: '1rem',      // 16px
    lg: '1.5rem',    // 24px
    xl: '2rem',      // 32px
};
```

Consistent spacing rhythm. No more `padding: 13px` because it "looked right."

### Typography

```typescript
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

## Components: Opinionated and Composable

### Button

```typescript
import React from 'react';
import { colors, spacing } from '../tokens';

interface ButtonProps {
    variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
    size?: 'sm' | 'md' | 'lg';
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
}

export const Button: React.FC<ButtonProps> = ({
    variant = 'primary',
    size = 'md',
    children,
    onClick,
    disabled = false,
    type = 'button',
}) => {
    const baseStyles: React.CSSProperties = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '0.375rem',
        border: 'none',
        fontWeight: typography.fontWeight.medium,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 0.15s ease',
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
        ghost: {
            backgroundColor: 'transparent',
            color: colors.primary[500],
        },
    };
    
    const sizeStyles = {
        sm: { padding: `${spacing.sm} ${spacing.md}`, fontSize: typography.fontSize.sm },
        md: { padding: `${spacing.md} ${spacing.lg}`, fontSize: typography.fontSize.base },
        lg: { padding: `${spacing.lg} ${spacing.xl}`, fontSize: typography.fontSize.lg },
    };
    
    return (
        <button
            type={type}
            style={{ ...baseStyles, ...variantStyles[variant], ...sizeStyles[size] }}
            onClick={onClick}
            disabled={disabled}
        >
            {children}
        </button>
    );
};
```

**Design system rules for components:**
- Sensible defaults (`variant='primary'`, `size='md'`)
- Limited variants (resist the "can we add one more variant?" urge)
- TypeScript props with JSDoc
- Accessibility baked in (focus states, aria attributes, keyboard support)

### Input with Error States

```typescript
interface InputProps {
    type?: 'text' | 'email' | 'password';
    label?: string;
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    error?: string;
    disabled?: boolean;
}

export const Input: React.FC<InputProps> = ({
    type = 'text',
    label,
    placeholder,
    value,
    onChange,
    error,
    disabled = false,
}) => {
    const inputId = useId();
    
    return (
        <div style={{ marginBottom: spacing.md }}>
            {label && (
                <label htmlFor={inputId} style={{ display: 'block', marginBottom: spacing.xs }}>
                    {label}
                </label>
            )}
            <input
                id={inputId}
                type={type}
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                aria-invalid={!!error}
                aria-describedby={error ? `${inputId}-error` : undefined}
                style={{
                    padding: spacing.md,
                    border: `1px solid ${error ? colors.error : colors.gray[300]}`,
                    borderRadius: '0.375rem',
                    width: '100%',
                }}
            />
            {error && (
                <div id={`${inputId}-error`} role="alert" style={{ color: colors.error, marginTop: spacing.xs }}>
                    {error}
                </div>
            )}
        </div>
    );
};
```

## Storybook: Documentation Developers Actually Use

```bash
npx storybook@latest init
```

```typescript
// Button.stories.tsx
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
    title: 'Components/Button',
    component: Button,
    argTypes: {
        variant: { control: 'select', options: ['primary', 'secondary', 'outline', 'ghost'] },
        size: { control: 'select', options: ['sm', 'md', 'lg'] },
    },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
    args: { variant: 'primary', children: 'Save changes' },
};

export const Disabled: Story = {
    args: { variant: 'primary', children: 'Processing...', disabled: true },
};

export const AllVariants: Story = {
    render: () => (
        <div style={{ display: 'flex', gap: '1rem' }}>
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
        </div>
    ),
};
```

Storybook is your design system's homepage. Designers review it. Developers discover components. QA verifies visual states. Deploy it—don't keep it localhost-only.

## Adoption: Harder Than Implementation

We built beautiful components. Two teams used them. The third kept custom CSS because "migration is too much work."

**What worked:**
- **Deprecation timeline** — old button styles marked deprecated with lint rules
- **Pairing sessions** — design system team helped migrate one screen per app
- **Showcase apps** — reference implementations teams could copy
- **Slack channel** — `#design-system` for questions, fast responses
- **Changelog** — every release documented with migration notes

**What didn't work:**
- Mandates without migration support
- Breaking changes without semver
- Components missing edge cases teams needed (loading states, icons, full-width)

A design system is a product. Your users are other developers. Treat them like users.

## Best Practices

1. **Start with tokens** — before building components
2. **Limit variants** — 3 button variants, not 12
3. **TypeScript everything** — props are documentation
4. **Accessibility non-negotiable** — WCAG compliance from day one
5. **Test visually** — Chromatic or Percy for visual regression
6. **Semver strictly** — breaking prop rename = major bump
7. **Co-locate docs** — Storybook stories next to components
8. **Dogfood immediately** — use in one real app before publishing

## Conclusion

A design system isn't a side project for the frontend guild—it's infrastructure. Tokens eliminate hex code debates. Components eliminate duplicated UI code. Storybook eliminates "how do I use this?" Slack messages.

The seven button problem sounds trivial. Multiply it by every UI element across every app, and you have thousands of hours of inconsistency, accessibility gaps, and design debt.

Start small: tokens + Button + Input + Card. Publish to npm. Migrate one app. Document in Storybook. Iterate based on what teams actually need—not what you think they should want.

Three apps, one design system, zero `#0ea5e9` vs `#0da5e9` arguments. That's the ROI.

---

*Building design systems for React from October 2020, covering components, tokens, and documentation.*

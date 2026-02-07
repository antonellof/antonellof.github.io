---
layout: post
title: "C4 Model: Visualizing Software Architecture"
date: 2022-01-15
categories: [Architecture]
tags: [C4 Model, Architecture, Documentation]
excerpt: "Document software architecture with the C4 model: context, containers, components, and code diagrams. Learn how to create clear, maintainable architecture documentation."
---

The C4 model provides a structured approach to architecture diagrams. After using C4 in production, here's how to document architecture effectively.

## C4 Model Levels

### Level 1: System Context

**Shows:**
- System and users
- External systems
- High-level view

```
┌─────────┐
│  Users  │
└────┬────┘
     │
┌────▼────────────┐
│  E-Commerce     │
│     System      │
└────┬────────────┘
     │
┌────▼────┐  ┌─────┐
│Payment  │  │Email│
│Gateway  │  │Svc  │
└─────────┘  └─────┘
```

### Level 2: Container Diagram

**Shows:**
- Applications
- Databases
- File systems

```
┌─────────────┐
│  Web App    │
└──────┬──────┘
       │
   ┌───┴───┬────────┬────────┐
   │       │        │        │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌───▼──┐
│ API │ │Auth │ │Order│ │Email │
│ Svc │ │ Svc │ │ Svc │ │ Svc  │
└──┬──┘ └──┬──┘ └──┬──┘ └──┬───┘
   │       │        │       │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐
│Postg│ │Redis│ │SQS  │
│res  │ │     │ │     │
└─────┘ └─────┘ └─────┘
```

### Level 3: Component Diagram

**Shows:**
- Components within container
- Relationships
- Technologies

### Level 4: Code Diagram

**Shows:**
- Classes
- Functions
- Implementation details

## Best Practices

1. **Start with context** - System context first
2. **Use consistent notation** - Standard symbols
3. **Keep it simple** - Don't over-complicate
4. **Update regularly** - Keep current
5. **Use tools** - Structurizr, Draw.io
6. **Document decisions** - Link to ADRs
7. **Multiple views** - Different perspectives
8. **Team collaboration** - Shared understanding

## Conclusion

The C4 model enables:
- Clear documentation
- Multiple abstraction levels
- Team alignment
- Maintainable diagrams

Start with system context, then drill down. The model shown here documents production architectures effectively.

---

*C4 Model from January 2022, covering architecture visualization.*

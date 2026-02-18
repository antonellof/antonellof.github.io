---
layout: post
title: "Backend for Frontend (BFF) Pattern"
date: 2022-04-07
categories: [Architecture]
tags: [BFF, Architecture, Microservices]
excerpt: "Implement the Backend for Frontend pattern: dedicated API layers for each client, aggregation, transformation, and when to use BFF in microservices architectures."
---

BFF provides dedicated backends for each frontend. After implementing BFFs in production, here's how to use the pattern effectively.

## What is BFF?

BFF:
- **Dedicated backend** - Per frontend/client
- **Aggregation** - Combines microservices
- **Transformation** - Adapts data format
- **Optimization** - Client-specific optimizations

## Architecture

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│  Web App │  │ Mobile   │  │  Admin   │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
┌────▼─────┐  ┌───▼────┐  ┌─────▼────┐
│  Web BFF │  │Mobile  │  │ Admin    │
│          │  │  BFF   │  │   BFF    │
└────┬─────┘  └───┬────┘  └─────┬────┘
     │            │             │
     └────────────┼──────────────┘
                  │
     ┌────────────┼────────────┐
     │            │            │
┌────▼──┐  ┌─────▼──┐  ┌─────▼──┐
│ User  │  │ Order  │  │ Payment│
│ Svc   │  │ Svc    │  │ Svc    │
└───────┘  └────────┘  └────────┘
```

## Implementation

### Web BFF

```javascript
// Web BFF - Optimized for web
app.get('/api/dashboard', async (req, res) => {
    const [user, orders, recommendations] = await Promise.all([
        userService.getUser(req.userId),
        orderService.getUserOrders(req.userId),
        recommendationService.getRecommendations(req.userId)
    ]);
    
    res.json({
        user: {
            name: user.name,
            email: user.email,
            avatar: user.avatar
        },
        orders: orders.map(o => ({
            id: o.id,
            total: o.total,
            status: o.status
        })),
        recommendations: recommendations
    });
});
```

### Mobile BFF

```javascript
// Mobile BFF - Optimized for mobile
app.get('/api/dashboard', async (req, res) => {
    // Minimal data for mobile
    const [user, recentOrders] = await Promise.all([
        userService.getUser(req.userId),
        orderService.getRecentOrders(req.userId, 5)
    ]);
    
    res.json({
        user: {
            name: user.name
        },
        recentOrders: recentOrders.map(o => ({
            id: o.id,
            total: o.total
        }))
    });
});
```

## Benefits

- **Client optimization** - Tailored for each client
- **Reduced complexity** - Frontend simplicity
- **Independent evolution** - Client-specific changes
- **Performance** - Optimized data transfer

## Best Practices

1. **One BFF per client** - Clear boundaries
2. **Aggregate efficiently** - Parallel requests
3. **Cache appropriately** - Client-specific caching
4. **Handle errors** - Graceful degradation
5. **Monitor separately** - Per-BFF metrics
6. **Version APIs** - Client compatibility
7. **Document contracts** - Clear interfaces
8. **Test thoroughly** - Client-specific tests

## Conclusion

BFF pattern enables:
- Client optimization
- Simplified frontends
- Independent evolution
- Better performance

Use BFF when clients have different needs. The pattern shown here optimizes for each client type.

---

*Backend for Frontend pattern from April 2022, covering BFF architecture and implementation.*

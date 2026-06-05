---
layout: post
title: "Backend for Frontend (BFF) Pattern"
date: 2022-04-07
categories: [Architecture]
tags: [BFF, Architecture, Microservices]
excerpt: "Our mobile app was downloading 2MB of JSON to show a dashboard with three numbers. The web app needed completely different data from the same backend. One API cannot serve all masters."
---

The mobile team's complaint arrived in Slack on a Tuesday: "The dashboard endpoint returns 47 fields. We display 4. Can we get a mobile-specific API?"

The web team had the opposite problem. Their dashboard needed aggregated data from five microservices, and the frontend was making six API calls on page load—with cascading loading spinners that made the UX feel like dial-up.

The backend team pushed back. "We can't maintain separate APIs for every client. That's not scalable."

Everyone was right. Everyone was also stuck.

That's the moment we introduced a **Backend for Frontend (BFF)** layer—and it solved problems that neither "one API to rule them all" nor "let the frontend figure it out" could handle.

## What Is a BFF?

The [Backend for Frontend pattern](https://samnewman.io/patterns/architectural/bff/), popularized by Sam Newman, gives each client type its own dedicated backend layer:

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│  Web App │  │ Mobile   │  │  Admin   │
│  [React] │  │  [iOS]   │  │  [React] │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
┌────▼─────┐  ┌───▼────┐  ┌─────▼────┐
│  Web BFF │  │Mobile  │  │ Admin    │
│  [Node]  │  │  BFF   │  │   BFF    │
│          │  │ [Go]   │  │  [Node]  │
└────┬─────┘  └───┬────┘  └─────┬─────┘
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

Each BFF:
- **Aggregates** data from multiple microservices into one response
- **Transforms** data into the shape each client needs
- **Optimizes** for client-specific constraints (bandwidth, screen size, offline support)
- **Owns** client-specific logic that doesn't belong in domain services

The BFF is not a general-purpose API. It's a dedicated backend for a specific frontend experience.

## Why Not Just Use the API Gateway?

Fair question. We had an API gateway. It handled authentication, rate limiting, and routing. Why add another layer?

Because API gateways are **cross-cutting infrastructure**. BFFs are **client-specific application logic**.

| Concern | API Gateway | BFF |
|---------|-------------|-----|
| Authentication | ✅ | Delegates to gateway |
| Rate limiting | ✅ | Client-specific limits |
| Routing | ✅ | Client-specific aggregation |
| Data transformation | ❌ | ✅ |
| Client-specific caching | ❌ | ✅ |
| Response shaping | ❌ | ✅ |

The gateway answers: "Is this request allowed, and where does it go?"
The BFF answers: "What does this specific client need, and how do I assemble it?"

Trying to put aggregation logic in the gateway turns it into a distributed monolith. I've seen this movie. It doesn't end well.

## A Real Example: Dashboard Endpoints

Same feature—user dashboard—three completely different implementations.

### Web BFF: Rich, Aggregated

Web users are on broadband. They expect rich data, charts, and detailed order history.

```javascript
// web-bff/routes/dashboard.js
app.get('/api/dashboard', authenticate, async (req, res) => {
    const userId = req.user.id;
    
    // Parallel fetch from microservices
    const [user, orders, recommendations, notifications, stats] = await Promise.all([
        userService.getUser(userId),
        orderService.getUserOrders(userId, { limit: 20, includeItems: true }),
        recommendationService.getRecommendations(userId, { count: 8 }),
        notificationService.getUnread(userId),
        analyticsService.getUserStats(userId),
    ]);
    
    // Shape response for web UI components
    res.json({
        user: {
            name: user.name,
            email: user.email,
            avatar: user.avatarUrl,
            memberSince: user.createdAt,
        },
        orders: orders.map(order => ({
            id: order.id,
            date: order.createdAt,
            total: formatCurrency(order.total),
            status: order.status,
            itemCount: order.items.length,
            items: order.items.map(item => ({
                name: item.name,
                thumbnail: item.imageUrl,
                price: formatCurrency(item.price),
            })),
        })),
        recommendations: recommendations.map(rec => ({
            id: rec.productId,
            name: rec.name,
            price: formatCurrency(rec.price),
            image: rec.imageUrl,
            reason: rec.reason,  // "Because you bought X"
        })),
        notifications: {
            unreadCount: notifications.length,
            recent: notifications.slice(0, 5),
        },
        stats: {
            totalOrders: stats.orderCount,
            totalSpent: formatCurrency(stats.lifetimeValue),
            favoriteCategory: stats.topCategory,
        },
    });
});
```

Response size: ~45KB. Acceptable for web.

### Mobile BFF: Minimal, Battery-Aware

Mobile users are on cellular. Battery matters. They need quick glances, not comprehensive data.

```javascript
// mobile-bff/routes/dashboard.js
app.get('/api/v2/dashboard', authenticate, async (req, res) => {
    const userId = req.user.id;
    
    // Fetch only what mobile displays
    const [user, recentOrders, unreadCount] = await Promise.all([
        userService.getUser(userId),
        orderService.getRecentOrders(userId, { limit: 3 }),  // Not 20
        notificationService.getUnreadCount(userId),           // Count only, not items
    ]);
    
    res.json({
        user: {
            firstName: user.name.split(' ')[0],  // "Hi, Sarah" not full name
            avatar: user.avatarUrl,
        },
        orders: recentOrders.map(order => ({
            id: order.id,
            total: order.total,           // Raw number, mobile formats locally
            status: order.status,
            date: order.createdAt,
        })),
        unreadNotifications: unreadCount,
    });
});
```

Response size: ~2KB. Down from 45KB. Mobile team's complaint resolved.

### Admin BFF: Operational Detail

Admin users need everything—audit trails, internal IDs, debug info that consumer clients should never see.

```javascript
// admin-bff/routes/dashboard.js
app.get('/api/admin/users/:userId/overview', authorize('admin'), async (req, res) => {
    const { userId } = req.params;
    
    const [user, orders, payments, supportTickets, auditLog] = await Promise.all([
        userService.getUser(userId, { includeInternal: true }),
        orderService.getUserOrders(userId, { includeAll: true }),
        paymentService.getPaymentHistory(userId),
        supportService.getTickets(userId),
        auditService.getRecentActions(userId),
    ]);
    
    res.json({
        user: {
            ...user,  // Full user object including internal fields
            internalNotes: user.adminNotes,
            riskScore: user.riskScore,
        },
        orders,
        payments,
        supportTickets,
        auditLog,
        _meta: {
            fetchedAt: new Date().toISOString(),
            services: {
                user: user._serviceVersion,
                orders: orders._serviceVersion,
            },
        },
    });
});
```

Same underlying microservices. Three purpose-built APIs. Each client gets exactly what it needs.

## When to Use BFF

BFF isn't free—it adds deployment units, operational overhead, and code to maintain. Use it when the pain of *not* having it exceeds the cost of building it.

**Good candidates:**
- Multiple client types with different data needs (web, mobile, admin, partner API)
- Frontend teams waiting on backend changes for UI-specific aggregation
- Mobile bandwidth constraints requiring response optimization
- GraphQL isn't an option (team skill, infrastructure, or complexity reasons)

**Skip BFF when:**
- Single client type with uniform needs
- Microservices already expose well-designed, client-ready APIs
- Team is too small to maintain additional services (honestly assess this)
- GraphQL with proper resolvers solves your aggregation needs

## Implementation Patterns

### Error Handling and Graceful Degradation

When one microservice fails, don't fail the entire dashboard:

```javascript
async function safeFetch(promise, fallback = null) {
    try {
        return await promise;
    } catch (error) {
        logger.warn('Microservice call failed', { error: error.message });
        metrics.increment('bff.partial_failure');
        return fallback;
    }
}

app.get('/api/dashboard', async (req, res) => {
    const [user, orders, recommendations] = await Promise.all([
        userService.getUser(req.userId),  // Required—fail if this fails
        safeFetch(orderService.getUserOrders(req.userId), []),
        safeFetch(recommendationService.getRecommendations(req.userId), []),
    ]);
    
    if (!user) {
        return res.status(503).json({ error: 'User service unavailable' });
    }
    
    res.json({
        user,
        orders,
        recommendations,
        _degraded: recommendations.length === 0 && orders.length === 0,
    });
});
```

The dashboard loads with partial data rather than a blank error screen. Users notice missing recommendations. They abandon apps that show spinners forever.

### Caching Strategy

BFFs are natural caching points—they know what each client needs and how fresh it needs to be:

```javascript
const cache = new Redis(process.env.REDIS_URL);

app.get('/api/dashboard', async (req, res) => {
    const cacheKey = `dashboard:web:${req.user.id}`;
    
    const cached = await cache.get(cacheKey);
    if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(JSON.parse(cached));
    }
    
    const data = await buildDashboard(req.user.id);
    
    // Web dashboard: cache for 60 seconds
    await cache.setex(cacheKey, 60, JSON.stringify(data));
    res.set('X-Cache', 'MISS');
    res.json(data);
});
```

Different TTLs per client type:
- **Web:** 60 seconds (users tolerate slight staleness)
- **Mobile:** 300 seconds (reduce cellular requests, support offline-ish behavior)
- **Admin:** 0 seconds (operational data must be fresh)

### BFF Team Ownership

Who owns the BFF? This matters more than the code.

**Option A: Frontend team owns their BFF.** Web team owns Web BFF. Mobile team owns Mobile BFF. Backend team owns microservices. Clean boundaries, frontend teams aren't blocked.

**Option B: Backend team owns all BFFs.** Works if backend team understands client needs deeply. Often becomes a bottleneck.

**Option C: Full-stack product teams.** Each product team owns frontend + BFF + relevant microservices. Best for larger orgs with mature team structures.

We went with Option A. Frontend teams could ship UI changes without waiting for a central API team. Backend teams focused on domain services, not presentation logic.

## Anti-Patterns to Avoid

**The BFF that becomes a monolith.** If your BFF has business logic, validation rules, and database access, it's not a BFF—it's a monolith wearing a costume. BFFs orchestrate and transform. Domain logic stays in domain services.

**One BFF per developer preference.** Three BFFs for three clients: good. Seven BFFs because teams couldn't agree: operational nightmare.

**Leaking BFF internals to clients.** The BFF response shape is a contract. Version it. Don't break mobile apps because the web team wanted a field renamed.

**Skipping authentication at the BFF.** The BFF should validate tokens and permissions. Don't trust that the API gateway did it—defense in depth.

```javascript
// BFF validates even though gateway already did
app.use(async (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        req.user = await authService.verifyToken(token);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
});
```

## BFF vs. GraphQL vs. API Composition

People often ask how BFF compares to alternatives:

**GraphQL:** Single endpoint, client specifies fields. Great for flexible clients, but adds complexity (schema, resolvers, N+1 problems, caching challenges). BFF is simpler when client needs are stable and well-defined.

**API Composition (Netflix-style):** Similar to BFF but often a shared layer rather than per-client. Can become a bottleneck. BFF distributes ownership to client teams.

**Direct microservice access from frontend:** Works for small apps. Falls apart with aggregation, auth complexity, and client-specific optimization needs.

There's no universal winner. We used BFF because our mobile and web needs diverged significantly, and our team was more comfortable with REST than GraphQL.

## Monitoring and Observability

Each BFF needs its own metrics—don't lump them together:

```javascript
// Track per-BFF, per-endpoint metrics
metrics.timing('bff.web.dashboard.latency', duration);
metrics.timing('bff.web.dashboard.user_service.latency', userServiceDuration);
metrics.timing('bff.web.dashboard.order_service.latency', orderServiceDuration);

// Alert on partial failures
if (degradedResponse) {
    metrics.increment('bff.web.dashboard.degraded');
}
```

Dashboards I watch:
- End-to-end BFF latency (p50, p95, p99)
- Per-microservice latency from BFF perspective
- Partial failure rate
- Cache hit ratio
- Response size distribution (especially for mobile)

When mobile dashboard p99 latency spikes, I can immediately see whether it's the BFF, the order service, or cache invalidation.

## Conclusion

The BFF pattern exists because **different clients have different needs**, and forcing one API to serve everyone creates either bloated responses or frontend complexity that doesn't belong there.

Our mobile team's 47-field complaint? Resolved with a 2KB mobile-specific endpoint. The web team's six API calls? One aggregated BFF call. The backend team's scalability concern? Valid—but BFFs don't replace microservices, they sit in front of them.

Start with one BFF for your most painful client. Measure the improvement. Add others when the pain justifies the operational cost. And for the love of all that is holy, don't put business logic in the BFF—transform and aggregate, don't duplicate domain rules.

**Further Resources:**
- [Backend for Frontend Pattern](https://samnewman.io/patterns/architectural/bff/) — Sam Newman's original writeup
- [Building Microservices](https://samnewman.io/books/building_microservices/) — Comprehensive BFF coverage
- [GraphQL vs BFF](https://www.apollographql.com/blog/backend-for-frontend/) — When to choose which
- [Microsoft: BFF Pattern](https://docs.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends) — Azure architecture guide

---

*Backend for Frontend pattern from April 2022, covering BFF architecture and implementation.*

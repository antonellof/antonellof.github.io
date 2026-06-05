---
layout: post
title: "Strangler Fig Pattern: Refactoring Legacy Systems"
date: 2022-11-10
categories: [Architecture]
tags: [Strangler Fig, Refactoring, Legacy Systems]
excerpt: "The legacy monolith couldn't be rewritten in a big bang—we tried, failed, and shipped nothing for eight months. The Strangler Fig pattern let us replace it piece by piece while revenue kept flowing."
---

The project was called "Phoenix." Catchy name. Ambitious scope: rewrite the entire order management monolith as microservices. Timeline: nine months. Team: twelve engineers.

Month eight, we had impressive architecture diagrams, a Kubernetes cluster running idle, and zero production traffic on the new system. The monolith still processed every order. Leadership was asking uncomfortable questions. The team was demoralized.

We cancelled Phoenix and started Strangler—less catchy name, less ambitious scope, but actually shippable. Instead of replacing the monolith in one heroic rewrite, we'd **strangle it incrementally**—routing individual features to new services while the old system kept running.

Eighteen months later, the monolith was gone. Not because we rewrote it, but because we **replaced it one feature at a time** until nothing was left.

That's the [Strangler Fig pattern](https://martinfowler.com/bliki/StranglerFigApplication.html), and it's the only legacy migration strategy I've seen work consistently at scale.

## The Pattern: Named After a Tree

In nature, strangler figs grow around host trees, eventually replacing them entirely. In software, you build new functionality around legacy systems, gradually routing traffic away until the old system can be decommissioned.

```
Phase 1: Legacy Only
┌─────────────────────────────────────┐
│           Legacy Monolith           │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  │
│  │Users│ │Orders│ │Pay  │ │Ship │  │
│  └─────┘ └─────┘ └─────┘ └─────┘  │
└─────────────────────────────────────┘

Phase 2: Strangling Begins
                    ┌─────────────┐
                    │  New User   │
                    │   Service   │
                    └──────┬──────┘
                           │
┌──────────────────────────┼──────────┐
│      Legacy Monolith     │          │
│  ┌─────┐ ┌─────┐ ┌─────┐ │ ┌─────┐ │
│  │Users│ │Orders│ │Pay  │ │Ship │ │
│  │(old)│ └─────┘ └─────┘ │ └─────┘ │
│  └─────┘                  │         │
└──────────────────────────┼──────────┘
                           │
                    ┌──────▼──────┐
                    │   Router/   │
                    │   Facade    │
                    └─────────────┘

Phase 3: Mostly New
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  New User   │ │  New Order  │ │  New Pay    │
│   Service   │ │   Service   │ │   Service   │
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
              ┌────────▼────────┐
              │  Legacy Monolith│
              │  (Shipping only)│
              └─────────────────┘

Phase 4: Legacy Gone
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  New User   │ │  New Order  │ │  New Pay    │ │  New Ship   │
│   Service   │ │   Service   │ │   Service   │ │   Service   │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

The monolith shrinks until it's empty. No big bang. No risky cutover weekend. No "turn off the old system and pray."

## Why Big Bang Rewrites Fail

I've seen the pattern enough times to recognize it:

1. **Underestimate complexity.** The monolith has ten years of edge cases. "It's just CRUD" lies.
2. **Feature freeze on old system.** Business can't wait. New requirements go to the old system, creating dual maintenance.
3. **Integration surprises.** The monolith talks to seventeen external systems. Each integration has quirks undocumented anywhere.
4. **Scope creep.** "While we're rewriting, let's also fix X, Y, and Z."
5. **No production feedback.** New system isn't battle-tested until cutover. Cutover reveals problems.
6. **Team fatigue.** Month six of no production impact demoralizes everyone.

Strangler Fig avoids all of these by shipping to production continuously.

## The Facade: Your Migration Control Point

The strangler pattern requires a **facade** (also called a router or ambassador) that sits in front of both old and new systems:

```javascript
// facade/router.js
class MigrationRouter {
    constructor(oldSystem, newServices, featureFlags) {
        this.oldSystem = oldSystem;
        this.newServices = newServices;
        this.featureFlags = featureFlags;
    }
    
    async handleRequest(req) {
        const feature = this.detectFeature(req);
        const route = await this.getRoute(feature, req);
        
        switch (route) {
            case 'new':
                return this.routeToNew(feature, req);
            case 'old':
                return this.routeToOld(req);
            case 'both':
                return this.parallelRun(feature, req);
            default:
                return this.routeToOld(req);
        }
    }
    
    detectFeature(req) {
        // Map request to feature domain
        if (req.path.startsWith('/api/users')) return 'user-management';
        if (req.path.startsWith('/api/orders')) return 'order-processing';
        if (req.path.startsWith('/api/payments')) return 'payment';
        return 'unknown';
    }
    
    async getRoute(feature, req) {
        // Check feature flags for routing decision
        const migrationState = await this.featureFlags.get(`migration.${feature}`);
        
        switch (migrationState) {
            case 'complete':
                return 'new';
            case 'shadow':
                return 'both';  // Parallel run for validation
            case 'partial':
                // Percentage rollout
                const percentage = await this.featureFlags.get(`migration.${feature}.percentage`);
                return Math.random() * 100 < percentage ? 'new' : 'old';
            default:
                return 'old';
        }
    }
}
```

The facade is your migration control panel. Route traffic without changing clients. Roll back instantly by flipping a flag.

## Migration Phases in Practice

### Phase 1: Intercept (Build the Facade)

Before migrating any feature, build the routing layer:

```javascript
// Start simple: all traffic to old system
app.use('/api/*', (req, res, next) => {
    // Log request for later analysis
    migrationMetrics.record(req.path, req.method);
    next();
});

// Proxy all requests to monolith
app.use('/api/*', createProxyMiddleware({
    target: 'http://legacy-monolith:8080',
    changeOrigin: true,
}));
```

This buys you observability. You now know exactly which endpoints exist, how often they're called, and what the traffic patterns look like. Essential for prioritizing migration order.

### Phase 2: Migrate One Feature (Prove the Pattern)

Pick the **smallest, most isolated feature** for your first migration. Not the most painful—that comes later. The easiest win to prove the pattern works.

We started with user profile reads—not writes, not auth, just GET `/api/users/:id`. Low risk, high traffic, simple data model.

```javascript
// Feature flag configuration
const migrationConfig = {
    'user-management': {
        state: 'partial',
        percentage: 5,  // Start with 5%
        endpoints: {
            'GET /api/users/:id': 'new',
            'PUT /api/users/:id': 'old',  // Writes still on old system
            'POST /api/users': 'old',
        }
    }
};
```

Week 1: 5% of user reads go to new service. Monitor error rates, latency, data consistency.
Week 2: 25% if metrics look good.
Week 3: 50%.
Week 4: 100% for reads.

Each week, production validated the new service. Problems surfaced with 5% traffic, not 100%.

### Phase 3: Shadow Mode (Validate Before Committing)

For high-risk features, run both systems in parallel:

```javascript
async parallelRun(feature, req) {
    const [oldResult, newResult] = await Promise.allSettled([
        this.routeToOld(req),
        this.routeToNew(feature, req),
    ]);
    
    // Compare results
    if (oldResult.status === 'fulfilled' && newResult.status === 'fulfilled') {
        const match = this.compareResults(oldResult.value, newResult.value);
        
        if (!match) {
            migrationMetrics.recordMismatch(feature, {
                old: oldResult.value,
                new: newResult.value,
                request: req.path,
            });
        }
    }
    
    // Always return old result (safe)
    if (oldResult.status === 'fulfilled') {
        return oldResult.value;
    }
    throw oldResult.reason;
}

compareResults(old, new) {
    // Normalize and compare
    const normalizedOld = this.normalize(old);
    const normalizedNew = this.normalize(new);
    return JSON.stringify(normalizedOld) === JSON.stringify(normalizedNew);
}
```

Users get responses from the old system. New system runs in shadow. Mismatches get logged for investigation. Zero user impact while validating correctness.

We found forty-seven edge cases in payment processing this way—rounding differences, currency handling quirks, timeout behaviors the spec didn't mention. All caught before switching traffic.

### Phase 4: Complete Migration (Retire the Feature from Monolith)

Once a feature runs 100% on new infrastructure for a stable period:

1. Remove routing logic for that feature (always route to new)
2. Delete the old code from the monolith
3. Archive or drop the old database tables
4. Update documentation
5. Celebrate (seriously—migration fatigue is real)

```javascript
// After user-management migration complete
const migrationConfig = {
    'user-management': {
        state: 'complete',  // No more routing decisions
    },
    'order-processing': {
        state: 'partial',
        percentage: 30,
    },
    // ...
};
```

The monolith shrinks. Team morale improves with each retirement.

## Choosing Migration Order

Not all features are equal candidates. I prioritize using this matrix:

```
                    Low Complexity    High Complexity
                 ┌─────────────────┬─────────────────┐
    High Value   │   DO SECOND     │   DO LAST       │
                 │   (Core features│   (Critical but │
                 │    after proof) │    complex)     │
                 ├─────────────────┼─────────────────┤
    Low Value    │   DO FIRST      │   DO NEVER      │
                 │   (Prove pattern│   (Not worth it)│
                 │    low risk)    │                 │
                 └─────────────────┴─────────────────┘
```

**First migrations:** Low value, low complexity. User profile reads, notification preferences, static configuration.

**Second wave:** High value, manageable complexity. Order creation, payment processing (with shadow mode).

**Last migrations:** High complexity core features. Reporting, batch jobs, integrations with weird external systems.

**Never migrate:** Features scheduled for deprecation. Don't strangler fig code you're going to delete anyway.

## Data Migration: The Hard Part

Routing traffic is easy. Migrating data is where strangler fig gets painful.

### Dual Write Period

During migration, write to both systems:

```javascript
async function createOrder(orderData) {
    const oldOrder = await legacyDb.orders.create(orderData);
    
    try {
        const newOrder = await newOrderService.create({
            ...orderData,
            legacyId: oldOrder.id,  // Cross-reference
        });
        
        // Store mapping for reads during transition
        await mappingTable.insert({
            legacyId: oldOrder.id,
            newId: newOrder.id,
        });
        
        return newOrder;
    } catch (error) {
        // New system failed, but old system succeeded
        // Queue for retry, don't fail the user request
        await retryQueue.add('sync-order', { legacyId: oldOrder.id });
        return oldOrder;
    }
}
```

Dual writes are messy but necessary. Run them until you're confident, then cut over to new-system-only writes.

### Read Routing with Data Mapping

During transition, reads might hit either system:

```javascript
async function getOrder(orderId) {
    // Check if this is a new-system ID or legacy ID
    const mapping = await mappingTable.findByEitherId(orderId);
    
    if (mapping) {
        // Exists in both—prefer new system
        return newOrderService.getById(mapping.newId);
    }
    
    // Check legacy system
    const legacyOrder = await legacyDb.orders.findById(orderId);
    if (legacyOrder) {
        return legacyOrder;
    }
    
    throw new NotFoundError();
}
```

### Eventual Consistency Acceptance

During migration, perfect consistency is impossible. Accept it:

- Reads might be slightly stale during dual-write periods
- Shadow mode catches mismatches but doesn't prevent them
- Reconciliation jobs fix drift overnight

Communicate this to stakeholders. "Migration in progress" is a valid state.

## Monitoring Migration Progress

Track migration like a product launch:

```javascript
// Migration dashboard metrics
const migrationMetrics = {
    // Traffic routing
    'migration.requests.routed': { tags: ['feature', 'destination'] },
    
    // Shadow mode comparison
    'migration.shadow.mismatch': { tags: ['feature'] },
    'migration.shadow.match': { tags: ['feature'] },
    
    // Error rates by destination
    'migration.errors': { tags: ['feature', 'destination'] },
    
    // Latency comparison
    'migration.latency': { tags: ['feature', 'destination'] },
    
    // Progress
    'migration.features.complete': { type: 'gauge' },
    'migration.features.in_progress': { type: 'gauge' },
    'migration.features.remaining': { type: 'gauge' },
};
```

Dashboard showing:
- Features migrated vs. remaining
- Current traffic split per feature
- Shadow mode mismatch rate
- Error rate comparison (old vs. new)

Review weekly with stakeholders. Visible progress prevents "are we still working on this?" conversations.

## Rollback: Always Have an Escape Hatch

Every migration step must be reversible in minutes, not hours:

```javascript
// Instant rollback via feature flag
async function rollbackFeature(feature) {
    await featureFlags.set(`migration.${feature}.state`, 'old');
    await featureFlags.set(`migration.${feature}.percentage`, 0);
    
    // Alert the team
    await slack.notify(`#migrations`, 
        `⏪ Rolled back ${feature} to legacy system`
    );
    
    // Log for post-mortem
    migrationLog.record('rollback', { feature, reason, timestamp: Date.now() });
}
```

We rolled back payment processing twice during migration—both times via feature flag, both times resolved within five minutes, zero customer impact. Rollback capability is non-negotiable.

## What We Learned From Phoenix's Ashes

The big bang rewrite taught us what not to do. Strangler fig taught us what works:

| Big Bang (Phoenix) | Strangler Fig |
|--------------------|---------------|
| 8 months, zero production impact | First feature in production week 3 |
| All-or-nothing cutover | Incremental traffic shifting |
| No rollback possible | Feature flag rollback in minutes |
| Team demoralized by lack of progress | Weekly wins, visible progress |
| Edge cases discovered at cutover | Shadow mode catches issues early |
| Business blocked on new features | New features ship to new services |

The monolith that Phoenix couldn't replace in nine months? Strangler fig retired it in eighteen—with continuous production traffic and no major incidents.

## Conclusion

Legacy system migration isn't a technical problem—it's a risk management problem. Big bang rewrites concentrate risk into a single catastrophic moment. Strangler fig distributes risk across months of small, reversible steps.

Build the facade first. Migrate the easiest feature to prove the pattern. Use shadow mode for validation. Dual-write during data migration. Monitor everything. Roll back freely.

The legacy system won't disappear in a dramatic rewrite montage. It'll fade away, feature by feature, until someone asks "do we still need this monolith?" and the answer is "what monolith?"

**Further Resources:**
- [Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html) — Martin Fowler's original pattern
- [Monolith to Microservices](https://samnewman.io/books/monolith-to-microservices/) — Sam Newman's migration guide
- [Working Effectively with Legacy Code](https://www.oreilly.com/library/view/working-effectively-with/0131177052/) — Michael Feathers
- [Feature Toggles](https://martinfowler.com/articles/feature-toggles.html) — Migration flag patterns
- [Branch by Abstraction](https://martinfowler.com/bliki/BranchByAbstraction.html) — Complementary pattern

---

*Strangler Fig pattern from November 2022, covering gradual migration strategies.*

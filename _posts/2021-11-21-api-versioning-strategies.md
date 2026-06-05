---
layout: post
title: "API Versioning Strategies: Best Practices"
date: 2021-11-21
categories: [Architecture]
tags: [API, Versioning, Best Practices]
excerpt: "Breaking changes are inevitable. Angry users are optional. API versioning isn't about /v1 vs /v2 in the URL—it's about a migration story that doesn't leave integrators behind."
---

We shipped a "small improvement" to our user API. Renamed `name` to `fullName`. Removed the deprecated `username` field. Changed date format from Unix timestamps to ISO 8601. All reasonable changes. All breaking for the 200 integrations we didn't know about.

Three enterprise customers opened tickets within hours. Two mobile apps stopped working. A partner integration had been parsing our JSON with a regex. We rolled back, apologized, and started versioning properly.

Breaking changes are inevitable. Angry users are optional. API versioning is the contract that lets you evolve without surprise.

## Versioning Strategies

### URL Path Versioning (Most Common)

```javascript
app.get('/api/v1/users', handleV1Users);
app.get('/api/v2/users', handleV2Users);
```

```
GET /api/v1/users/123  →  { "name": "Alice" }
GET /api/v2/users/123  →  { "fullName": "Alice", "displayName": "alice" }
```

**Pros:** Obvious, cacheable, easy to route, easy to document, easy to test.

**Cons:** "Not RESTful" purists complain. URL changes per version (but that's the point).

This is my default. Clarity beats purity.

### Header Versioning

```javascript
app.get('/api/users', (req, res) => {
    const version = req.headers['api-version'] || '1';
    
    switch (version) {
        case '2': return handleV2(req, res);
        default: return handleV1(req, res);
    }
});
```

```
GET /api/users/123
Accept: application/vnd.myapi.v2+json
```

**Pros:** Clean URLs. Same endpoint, different representations.

**Cons:** Invisible in browser address bar. Harder to test (need header tools). CDN/proxy caching complications. Easy to forget the header.

Good for APIs where URL stability matters more than simplicity.

### Query Parameter Versioning

```javascript
app.get('/api/users', (req, res) => {
    const version = req.query.version || '1';
    // Route to handler
});
```

```
GET /api/users/123?version=2
```

**Pros:** Easy to test in browser. No header magic.

**Cons:** Feels hacky. Caching issues (different URLs... sort of). Query params get lost in redirects.

I avoid this unless there's a specific reason. URL path versioning is cleaner.

### Content Negotiation (Accept Header)

```javascript
app.get('/api/users', (req, res) => {
    const accept = req.headers['accept'] || '';
    if (accept.includes('vnd.myapi.v2')) {
        return handleV2(req, res);
    }
    return handleV1(req, res);
});
```

Academically correct. Practically annoying. Nobody does this except APIs that enjoy support tickets.

## Semantic Versioning for APIs

```
MAJOR.MINOR.PATCH

v1.0.0  — Initial release
v1.1.0  — New endpoints, new optional fields (backward compatible)
v1.1.1  — Bug fixes (backward compatible)
v2.0.0  — Breaking changes
```

**Breaking changes (require MAJOR bump):**
- Removing fields or endpoints
- Changing field types
- Changing response structure
- Changing authentication method
- Changing error response format

**Non-breaking (MINOR bump):**
- Adding new endpoints
- Adding optional request fields
- Adding new response fields
- Adding new enum values

**Bug fixes (PATCH):**
- Fixing incorrect behavior that clients shouldn't have depended on

```javascript
const versions = {
    '1': require('./handlers/v1'),
    '2': require('./handlers/v2'),
};

app.use('/api/v:version/users', (req, res, next) => {
    const handler = versions[req.params.version];
    if (!handler) {
        return res.status(404).json({ error: 'API version not supported' });
    }
    handler(req, res, next);
});
```

## Deprecation: The Art of Letting Go

Don't kill old versions. Fade them out:

```javascript
app.get('/api/v1/users', (req, res) => {
    // RFC 8594 deprecation headers
    res.set('Deprecation', 'true');
    res.set('Sunset', 'Sat, 01 Jun 2024 00:00:00 GMT');
    res.set('Link', '</api/v2/users>; rel="successor-version"');
    
    return handleV1Users(req, res);
});
```

**Deprecation timeline I use:**
1. **Announce** — changelog, email, docs (3-6 months before sunset)
2. **Header warnings** — Deprecation + Sunset headers on old version
3. **Monitor usage** — track which clients still use v1
4. **Direct outreach** — contact high-traffic v1 consumers
5. **Sunset** — return 410 Gone or redirect to v2

```javascript
// After sunset date
app.get('/api/v1/users', (req, res) => {
    res.status(410).json({
        error: 'API v1 has been sunset',
        migration: 'https://docs.example.com/api/v2-migration',
        successor: '/api/v2/users'
    });
});
```

Never sunset without migration documentation. "We removed v1" is not a migration guide.

## Implementation Patterns

### Shared Logic, Different Serializers

```javascript
// Domain model (shared)
class User {
    constructor(id, firstName, lastName) {
        this.id = id;
        this.firstName = firstName;
        this.lastName = lastName;
    }
}

// V1 serializer
function toV1(user) {
    return {
        id: user.id,
        name: `${user.firstName} ${user.lastName}`,
    };
}

// V2 serializer
function toV2(user) {
    return {
        id: user.id,
        fullName: `${user.firstName} ${user.lastName}`,
        firstName: user.firstName,
        lastName: user.lastName,
    };
}
```

Same business logic. Different response shapes. Don't duplicate service layers per version.

### Version Adapters for Requests

```javascript
function normalizeCreateUserRequest(body, version) {
    if (version === '1') {
        return { firstName: body.name.split(' ')[0], lastName: body.name.split(' ').slice(1).join(' ') };
    }
    return { firstName: body.firstName, lastName: body.lastName };
}
```

Accept old request formats, normalize to current domain model internally.

## Documentation and Communication

- **Changelog per version** — what changed, when, why
- **Migration guides** — step-by-step v1 → v2
- **API reference per version** — don't mix v1 and v2 docs on one page
- **Breaking change policy** — published, predictable (e.g., "major versions annually")
- **Client SDK versioning** — npm package `@company/api-client-v2`

## Monitoring Version Adoption

```javascript
// Middleware to track version usage
app.use('/api/:version/*', (req, res, next) => {
    metrics.increment('api.request', { version: req.params.version });
    next();
});
```

Dashboard showing v1 vs v2 traffic. Don't sunset v1 while 40% of traffic still uses it.

## Common Mistakes

1. **No versioning from day one** — "we'll add it when we need it" means v1 is already broken
2. **Breaking changes in minor versions** — destroys trust
3. **Sunsetting without notice** — enterprise customers have change management processes
4. **Duplicating entire codebase per version** — shared logic, different serializers
5. **No migration docs** — "just use v2" isn't documentation
6. **Too many versions** — support v1 and v2, not v1 through v5

## My Defaults

- **URL path versioning** (`/api/v1/`, `/api/v2/`)
- **Version from day one** (even if v1 is the only version)
- **6-month deprecation minimum** for breaking changes
- **Shared service layer** with version-specific serializers
- **Deprecation headers** 3 months before sunset
- **Monitor version traffic** before sunsetting

## Conclusion

The `name` → `fullName` change that broke 200 integrations taught us: your API is a contract with unknown counterparties. Some parse JSON with regex. Some haven't updated their client in three years. Some are your largest customers.

Versioning isn't bureaucracy—it's respect for the people integrating with your API. URL path versioning for clarity. Semantic versioning for expectations. Deprecation headers for warning. Migration guides for transition.

Ship v2. Keep v1 running. Monitor adoption. Sunset gracefully. Your future self—and your enterprise customers—will thank you when the next "small improvement" ships without a rollback.

---

*API versioning strategies from November 2021, covering URL, header, and semantic versioning.*

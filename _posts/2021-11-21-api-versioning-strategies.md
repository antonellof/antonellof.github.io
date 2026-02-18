---
layout: post
title: "API Versioning Strategies: Best Practices"
date: 2021-11-21
categories: [Architecture]
tags: [API, Versioning, Best Practices]
excerpt: "Implement API versioning: URL versioning, header versioning, semantic versioning, and migration strategies for maintaining backward compatibility."
---

API versioning maintains backward compatibility. After versioning production APIs, here are the strategies that work.

## Versioning Strategies

### URL Versioning

```javascript
// Version in URL path
GET /api/v1/users
GET /api/v2/users

// Express.js example
app.get('/api/v1/users', (req, res) => {
    // v1 implementation
});

app.get('/api/v2/users', (req, res) => {
    // v2 implementation
});
```

### Header Versioning

```javascript
// Version in Accept header
Accept: application/vnd.api+json;version=2

// Express.js example
app.get('/api/users', (req, res) => {
    const version = req.headers['accept']?.match(/version=(\d+)/)?.[1] || '1';
    
    if (version === '2') {
        // v2 implementation
    } else {
        // v1 implementation
    }
});
```

### Query Parameter

```javascript
// Version in query string
GET /api/users?version=2

app.get('/api/users', (req, res) => {
    const version = req.query.version || '1';
    // Route to appropriate version
});
```

## Semantic Versioning

### Version Format

```
MAJOR.MINOR.PATCH

v1.0.0 - Initial release
v1.1.0 - New features (backward compatible)
v1.1.1 - Bug fixes
v2.0.0 - Breaking changes
```

### Implementation

```javascript
const apiVersions = {
    '1.0.0': require('./v1/users'),
    '1.1.0': require('./v1.1/users'),
    '2.0.0': require('./v2/users'),
};

app.get('/api/users', (req, res) => {
    const version = req.headers['api-version'] || '1.0.0';
    const handler = apiVersions[version] || apiVersions['1.0.0'];
    handler(req, res);
});
```

## Migration Strategy

### Deprecation

```javascript
app.get('/api/v1/users', (req, res) => {
    res.set('Deprecation', 'true');
    res.set('Sunset', 'Mon, 01 Jan 2024 00:00:00 GMT');
    res.set('Link', '</api/v2/users>; rel="successor-version"');
    
    // v1 implementation
});
```

### Gradual Migration

```javascript
// Support both versions
app.get('/api/v1/users', handleV1);
app.get('/api/v2/users', handleV2);

// Redirect after deprecation period
app.get('/api/v1/users', (req, res) => {
    res.redirect(301, '/api/v2/users');
});
```

## Best Practices

1. **Version early** - From the start
2. **Document versions** - Clear changelog
3. **Deprecate gracefully** - Give notice
4. **Maintain compatibility** - Support old versions
5. **Monitor usage** - Track version adoption
6. **Plan migrations** - Clear timeline
7. **Test thoroughly** - Version compatibility
8. **Communicate changes** - Notify users

## Conclusion

API versioning enables:
- Backward compatibility
- Gradual migration
- Breaking changes
- User communication

Choose URL or header versioning based on your needs. The strategies shown here maintain production APIs.

---

*API versioning strategies from November 2021, covering URL, header, and semantic versioning.*

---
layout: post
title: "PostgreSQL Full-Text Search: Implementation Guide"
date: 2020-07-15
categories: [How-To]
tags: [PostgreSQL, Full-Text Search, Database]
excerpt: "Implement full-text search in PostgreSQL using tsvector, tsquery, GIN indexes, and ranking. Learn how to build fast, relevant search functionality."
---

PostgreSQL provides powerful full-text search capabilities. After implementing search in production, here's how to use it effectively.

## Full-Text Search Basics

### What is Full-Text Search?

Full-text search:
- Searches within text content
- Ranks results by relevance
- Supports multiple languages
- Fast with proper indexes

## Basic Usage

### to_tsvector

```sql
-- Convert text to searchable vector
SELECT to_tsvector('english', 'The quick brown fox jumps over the lazy dog');

-- Result: 'brown':3 'dog':9 'fox':4 'jump':5 'lazi':8 'quick':2
```

### to_tsquery

```sql
-- Convert search string to query
SELECT to_tsquery('english', 'fox & dog');

-- Result: 'fox' & 'dog'
```

### Basic Search

```sql
-- Simple search
SELECT title, content
FROM articles
WHERE to_tsvector('english', content) @@ to_tsquery('english', 'search term');
```

## Creating Search Indexes

### GIN Index

```sql
-- Create GIN index for fast search
CREATE INDEX articles_content_idx ON articles 
USING GIN(to_tsvector('english', content));

-- Search using index
SELECT title, content
FROM articles
WHERE to_tsvector('english', content) @@ to_tsquery('english', 'search term');
```

### Generated Column Index

```sql
-- Add generated column
ALTER TABLE articles 
ADD COLUMN content_search_vector tsvector 
GENERATED ALWAYS AS (to_tsvector('english', 
    coalesce(title, '') || ' ' || coalesce(content, '')
)) STORED;

-- Create index on generated column
CREATE INDEX articles_search_idx ON articles USING GIN(content_search_vector);

-- Search using generated column
SELECT title, content
FROM articles
WHERE content_search_vector @@ to_tsquery('english', 'search term');
```

## Ranking Results

### ts_rank

```sql
-- Rank results by relevance
SELECT 
    title,
    content,
    ts_rank(content_search_vector, query) AS rank
FROM articles,
     to_tsquery('english', 'search term') AS query
WHERE content_search_vector @@ query
ORDER BY rank DESC;
```

### ts_rank_cd

```sql
-- Use cover density ranking (better for phrases)
SELECT 
    title,
    content,
    ts_rank_cd(content_search_vector, query) AS rank
FROM articles,
     to_tsquery('english', 'search term') AS query
WHERE content_search_vector @@ query
ORDER BY rank DESC;
```

## Advanced Queries

### Phrase Search

```sql
-- Search for exact phrase
SELECT title, content
FROM articles
WHERE content_search_vector @@ phraseto_tsquery('english', 'quick brown fox');
```

### Prefix Matching

```sql
-- Search with prefix
SELECT title, content
FROM articles
WHERE content_search_vector @@ to_tsquery('english', 'search:*');
```

### Boolean Operators

```sql
-- AND operator
SELECT title, content
FROM articles
WHERE content_search_vector @@ to_tsquery('english', 'search & term');

-- OR operator
SELECT title, content
FROM articles
WHERE content_search_vector @@ to_tsquery('english', 'search | term');

-- NOT operator
SELECT title, content
FROM articles
WHERE content_search_vector @@ to_tsquery('english', 'search & !term');
```

## Multiple Fields Search

### Combined Search

```sql
-- Search across multiple fields
ALTER TABLE articles 
ADD COLUMN search_vector tsvector 
GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '')) ||
    to_tsvector('english', coalesce(content, '')) ||
    to_tsvector('english', coalesce(tags, ''))
) STORED;

CREATE INDEX articles_full_search_idx ON articles USING GIN(search_vector);

-- Search
SELECT title, content
FROM articles
WHERE search_vector @@ to_tsquery('english', 'search term');
```

### Weighted Search

```sql
-- Weight different fields
ALTER TABLE articles 
ADD COLUMN weighted_search_vector tsvector 
GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(tags, '')), 'C')
) STORED;

-- Search with weights
SELECT 
    title,
    content,
    ts_rank(weighted_search_vector, query) AS rank
FROM articles,
     to_tsquery('english', 'search term') AS query
WHERE weighted_search_vector @@ query
ORDER BY rank DESC;
```

## Highlighting Results

### ts_headline

```sql
-- Highlight search terms in results
SELECT 
    title,
    ts_headline('english', content, query, 'StartSel=<mark>, StopSel=</mark>') AS highlighted_content
FROM articles,
     to_tsquery('english', 'search term') AS query
WHERE content_search_vector @@ query;
```

## Language Support

### Multiple Languages

```sql
-- Detect and use appropriate language
CREATE FUNCTION make_search_vector(title text, content text)
RETURNS tsvector AS $$
BEGIN
    RETURN 
        to_tsvector('english', coalesce(title, '')) ||
        to_tsvector('english', coalesce(content, ''));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Or use simple configuration for multiple languages
SELECT to_tsvector('simple', 'The quick brown fox');
```

## Performance Optimization

### Partial Indexes

```sql
-- Index only published articles
CREATE INDEX articles_published_search_idx 
ON articles USING GIN(content_search_vector)
WHERE status = 'published';
```

### Limit Results

```sql
-- Limit and paginate results
SELECT 
    title,
    content,
    ts_rank(content_search_vector, query) AS rank
FROM articles,
     to_tsquery('english', 'search term') AS query
WHERE content_search_vector @@ query
ORDER BY rank DESC
LIMIT 20
OFFSET 0;
```

## Application Integration

### Node.js Example

```javascript
const { Pool } = require('pg');

class SearchService {
    constructor(pool) {
        this.pool = pool;
    }
    
    async searchArticles(query, limit = 20, offset = 0) {
        const searchQuery = this.buildTsQuery(query);
        
        const result = await this.pool.query(`
            SELECT 
                id,
                title,
                content,
                ts_rank(search_vector, $1::tsquery) AS rank
            FROM articles
            WHERE search_vector @@ $1::tsquery
            ORDER BY rank DESC
            LIMIT $2 OFFSET $3
        `, [searchQuery, limit, offset]);
        
        return result.rows;
    }
    
    buildTsQuery(query) {
        // Escape special characters and combine terms
        const terms = query
            .split(/\s+/)
            .map(term => term.trim())
            .filter(term => term.length > 0)
            .map(term => `${term}:*`) // Prefix matching
            .join(' & ');
        
        return terms;
    }
}
```

## Best Practices

1. **Use GIN indexes** - Fast search performance
2. **Generated columns** - Pre-compute vectors
3. **Weight fields** - Prioritize important fields
4. **Limit results** - Paginate for performance
5. **Use ts_rank** - Sort by relevance
6. **Highlight results** - Better UX
7. **Index selectively** - Only index needed columns
8. **Monitor performance** - Track query times

## Common Issues

### Issue 1: Slow Queries

**Solution:**
- Add GIN indexes
- Use generated columns
- Limit result sets

### Issue 2: Poor Relevance

**Solution:**
- Use weighted fields
- Try ts_rank_cd
- Tune ranking function

### Issue 3: Language Support

**Solution:**
- Use appropriate language config
- Consider multiple languages
- Use 'simple' for basic needs

## Conclusion

PostgreSQL full-text search provides:
- Fast search performance
- Relevance ranking
- Language support
- Flexible queries

Use GIN indexes, generated columns, and ranking for production search. The patterns shown here handle millions of documents.

---

*PostgreSQL full-text search from July 2020, covering tsvector, tsquery, and GIN indexes.*

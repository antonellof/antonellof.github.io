---
layout: post
title: "PostgreSQL Full-Text Search: Implementation Guide"
date: 2020-07-12
categories: [How-To]
tags: [PostgreSQL, Full-Text Search, Database]
excerpt: "We needed search without Elasticsearch ops overhead. PostgreSQL full-text search handled 2M documents with sub-50ms queries—tsvector, GIN indexes, and ranking tricks that make results feel relevant, not just matched."
---

"We need search. Should we add Elasticsearch?"

This question appeared in every project planning meeting for years. Elasticsearch is powerful—also operationally heavy. Another cluster to monitor, another JVM to tune, another sync pipeline to break. For many apps, the answer was hiding in the database we already had.

PostgreSQL's full-text search won't replace Elasticsearch for billion-document scale or complex faceting. But for "users need to find articles/products/docs quickly"? It's remarkably capable. We ran full-text search on 2 million articles with sub-50ms p95 queries—no additional infrastructure.

Here's the implementation guide from that project: indexing, ranking, highlighting, and the gotchas that don't appear in the basic tutorials.

## How PostgreSQL Full-Text Search Works

PostgreSQL converts text into `tsvector`—a sorted list of normalized lexemes (word stems) with positions:

```sql
SELECT to_tsvector('english', 'The quick brown fox jumps over the lazy dog');
-- Result: 'brown':3 'dog':9 'fox':4 'jump':5 'lazi':8 'quick':2
```

Notice: "jumps" → "jump", "lazy" → "lazi". Stemming and stop word removal happen automatically with the `english` configuration.

Search queries become `tsquery`:

```sql
SELECT to_tsquery('english', 'fox & dog');
-- Result: 'fox' & 'dog'
```

The `@@` operator matches vectors against queries:

```sql
SELECT title, content
FROM articles
WHERE to_tsvector('english', content) @@ to_tsquery('english', 'database & performance');
```

Simple. The performance trap is calling `to_tsvector()` on every query without an index. That's a sequential scan. Don't do that.

## Indexing: GIN Makes It Fast

```sql
-- GIN index on computed tsvector
CREATE INDEX articles_content_idx ON articles 
USING GIN(to_tsvector('english', content));

SELECT title, content
FROM articles
WHERE to_tsvector('english', content) @@ to_tsquery('english', 'search term');
```

GIN (Generalized Inverted Index) is the right index type for full-text search. GiST works too but GIN is typically faster for read-heavy search workloads.

**Better approach:** precompute the tsvector in a generated column:

```sql
ALTER TABLE articles 
ADD COLUMN content_search_vector tsvector 
GENERATED ALWAYS AS (to_tsvector('english', 
    coalesce(title, '') || ' ' || coalesce(content, '')
)) STORED;

CREATE INDEX articles_search_idx ON articles USING GIN(content_search_vector);

-- Queries use the precomputed column
SELECT title, content
FROM articles
WHERE content_search_vector @@ to_tsquery('english', 'search term');
```

Generated columns compute once on insert/update, not on every query. Combine title + content into one vector because users don't care which field matched—they care that it matched.

## Ranking: Making Results Feel Relevant

Matching isn't enough. Users expect the best result first.

### ts_rank: Basic Relevance

```sql
SELECT 
    title,
    content,
    ts_rank(content_search_vector, query) AS rank
FROM articles,
     to_tsquery('english', 'postgresql & performance') AS query
WHERE content_search_vector @@ query
ORDER BY rank DESC
LIMIT 20;
```

`ts_rank` considers term frequency—documents where terms appear more often rank higher.

### ts_rank_cd: Better for Phrases

```sql
SELECT 
    title,
    content,
    ts_rank_cd(content_search_vector, query) AS rank
FROM articles,
     to_tsquery('english', 'postgresql & performance') AS query
WHERE content_search_vector @@ query
ORDER BY rank DESC;
```

`ts_rank_cd` (cover density) considers term proximity. "PostgreSQL performance" appearing as a phrase ranks higher than terms scattered across paragraphs. I default to `ts_rank_cd` for user-facing search.

## Query Patterns Users Actually Type

### Phrase Search

```sql
SELECT title, content
FROM articles
WHERE content_search_vector @@ phraseto_tsquery('english', 'quick brown fox');
```

`phraseto_tsquery` requires terms adjacent and in order. Good for exact quotes.

### Prefix Matching (Autocomplete)

```sql
SELECT title, content
FROM articles
WHERE content_search_vector @@ to_tsquery('english', 'postgre:*');
```

The `:*` suffix matches any word starting with "postgre"—postgresql, postgres, etc. Essential for search-as-you-type.

### Boolean Operators

```sql
-- AND: both terms required
WHERE content_search_vector @@ to_tsquery('english', 'postgresql & tuning');

-- OR: either term
WHERE content_search_vector @@ to_tsquery('english', 'postgresql | mysql');

-- NOT: exclude term
WHERE content_search_vector @@ to_tsquery('english', 'postgresql & !oracle');
```

In application code, I default user queries to AND (all terms required). OR queries return too many irrelevant results for casual searchers.

## Multi-Field Search with Weights

Not all fields are equal. Title matches should rank above matches in footnotes.

```sql
ALTER TABLE articles 
ADD COLUMN weighted_search_vector tsvector 
GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(tags, '')), 'C')
) STORED;

CREATE INDEX articles_weighted_idx ON articles USING GIN(weighted_search_vector);

SELECT 
    title,
    ts_rank(weighted_search_vector, query) AS rank
FROM articles,
     to_tsquery('english', 'kubernetes') AS query
WHERE weighted_search_vector @@ query
ORDER BY rank DESC;
```

Weights: A (highest) → D (lowest). Title='A', content='B', tags='C' is a sensible default for articles/docs.

## Highlighting: Show Users Why It Matched

```sql
SELECT 
    title,
    ts_headline(
        'english', 
        content, 
        query, 
        'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=35'
    ) AS snippet
FROM articles,
     to_tsquery('english', 'postgresql & index') AS query
WHERE weighted_search_vector @@ query
ORDER BY ts_rank(weighted_search_vector, query) DESC;
```

`ts_headline` extracts relevant fragments with search terms highlighted. Configure `MaxFragments` and `MaxWords` for your UI—snippets, not full documents.

## Application Integration

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
                ts_headline('english', content, $1::tsquery,
                    'StartSel=<mark>, StopSel=</mark>') AS snippet,
                ts_rank_cd(weighted_search_vector, $1::tsquery) AS rank
            FROM articles
            WHERE weighted_search_vector @@ $1::tsquery
              AND status = 'published'
            ORDER BY rank DESC
            LIMIT $2 OFFSET $3
        `, [searchQuery, limit, offset]);
        
        return result.rows;
    }
    
    buildTsQuery(query) {
        // Sanitize and convert user input to tsquery
        const terms = query
            .trim()
            .split(/\s+/)
            .filter(term => term.length > 0)
            .map(term => term.replace(/[^\w]/g, ''))  // Strip special chars
            .filter(term => term.length > 0)
            .map(term => `${term}:*`);  // Prefix match
        
        if (terms.length === 0) return '';
        return terms.join(' & ');
    }
}
```

**Critical:** never pass raw user input to `to_tsquery`. Characters like `&`, `|`, `!`, `:` have special meaning. Sanitize or use `plainto_tsquery` for simple cases:

```sql
-- Safer for raw user input
WHERE content_search_vector @@ plainto_tsquery('english', $1)
```

`plainto_tsquery` treats input as plain text, converting spaces to AND. Less flexible but injection-safe.

## Performance Optimization

### Partial Indexes

```sql
-- Index only published articles (if most are drafts)
CREATE INDEX articles_published_search_idx 
ON articles USING GIN(weighted_search_vector)
WHERE status = 'published';
```

Smaller index, faster queries, less storage—when your queries always filter on `status`.

### Pagination

```sql
SELECT title, ts_rank_cd(weighted_search_vector, query) AS rank
FROM articles, to_tsquery('english', 'search term') AS query
WHERE weighted_search_vector @@ query
ORDER BY rank DESC
LIMIT 20 OFFSET 0;
```

`OFFSET` gets slow on deep pages (Postgres still scans skipped rows). For infinite scroll at scale, consider cursor-based pagination or search-after patterns.

### When to Reach for Elasticsearch

PostgreSQL FTS is enough when:
- < 10-50M documents
- Simple faceting (use `GROUP BY` or JSONB)
- Search isn't your primary product feature
- You want zero additional infrastructure

Reach for Elasticsearch/OpenSearch when:
- Sub-10ms search at billions of docs
- Complex aggregations and faceting
- Fuzzy matching, synonyms, ML ranking
- Dedicated search team to operate it

## Troubleshooting

**Slow queries:** Missing GIN index, or calling `to_tsvector()` at query time instead of using a stored column. Run `EXPLAIN ANALYZE`.

**Poor relevance:** Try `ts_rank_cd`, add field weights, check if stemming is too aggressive (`english` stems "running" to "run"—sometimes you want `simple` config).

**No results for valid terms:** Check if terms are stop words ("the", "a", "is" are ignored). Use `plainto_tsquery` to debug.

## Conclusion

PostgreSQL full-text search is the most underrated feature in the most popular open-source database. GIN indexes, generated tsvector columns, weighted fields, and `ts_rank_cd` give you search that feels production-grade without operating a separate search cluster.

Start with a generated column combining your searchable fields. Add a GIN index. Use `ts_rank_cd` for ordering. Add `ts_headline` for snippets. Sanitize user input before converting to tsquery.

We deleted our Elasticsearch sync pipeline, reduced operational complexity, and search got faster because data wasn't replicated across systems. For most applications, that's the right trade. Save Elasticsearch for when you genuinely outgrow Postgres—and you'll know because ranking and scale will hurt in measurable ways, not because someone said you should use it.

---

*PostgreSQL full-text search from July 2020, covering tsvector, tsquery, and GIN indexes.*

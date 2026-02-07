---
layout: post
title: "Building AI Coding Assistants: Technical Deep Dive"
date: 2025-05-15
categories: [Deep Dive]
tags: [AI, Coding Assistants, LLM, Code Generation]
excerpt: "Build AI coding assistants: code generation, context management, tool integration, code analysis, and technical patterns for production coding assistants."
---

AI coding assistants have gone from party trick to indispensable tool in under two years. [GitHub Copilot](https://github.com/features/copilot), [Cursor](https://cursor.sh/), [Cody](https://sourcegraph.com/cody), and [Tabnine](https://www.tabnine.com/) are used by millions of developers daily. Building one requires solving hard problems: understanding massive codebases, generating correct code, and integrating with developer workflows.

I've built several coding assistants—from simple autocomplete to full agentic systems. The core challenge isn't LLMs (they're a commodity now)—it's everything around them: **context retrieval, code analysis, execution validation, and UX**.

This post covers the architecture that works in production, learned from systems processing millions of code generation requests.

## High-Level Architecture

A production coding assistant has these components:

```
┌─────────────┐
│  IDE Plugin │  ← User interaction
└──────┬──────┘
       │
┌──────▼──────────────┐
│  Orchestrator       │  ← Request routing, rate limiting
├─────────────────────┤
│  Context Engine     │  ← RAG, file selection
├─────────────────────┤
│  Code Analysis      │  ← AST, LSP, static analysis
├─────────────────────┤
│  LLM Service        │  ← OpenAI, Anthropic, local models
├─────────────────────┤
│  Execution Sandbox  │  ← Run and test generated code
├─────────────────────┤
│  Cache Layer        │  ← Response caching, embeddings
└─────────────────────┘
```

Each layer handles specific concerns. Let's dive into each.

## Context is Everything: RAG for Code

Large codebases have millions of lines. You can't fit that in LLM context. You need intelligent retrieval.

### Chunking Code

Unlike prose, code has structure. Chunk by semantic units:

```python
import ast
from typing import List, Dict

class CodeChunker:
    """Chunk code by functions, classes, and top-level statements."""
    
    def chunk_python_file(self, code: str) -> List[Dict]:
        """Split Python file into semantic chunks."""
        tree = ast.parse(code)
        chunks = []
        
        for node in ast.iter_child_nodes(tree):
            chunk = {
                'type': type(node).__name__,
                'name': getattr(node, 'name', 'anonymous'),
                'code': ast.get_source_segment(code, node),
                'lineno': node.lineno,
                'end_lineno': node.end_lineno,
            }
            
            # Add docstring if present
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                docstring = ast.get_docstring(node)
                if docstring:
                    chunk['docstring'] = docstring
            
            chunks.append(chunk)
        
        return chunks

# Usage
chunker = CodeChunker()
chunks = chunker.chunk_python_file(open('app.py').read())

for chunk in chunks:
    print(f"{chunk['type']}: {chunk['name']} (lines {chunk['lineno']}-{chunk['end_lineno']})")
```

For other languages, use tree-sitter for consistent parsing:

```python
from tree_sitter import Language, Parser
import tree_sitter_python

# Load Python grammar
PY_LANGUAGE = Language(tree_sitter_python.language())
parser = Parser(PY_LANGUAGE)

def extract_functions(code: str) -> List[Dict]:
    """Extract all function definitions."""
    tree = parser.parse(bytes(code, 'utf8'))
    
    functions = []
    for node in tree.root_node.children:
        if node.type == 'function_definition':
            functions.append({
                'name': node.child_by_field_name('name').text.decode(),
                'code': code[node.start_byte:node.end_byte],
                'start_line': node.start_point[0],
                'end_line': node.end_point[0],
            })
    
    return functions
```

### Embedding and Indexing

Use [code-specific embedding models](https://huggingface.co/models?other=code) for better semantic search:

```python
from sentence_transformers import SentenceTransformer
import pinecone

# Specialized code embedding model
model = SentenceTransformer('microsoft/codebert-base')

# Initialize Pinecone
pc = pinecone.Pinecone(api_key='your-key')
index = pc.Index('codebase')

def index_codebase(repo_path: str):
    """Index an entire codebase."""
    for filepath in glob_python_files(repo_path):
        code = open(filepath).read()
        chunks = chunker.chunk_python_file(code)
        
        for chunk in chunks:
            # Create searchable text
            search_text = f"""
{chunk['type']} {chunk['name']}
{chunk.get('docstring', '')}
{chunk['code']}
            """.strip()
            
            # Embed
            embedding = model.encode(search_text)
            
            # Store in vector DB
            index.upsert([{
                'id': f"{filepath}:{chunk['lineno']}",
                'values': embedding.tolist(),
                'metadata': {
                    'file': filepath,
                    'name': chunk['name'],
                    'type': chunk['type'],
                    'code': chunk['code'][:1000],  # Truncate for storage
                    'lineno': chunk['lineno'],
                }
            }])

def find_relevant_code(query: str, top_k: int = 5):
    """Find code relevant to query."""
    query_embedding = model.encode(query)
    
    results = index.query(
        vector=query_embedding.tolist(),
        top_k=top_k,
        include_metadata=True
    )
    
    return [
        {
            'file': r.metadata['file'],
            'name': r.metadata['name'],
            'code': r.metadata['code'],
            'score': r.score,
        }
        for r in results.matches
    ]

# Usage
relevant_code = find_relevant_code("How to authenticate users?")
for code in relevant_code:
    print(f"Score: {code['score']:.3f} - {code['file']}:{code['name']}")
```

### Hybrid Search: Combine Semantic + Keyword

Pure vector search misses exact matches. Combine with keyword search:

```python
def hybrid_search(query: str, top_k: int = 10):
    """Combine semantic and keyword search."""
    # Semantic search
    semantic_results = find_relevant_code(query, top_k=top_k * 2)
    
    # Keyword search (simple implementation)
    keyword_results = search_by_keywords(query, top_k=top_k * 2)
    
    # Merge and rank (Reciprocal Rank Fusion)
    combined_scores = {}
    for rank, result in enumerate(semantic_results, 1):
        combined_scores[result['id']] = 1 / (rank + 60)
    
    for rank, result in enumerate(keyword_results, 1):
        result_id = result['id']
        combined_scores[result_id] = combined_scores.get(result_id, 0) + 1 / (rank + 60)
    
    # Sort by combined score
    ranked = sorted(combined_scores.items(), key=lambda x: x[1], reverse=True)
    return ranked[:top_k]
```

See [Anthropic's guide on RAG for code](https://www.anthropic.com/index/contextual-retrieval) for more techniques.

## Code Analysis: Understanding Structure

Static analysis helps validate and improve generated code:

### Language Server Protocol (LSP)

[LSP](https://microsoft.github.io/language-server-protocol/) provides IDE-like intelligence:

```python
from pylsp.python_lsp import PythonLanguageServer

class CodeAnalyzer:
    """Analyze code using LSP."""
    
    def __init__(self):
        self.lsp = PythonLanguageServer()
    
    def get_completions(self, filepath: str, line: int, column: int):
        """Get completion suggestions at cursor."""
        return self.lsp.completions({
            'textDocument': {'uri': f'file://{filepath}'},
            'position': {'line': line, 'character': column}
        })
    
    def get_diagnostics(self, filepath: str, code: str):
        """Get errors and warnings."""
        return self.lsp.lint({
            'textDocument': {'uri': f'file://{filepath}'},
            'text': code
        })
    
    def find_references(self, filepath: str, symbol: str):
        """Find all references to a symbol."""
        return self.lsp.references({
            'textDocument': {'uri': f'file://{filepath}'},
            'position': self.find_symbol_position(symbol)
        })
```

### Type Inference

Use [Pyright](https://github.com/microsoft/pyright) or [mypy](https://github.com/python/mypy) to validate generated code:

```python
import subprocess
import json

def check_types(code: str) -> List[Dict]:
    """Run Pyright on code."""
    # Write code to temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
        f.write(code)
        filepath = f.name
    
    try:
        # Run Pyright
        result = subprocess.run(
            ['pyright', '--outputjson', filepath],
            capture_output=True,
            text=True
        )
        
        diagnostics = json.loads(result.stdout)
        return diagnostics.get('generalDiagnostics', [])
    finally:
        os.unlink(filepath)

# Usage
code = """
def add(a: int, b: int) -> int:
    return a + b

result = add("5", 10)  # Type error!
"""

errors = check_types(code)
for error in errors:
    print(f"Line {error['range']['start']['line']}: {error['message']}")
```

### Security Scanning

Detect security issues with [Bandit](https://github.com/PyCQA/bandit):

```python
import bandit
from bandit.core import manager

def security_scan(code: str) -> List[Dict]:
    """Scan for security issues."""
    # Create temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
        f.write(code)
        filepath = f.name
    
    try:
        # Run Bandit
        b = manager.BanditManager(bandit.config.BanditConfig(), 'file')
        b.discover_files([filepath])
        b.run_tests()
        
        issues = []
        for result in b.get_issue_list():
            issues.append({
                'severity': result.severity,
                'confidence': result.confidence,
                'text': result.text,
                'line': result.lineno,
            })
        
        return issues
    finally:
        os.unlink(filepath)
```

## Execution and Validation

Generate code, run it, validate results:

### Test-Driven Generation

Generate code and tests together:

```python
from anthropic import Anthropic

client = Anthropic(api_key='your-key')

def generate_with_tests(spec: str, context: str) -> Dict:
    """Generate function and tests."""
    prompt = f"""Generate a Python function and pytest tests for:

{spec}

Context from codebase:
{context}

Return:
1. The function implementation
2. At least 3 pytest test cases
3. Docstring with examples

Format as Python code blocks."""

    response = client.messages.create(
        model='claude-3-5-sonnet-20241022',
        max_tokens=2000,
        messages=[{'role': 'user', 'content': prompt}]
    )
    
    # Parse response (simplified)
    code = extract_code_blocks(response.content[0].text)
    
    return {
        'function': code[0],
        'tests': code[1],
    }

def validate_generated_code(code: str, tests: str) -> bool:
    """Run tests against generated code."""
    # Combine code and tests
    full_code = f"{code}\n\n{tests}"
    
    # Write to temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
        f.write(full_code)
        filepath = f.name
    
    try:
        # Run pytest
        result = subprocess.run(
            ['pytest', filepath, '-v'],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    finally:
        os.unlink(filepath)
```

### Sandboxed Execution

Use [E2B](https://e2b.dev/) for secure code execution:

```python
from e2b import Sandbox

def execute_safely(code: str, inputs: List[str]) -> Dict:
    """Execute code in sandbox."""
    with Sandbox() as sandbox:
        # Write code
        sandbox.filesystem.write('main.py', code)
        
        # Execute with inputs
        results = []
        for input_data in inputs:
            result = sandbox.run_code(
                code,
                env_vars={'INPUT': input_data},
                timeout=5
            )
            
            results.append({
                'stdout': result.stdout,
                'stderr': result.stderr,
                'exit_code': result.exit_code,
                'error': result.error,
            })
        
        return results

# Usage
code = """
import os
print(f"Hello {os.getenv('INPUT', 'World')}!")
"""

results = execute_safely(code, ['Alice', 'Bob'])
for i, r in enumerate(results):
    print(f"Run {i+1}: {r['stdout']}")
```

### Iterative Refinement

If code fails tests, refine iteratively:

```python
def iterative_generation(spec: str, max_iterations: int = 3) -> str:
    """Generate and refine code until tests pass."""
    context = find_relevant_code(spec)
    
    for i in range(max_iterations):
        # Generate code
        result = generate_with_tests(spec, context)
        code = result['function']
        tests = result['tests']
        
        # Validate
        if validate_generated_code(code, tests):
            return code
        
        # If failed, add error context and retry
        errors = check_types(code)
        context += f"\n\nPrevious attempt had errors:\n{errors}"
    
    raise Exception("Failed to generate working code")
```

## Production Considerations

### Cost Optimization

LLM costs add up fast at scale:

```python
class CostTracker:
    """Track and optimize LLM costs."""
    
    PRICING = {
        'gpt-4o': {'input': 0.0025, 'output': 0.010},
        'gpt-4o-mini': {'input': 0.00015, 'output': 0.0006},
        'claude-3-5-sonnet': {'input': 0.003, 'output': 0.015},
    }
    
    def __init__(self):
        self.total_cost = 0
    
    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int):
        """Calculate request cost."""
        pricing = self.PRICING[model]
        cost = (
            (input_tokens / 1000) * pricing['input'] +
            (output_tokens / 1000) * pricing['output']
        )
        self.total_cost += cost
        return cost

# Optimization strategies:
# 1. Use cheaper models for simple tasks (autocomplete)
# 2. Cache responses aggressively
# 3. Minimize context with smart retrieval
# 4. Use streaming to show results faster
```

### Response Caching

Cache at multiple levels:

```python
import hashlib
import redis

class CacheLayer:
    """Multi-level caching for coding assistant."""
    
    def __init__(self):
        self.redis = redis.Redis(host='localhost', port=6379)
        self.memory_cache = {}  # In-memory for ultra-fast access
    
    def get_cached_response(self, query: str, context: str) -> Optional[str]:
        """Get cached response."""
        # Create cache key
        cache_key = hashlib.sha256(
            f"{query}:{context}".encode()
        ).hexdigest()
        
        # Check memory cache
        if cache_key in self.memory_cache:
            return self.memory_cache[cache_key]
        
        # Check Redis
        cached = self.redis.get(cache_key)
        if cached:
            response = cached.decode()
            self.memory_cache[cache_key] = response  # Promote to memory
            return response
        
        return None
    
    def cache_response(self, query: str, context: str, response: str, ttl: int = 3600):
        """Cache response."""
        cache_key = hashlib.sha256(
            f"{query}:{context}".encode()
        ).hexdigest()
        
        # Store in both layers
        self.memory_cache[cache_key] = response
        self.redis.setex(cache_key, ttl, response)
```

### Model Selection

Use different models for different tasks:

```python
def select_model(task_type: str) -> str:
    """Choose model based on task."""
    if task_type == 'autocomplete':
        return 'gpt-4o-mini'  # Fast, cheap
    elif task_type == 'explain':
        return 'gpt-4o-mini'  # Good enough
    elif task_type == 'generate_complex':
        return 'claude-3-5-sonnet'  # Best quality
    elif task_type == 'refactor':
        return 'gpt-4o'  # Balance of speed/quality
    else:
        return 'gpt-4o-mini'  # Default to cheap
```

### Monitoring

Track what matters:

```python
import structlog
from dataclasses import dataclass

logger = structlog.get_logger()

@dataclass
class RequestMetrics:
    request_id: str
    task_type: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: float
    cache_hit: bool
    cost_usd: float
    success: bool

def log_request(metrics: RequestMetrics):
    """Log request metrics for analysis."""
    logger.info(
        "coding_assistant_request",
        request_id=metrics.request_id,
        task=metrics.task_type,
        model=metrics.model,
        input_tokens=metrics.input_tokens,
        output_tokens=metrics.output_tokens,
        latency_ms=metrics.latency_ms,
        cache_hit=metrics.cache_hit,
        cost=metrics.cost_usd,
        success=metrics.success,
    )

# Track aggregate metrics
# - Requests per minute
# - Cache hit rate
# - P50/P95/P99 latency
# - Cost per user
# - Success rate
```

## Conclusion

Building a production coding assistant is 20% LLM calls and 80% everything else: context retrieval, code analysis, validation, caching, and monitoring. The LLM is a commodity—the value is in the system around it.

Start with strong RAG (code-aware chunking, hybrid search), validate generated code (tests, type checking, security), and optimize costs (caching, model selection). Test extensively with real codebases.

The best coding assistants feel invisible—they understand context, generate correct code, and integrate seamlessly into developer workflow. That requires careful engineering at every layer.

**Further Resources:**
- [GitHub Copilot Architecture](https://github.blog/2023-05-17-inside-github-building-the-worlds-largest-ai-powered-developer-tool/) - How Copilot works
- [Cursor](https://cursor.sh/) - Leading AI IDE
- [Sourcegraph Cody](https://sourcegraph.com/cody) - Code AI assistant
- [CodeBERT](https://github.com/microsoft/CodeBERT) - Code understanding model
- [Tree-sitter](https://tree-sitter.github.io/) - Universal code parser
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) - IDE features as a protocol
- [E2B](https://e2b.dev/) - Code execution sandbox
- [Continue.dev](https://github.com/continuedev/continue) - Open source coding assistant

---

*Updated May 2025 — practical implementation notes for production AI coding assistants.*

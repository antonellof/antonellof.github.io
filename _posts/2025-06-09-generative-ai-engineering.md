---
layout: post
title: "Generative AI Engineering: Best Practices"
date: 2025-06-09
categories: [Best Practices]
tags: [Generative AI, Engineering, LLM, Best Practices]
excerpt: "Engineering practices for generative AI: prompt engineering, RAG patterns, evaluation, monitoring, and best practices for production AI systems."
---

Generative AI engineering is less about the models (they're commodities now) and more about the **systems around them**: prompts, retrieval, evaluation, caching, and monitoring. The difference between a demo and production is these unglamorous layers.

I've built multiple production GenAI systems—chatbots, coding assistants, document analysis. The models (GPT-4, Claude, Gemini) are interchangeable. The hard parts are: getting the right context into prompts, handling failures gracefully, managing costs, and measuring quality. This post covers patterns that work at scale.

Drawing from [Anthropic's prompt engineering guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview), [OpenAI's best practices](https://platform.openai.com/docs/guides/prompt-engineering), and real production experience.

## Prompt Engineering: The Core Skill

Prompts are your interface to LLMs. Good prompts are specific, structured, and include examples.

### The Six Principles

From [Anthropic's guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview):

1. **Give Claude a role** - Context shapes behavior
2. **Use XML tags** - Structure improves parsing
3. **Be specific** - Vague prompts get vague outputs
4. **Use examples** - Few-shot examples are powerful
5. **Let Claude think** - Chain-of-thought improves reasoning
6. **Use prefill** - Control output format

### Structured Prompts

Always structure prompts with clear sections:

```python
from anthropic import Anthropic

client = Anthropic(api_key='your-key')

def analyze_document(document: str, question: str) -> str:
    """Analyze document with structured prompt."""
    
    prompt = f"""You are an expert document analyst. Your task is to answer questions about documents accurately and concisely.

<document>
{document}
</document>

<question>
{question}
</question>

Instructions:
1. Read the document carefully
2. Identify relevant information
3. Answer the question based only on the document
4. If the answer isn't in the document, say "Not found in document"
5. Cite specific passages when possible

Think through your answer step-by-step, then provide your final answer."""

    response = client.messages.create(
        model='claude-3-5-sonnet-20241022',
        max_tokens=1024,
        messages=[{'role': 'user', 'content': prompt}]
    )
    
    return response.content[0].text
```

**Why this works:**
- Clear role definition
- XML tags separate inputs
- Explicit instructions
- Step-by-step thinking
- Constraints on output

### Few-Shot Examples

Examples are more powerful than instructions:

```python
def classify_sentiment(text: str) -> str:
    """Classify sentiment with examples."""
    
    prompt = f"""Classify the sentiment of the following text as positive, negative, or neutral.

Examples:

Text: "This product exceeded my expectations! Amazing quality."
Sentiment: positive

Text: "Terrible experience. Would not recommend."
Sentiment: negative

Text: "The item arrived on time."
Sentiment: neutral

Now classify this text:

Text: "{text}"
Sentiment:"""

    response = client.messages.create(
        model='claude-3-5-sonnet-20241022',
        max_tokens=10,
        messages=[{'role': 'user', 'content': prompt}]
    )
    
    return response.content[0].text.strip()
```

Three examples teach the model the pattern. For complex tasks, 5-10 examples work better.

### Chain-of-Thought Prompting

For reasoning tasks, ask the model to think step-by-step:

```python
def solve_math_problem(problem: str) -> dict:
    """Solve with chain-of-thought reasoning."""
    
    prompt = f"""Solve this math problem step-by-step.

Problem: {problem}

Let's solve this step by step:
1. First, identify what we're looking for
2. Then, break down the problem
3. Show your work
4. Finally, state the answer

Begin:"""

    response = client.messages.create(
        model='claude-3-5-sonnet-20241022',
        max_tokens=1024,
        messages=[{'role': 'user', 'content': prompt}]
    )
    
    reasoning = response.content[0].text
    
    # Extract final answer (simplified)
    answer = reasoning.split('answer')[-1].strip()
    
    return {
        'reasoning': reasoning,
        'answer': answer,
    }
```

Studies show CoT improves accuracy on reasoning tasks by 20-40%. See [Google's CoT paper](https://arxiv.org/abs/2201.11903).

### Prompt Templates

Use templates for consistency:

```python
from string import Template

# Define template once
SUMMARIZATION_TEMPLATE = Template("""Summarize the following ${document_type} in ${length} words or less.

Focus on:
${focus_areas}

${document_type}:
${content}

Summary:""")

# Use with different parameters
prompt = SUMMARIZATION_TEMPLATE.substitute(
    document_type='research paper',
    length='100',
    focus_areas='- Main findings\n- Methodology\n- Conclusions',
    content=paper_text
)
```

Templates ensure consistent quality and make A/B testing easier.

## RAG: Retrieval-Augmented Generation

RAG solves the knowledge cutoff and hallucination problems by retrieving relevant context before generation.

### Basic RAG Pipeline

```python
from openai import OpenAI
import pinecone

client = OpenAI(api_key='your-key')
pc = pinecone.Pinecone(api_key='your-key')
index = pc.Index('knowledge-base')

def rag_query(question: str, top_k: int = 5) -> str:
    """Answer question using RAG."""
    
    # 1. Embed the question
    question_embedding = client.embeddings.create(
        model='text-embedding-3-small',
        input=question
    ).data[0].embedding
    
    # 2. Retrieve relevant documents
    results = index.query(
        vector=question_embedding,
        top_k=top_k,
        include_metadata=True
    )
    
    # 3. Format context
    context = "\n\n".join([
        f"Document {i+1}:\n{match.metadata['text']}"
        for i, match in enumerate(results.matches)
    ])
    
    # 4. Generate answer with context
    prompt = f"""Answer the question based on the provided context.

Context:
{context}

Question: {question}

Answer based only on the context above. If the answer isn't in the context, say "I don't have enough information to answer that."

Answer:"""

    response = client.chat.completions.create(
        model='gpt-4o',
        messages=[{'role': 'user', 'content': prompt}],
        temperature=0,  # Low temperature for factual answers
    )
    
    return response.choices[0].message.content
```

### Advanced RAG: Reranking

Simple vector search isn't always accurate. Rerank with a cross-encoder:

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')

def rag_with_reranking(question: str, top_k: int = 5) -> str:
    """RAG with reranking for better accuracy."""
    
    # 1. Retrieve more candidates than needed
    results = vector_search(question, top_k=top_k * 3)
    
    # 2. Rerank using cross-encoder
    pairs = [[question, match.metadata['text']] for match in results.matches]
    scores = reranker.predict(pairs)
    
    # 3. Sort by reranker scores
    reranked = sorted(zip(results.matches, scores), key=lambda x: x[1], reverse=True)
    
    # 4. Use top-k after reranking
    top_results = [match for match, score in reranked[:top_k]]
    
    # 5. Generate with reranked context
    context = format_context(top_results)
    return generate_answer(question, context)
```

Reranking improves accuracy by 10-20% in my experience. See [LlamaIndex's reranking guide](https://docs.llamaindex.ai/en/stable/examples/node_postprocessor/CohereRerank/).

### HyDE: Hypothetical Document Embeddings

For complex queries, generate a hypothetical answer first:

```python
def hyde_rag(question: str) -> str:
    """RAG with hypothetical document embeddings."""
    
    # 1. Generate hypothetical answer
    hypothetical_prompt = f"""Generate a detailed answer to this question:

{question}

Write as if you're answering from authoritative sources."""

    hypothetical_answer = client.chat.completions.create(
        model='gpt-4o-mini',
        messages=[{'role': 'user', 'content': hypothetical_prompt}],
        temperature=0.7,
    ).choices[0].message.content
    
    # 2. Embed and search using hypothetical answer
    # (hypothetical answer better matches document style)
    embedding = embed(hypothetical_answer)
    results = index.query(vector=embedding, top_k=5)
    
    # 3. Generate final answer with retrieved context
    context = format_context(results.matches)
    return generate_answer(question, context)
```

HyDE improves retrieval for questions that don't match document phrasing. Paper: [Precise Zero-Shot Dense Retrieval](https://arxiv.org/abs/2212.10496).

## Evaluation: Measuring Quality

LLM outputs are probabilistic. You need systematic evaluation.

### Automated Evaluation Metrics

```python
from openai import OpenAI
import numpy as np

client = OpenAI()

class LLMEvaluator:
    """Evaluate LLM outputs systematically."""
    
    def evaluate_answer(self, question: str, answer: str, ground_truth: str) -> dict:
        """Evaluate answer quality."""
        
        # 1. Semantic similarity (embeddings)
        answer_emb = self.embed(answer)
        truth_emb = self.embed(ground_truth)
        similarity = np.dot(answer_emb, truth_emb)
        
        # 2. LLM-as-judge
        judge_prompt = f"""Evaluate the quality of this answer on a scale of 1-5.

Question: {question}

Expected Answer: {ground_truth}

Actual Answer: {answer}

Rate the answer considering:
- Accuracy (is it factually correct?)
- Completeness (does it fully answer the question?)
- Relevance (does it stay on topic?)

Provide a score (1-5) and brief explanation.

Format:
Score: [1-5]
Explanation: [your reasoning]"""

        judge_response = client.chat.completions.create(
            model='gpt-4o',
            messages=[{'role': 'user', 'content': judge_prompt}],
            temperature=0,
        ).choices[0].message.content
        
        # Parse score
        score = int(judge_response.split('Score:')[1].split('\n')[0].strip())
        
        return {
            'semantic_similarity': similarity,
            'llm_judge_score': score,
            'judge_explanation': judge_response,
        }
    
    def embed(self, text: str):
        """Get embedding."""
        return client.embeddings.create(
            model='text-embedding-3-small',
            input=text
        ).data[0].embedding
```

### Test Sets

Build curated test sets:

```python
test_cases = [
    {
        'question': 'What is the capital of France?',
        'expected': 'Paris',
        'category': 'factual',
    },
    {
        'question': 'Explain photosynthesis simply',
        'expected': 'Plants convert sunlight into energy...',
        'category': 'explanation',
    },
    # ... more test cases
]

def run_evaluation(system, test_cases):
    """Run systematic evaluation."""
    results = []
    
    for test in test_cases:
        answer = system.answer(test['question'])
        
        metrics = evaluator.evaluate_answer(
            test['question'],
            answer,
            test['expected']
        )
        
        results.append({
            'question': test['question'],
            'answer': answer,
            'metrics': metrics,
            'category': test['category'],
        })
    
    # Aggregate by category
    by_category = {}
    for result in results:
        cat = result['category']
        if cat not in by_category:
            by_category[cat] = []
        by_category[cat].append(result['metrics']['llm_judge_score'])
    
    # Print summary
    for category, scores in by_category.items():
        avg = np.mean(scores)
        print(f"{category}: {avg:.2f}/5.0")
    
    return results
```

### A/B Testing

Compare prompt variants:

```python
def ab_test_prompts(variant_a, variant_b, test_cases, sample_size=100):
    """A/B test two prompt variants."""
    
    results_a = []
    results_b = []
    
    for test in test_cases[:sample_size]:
        # Test variant A
        answer_a = generate_with_prompt(variant_a, test['question'])
        score_a = evaluate(test['question'], answer_a, test['expected'])
        results_a.append(score_a)
        
        # Test variant B
        answer_b = generate_with_prompt(variant_b, test['question'])
        score_b = evaluate(test['question'], answer_b, test['expected'])
        results_b.append(score_b)
    
    # Statistical comparison
    from scipy import stats
    t_stat, p_value = stats.ttest_ind(results_a, results_b)
    
    return {
        'variant_a_mean': np.mean(results_a),
        'variant_b_mean': np.mean(results_b),
        'p_value': p_value,
        'winner': 'A' if np.mean(results_a) > np.mean(results_b) else 'B',
        'significant': p_value < 0.05,
    }
```

Use [Weights & Biases](https://wandb.ai/) or [LangSmith](https://www.langchain.com/langsmith) for experiment tracking.

## Production Best Practices

### 1. Cost Optimization

LLM costs are variable—optimize aggressively:

```python
class CostOptimizedLLM:
    """LLM client with cost optimization."""
    
    PRICING = {
        'gpt-4o': {'input': 0.0025, 'output': 0.010, 'quality': 5},
        'gpt-4o-mini': {'input': 0.00015, 'output': 0.0006, 'quality': 4},
        'claude-3-5-sonnet': {'input': 0.003, 'output': 0.015, 'quality': 5},
    }
    
    def __init__(self):
        self.cache = {}
        self.total_cost = 0
    
    def generate(self, prompt: str, task_complexity: str = 'medium'):
        """Generate with cost optimization."""
        
        # 1. Check cache
        cache_key = hash(prompt)
        if cache_key in self.cache:
            return self.cache[cache_key]
        
        # 2. Select model based on task
        model = self._select_model(task_complexity)
        
        # 3. Minimize token usage
        optimized_prompt = self._optimize_prompt(prompt)
        
        # 4. Generate
        response = client.chat.completions.create(
            model=model,
            messages=[{'role': 'user', 'content': optimized_prompt}],
            max_tokens=self._calculate_max_tokens(task_complexity),
        )
        
        # 5. Track cost
        cost = self._calculate_cost(model, response.usage)
        self.total_cost += cost
        
        # 6. Cache result
        result = response.choices[0].message.content
        self.cache[cache_key] = result
        
        return result
    
    def _select_model(self, complexity: str) -> str:
        """Choose cheapest model that meets quality needs."""
        if complexity == 'simple':
            return 'gpt-4o-mini'
        elif complexity == 'medium':
            return 'gpt-4o-mini'  # Try cheap first
        else:
            return 'gpt-4o'
    
    def _optimize_prompt(self, prompt: str) -> str:
        """Remove unnecessary tokens."""
        # Remove extra whitespace
        optimized = ' '.join(prompt.split())
        # Truncate if too long
        if len(optimized) > 10000:
            optimized = optimized[:10000] + '...'
        return optimized
    
    def _calculate_max_tokens(self, complexity: str) -> int:
        """Set appropriate max_tokens."""
        limits = {'simple': 256, 'medium': 512, 'complex': 2048}
        return limits.get(complexity, 512)
```

**Cost reduction strategies:**
- Use cheaper models (GPT-4o-mini) for simple tasks
- Cache aggressively (30-50% cache hit rate typical)
- Minimize prompt tokens (context compression)
- Set appropriate max_tokens
- Batch requests where possible

### 2. Reliability and Error Handling

LLMs fail. Handle it gracefully:

```python
import time
import random
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10)
)
def generate_with_retry(prompt: str) -> str:
    """Generate with automatic retries."""
    try:
        response = client.chat.completions.create(
            model='gpt-4o',
            messages=[{'role': 'user', 'content': prompt}],
            timeout=30,
        )
        return response.choices[0].message.content
    
    except client.RateLimitError:
        # Hit rate limit, wait and retry
        time.sleep(5)
        raise
    
    except client.APIError as e:
        # API error, retry
        print(f"API error: {e}")
        raise
    
    except Exception as e:
        # Unexpected error
        print(f"Unexpected error: {e}")
        return "I apologize, but I'm having trouble processing your request."
```

### 3. Monitoring

Track what matters:

```python
import structlog
from dataclasses import dataclass
from datetime import datetime

logger = structlog.get_logger()

@dataclass
class LLMMetrics:
    """Track LLM usage metrics."""
    request_id: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: float
    cost_usd: float
    success: bool
    error: str = None

def log_llm_request(metrics: LLMMetrics):
    """Log for analysis."""
    logger.info(
        "llm_request",
        request_id=metrics.request_id,
        model=metrics.model,
        prompt_tokens=metrics.prompt_tokens,
        completion_tokens=metrics.completion_tokens,
        latency_ms=metrics.latency_ms,
        cost=metrics.cost_usd,
        success=metrics.success,
        error=metrics.error,
    )

# Track aggregate metrics:
# - Requests per minute
# - Average latency (p50, p95, p99)
# - Token usage per user/endpoint
# - Cost per day/user
# - Error rate by type
# - Cache hit rate
```

Use [Helicone](https://www.helicone.ai/), [LangSmith](https://www.langchain.com/langsmith), or [Weights & Biases](https://wandb.ai/) for LLM observability.

### 4. Security

Protect against prompt injection and data leakage:

```python
def sanitize_input(user_input: str) -> str:
    """Remove potential prompt injection."""
    # Remove system-like instructions
    dangerous_patterns = [
        'ignore previous instructions',
        'disregard the above',
        'system:',
        'assistant:',
    ]
    
    cleaned = user_input.lower()
    for pattern in dangerous_patterns:
        if pattern in cleaned:
            return "[Input rejected: suspicious pattern detected]"
    
    # Limit length
    if len(user_input) > 5000:
        user_input = user_input[:5000]
    
    return user_input

def detect_pii(text: str) -> bool:
    """Check for personally identifiable information."""
    import re
    
    # Email
    if re.search(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', text):
        return True
    
    # Phone number
    if re.search(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', text):
        return True
    
    # SSN pattern
    if re.search(r'\b\d{3}-\d{2}-\d{4}\b', text):
        return True
    
    return False
```

## Conclusion

Generative AI engineering is systems engineering. The models are tools—the value is in how you use them. Focus on prompts, retrieval, evaluation, cost optimization, and reliability.

Start simple: good prompts with few-shot examples, basic RAG, automated evaluation. Add complexity only when needed. Measure everything—costs, latency, quality. Iterate based on data.

The best AI systems feel simple to users but are sophisticated underneath. That sophistication comes from engineering discipline, not fancy models.

**Further Resources:**
- [Anthropic Prompt Engineering](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview) - Comprehensive guide
- [OpenAI Best Practices](https://platform.openai.com/docs/guides/prompt-engineering) - Prompting strategies
- [LangChain Documentation](https://python.langchain.com/docs/get_started/introduction) - RAG patterns
- [LlamaIndex](https://docs.llamaindex.ai/) - Advanced RAG
- [Weights & Biases for LLMs](https://wandb.ai/site/solutions/llmops) - Experiment tracking
- [LangSmith](https://www.langchain.com/langsmith) - LLM observability
- [Helicone](https://www.helicone.ai/) - LLM monitoring
- [Prompt Engineering Guide](https://www.promptingguide.ai/) - Techniques and examples

---

*Generative AI engineering from June 2025 — updated with production guidance.*

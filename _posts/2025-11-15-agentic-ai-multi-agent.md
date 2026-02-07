---
layout: post
title: "Agentic AI Systems: Multi-Agent Architectures"
date: 2025-11-15
categories: [Architecture]
tags: [AI Agents, Multi-Agent, Architecture, LLM]
excerpt: "Design multi-agent AI systems: agent coordination, communication patterns, task decomposition, and architectural patterns for complex agent systems."
---

Single AI agents struggle with complex tasks. They exceed context limits, conflate responsibilities, and become brittle monoliths. Multi-agent systems decompose complexity: specialized agents handle distinct concerns, coordinate through messages, and compose into robust systems.

I built a multi-agent code analysis system: one agent parsed code structure, another reasoned about architecture, a third suggested refactorings. Each was smaller, testable, and replaceable. The coordinator orchestrated their interaction. The result was more maintainable than a single "do everything" agent.

Multi-agent systems aren't new—[distributed AI](https://en.wikipedia.org/wiki/Multi-agent_system) has decades of research. But LLMs make them practical: agents can understand natural language instructions, reason about tasks, and collaborate without rigid protocols.

## Why Multiple Agents?

**Separation of concerns** - Parsing, reasoning, and execution are distinct skills. Separate agents, separate prompts, separate tests.

**Context management** - LLMs have finite context. Multiple focused agents stay within limits.

**Specialization** - Train/tune agents for specific domains (legal analysis, code review, data extraction).

**Fault isolation** - If the code execution agent fails, the reasoning agent continues.

**Testability** - Test each agent independently with unit tests.

**Scalability** - Scale expensive agents (GPT-4) separately from cheap ones (Claude Haiku).

Read [AutoGen](https://microsoft.github.io/autogen/) and [LangGraph](https://www.langchain.com/langgraph) for framework approaches.

## Agent Roles and Patterns

### 1. Coordinator (Orchestrator)

Decomposes high-level goals into subtasks, assigns to specialists, aggregates results.

```python
from anthropic import Anthropic
from typing import List, Dict

class Coordinator:
    """Orchestrate multi-agent workflow."""
    
    def __init__(self, specialists: Dict[str, 'Agent']):
        self.client = Anthropic()
        self.specialists = specialists
        self.history = []
    
    async def process(self, task: str) -> str:
        """Break down task and coordinate execution."""
        
        # Decompose task
        subtasks = await self.decompose(task)
        
        results = {}
        for subtask in subtasks:
            agent_type = subtask['agent']
            agent = self.specialists[agent_type]
            
            # Execute subtask
            result = await agent.execute(subtask['task'])
            results[subtask['id']] = result
        
        # Synthesize results
        final_answer = await self.synthesize(task, results)
        return final_answer
    
    async def decompose(self, task: str) -> List[Dict]:
        """Decompose task into subtasks."""
        response = self.client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=2048,
            system="""You are a task coordinator. Break down complex tasks into subtasks.

Output JSON array:
[
  {"id": "1", "agent": "search", "task": "Find relevant documentation"},
  {"id": "2", "agent": "code", "task": "Analyze code structure"}
]""",
            messages=[{
                "role": "user",
                "content": f"Break down this task:\n\n{task}"
            }]
        )
        
        import json
        return json.loads(response.content[0].text)
    
    async def synthesize(self, task: str, results: Dict) -> str:
        """Combine results into final answer."""
        context = "\n\n".join([
            f"Subtask {k}:\n{v}" for k, v in results.items()
        ])
        
        response = self.client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=4096,
            system="You are a synthesizer. Combine subtask results into a coherent answer.",
            messages=[{
                "role": "user",
                "content": f"""Original task: {task}

Subtask results:
{context}

Provide a comprehensive answer to the original task."""
            }]
        )
        
        return response.content[0].text
```

### 2. Specialist Agents

Domain-specific agents with focused expertise:

```python
class SearchAgent:
    """Specialist for web/documentation search."""
    
    def __init__(self, search_api):
        self.client = Anthropic()
        self.search_api = search_api
    
    async def execute(self, task: str) -> str:
        """Execute search task."""
        # Extract search query
        query = await self.extract_query(task)
        
        # Perform search
        results = await self.search_api.search(query)
        
        # Synthesize results
        return self.synthesize_results(results)
    
    async def extract_query(self, task: str) -> str:
        """Extract search query from task description."""
        response = self.client.messages.create(
            model="claude-3-haiku-20240307",  # Cheap model for extraction
            max_tokens=256,
            system="Extract the search query from the task. Return only the query text.",
            messages=[{"role": "user", "content": task}]
        )
        return response.content[0].text.strip()


class CodeAgent:
    """Specialist for code analysis."""
    
    def __init__(self):
        self.client = Anthropic()
    
    async def execute(self, task: str) -> str:
        """Execute code analysis task."""
        response = self.client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=4096,
            system="""You are a code analysis expert. Analyze code for:
- Structure and architecture
- Potential bugs
- Performance issues
- Security vulnerabilities

Provide clear, actionable feedback.""",
            messages=[{"role": "user", "content": task}]
        )
        return response.content[0].text


class ExecutionAgent:
    """Specialist for executing code/commands safely."""
    
    def __init__(self, sandbox):
        self.client = Anthropic()
        self.sandbox = sandbox
    
    async def execute(self, task: str) -> str:
        """Execute code in sandbox."""
        # Parse code from task
        code = await self.extract_code(task)
        
        # Execute in sandbox
        result = await self.sandbox.run(code, timeout=30)
        
        return f"Execution result:\n{result.stdout}\n\nErrors:\n{result.stderr}"
```

### 3. Message Bus Pattern

For loose coupling and extensibility:

```python
import asyncio
from typing import Callable, Dict, List
import json

class MessageBus:
    """Pub/sub message bus for agent communication."""
    
    def __init__(self):
        self.subscribers: Dict[str, List[Callable]] = {}
    
    def subscribe(self, topic: str, handler: Callable):
        """Subscribe to topic."""
        if topic not in self.subscribers:
            self.subscribers[topic] = []
        self.subscribers[topic].append(handler)
    
    async def publish(self, topic: str, message: Dict):
        """Publish message to topic."""
        if topic not in self.subscribers:
            return
        
        # Add metadata
        message['topic'] = topic
        message['timestamp'] = time.time()
        
        # Notify all subscribers
        tasks = [
            asyncio.create_task(handler(message))
            for handler in self.subscribers[topic]
        ]
        
        await asyncio.gather(*tasks, return_exceptions=True)


# Usage
bus = MessageBus()

# Subscribe agents
async def search_handler(message):
    query = message['query']
    results = await search_api.search(query)
    await bus.publish('search_results', {'results': results})

async def code_handler(message):
    results = message['results']
    analysis = await code_agent.analyze(results)
    await bus.publish('analysis_complete', {'analysis': analysis})

bus.subscribe('search_request', search_handler)
bus.subscribe('search_results', code_handler)

# Trigger workflow
await bus.publish('search_request', {'query': 'Flask security best practices'})
```

## Production Architecture

```python
from dataclasses import dataclass
from enum import Enum
import time

class AgentStatus(Enum):
    IDLE = "idle"
    WORKING = "working"
    FAILED = "failed"

@dataclass
class AgentMetrics:
    """Track agent performance."""
    total_tasks: int = 0
    successful_tasks: int = 0
    failed_tasks: int = 0
    total_latency: float = 0.0
    total_cost: float = 0.0

class ProductionAgent:
    """Production-ready agent with monitoring."""
    
    def __init__(self, name: str, client):
        self.name = name
        self.client = client
        self.status = AgentStatus.IDLE
        self.metrics = AgentMetrics()
    
    async def execute(self, task: str) -> str:
        """Execute with monitoring and error handling."""
        self.status = AgentStatus.WORKING
        start_time = time.time()
        
        try:
            # Execute with retries
            result = await self._execute_with_retry(task, max_retries=3)
            
            # Update metrics
            self.metrics.successful_tasks += 1
            self.metrics.total_latency += time.time() - start_time
            
            self.status = AgentStatus.IDLE
            return result
            
        except Exception as e:
            # Handle failure
            self.metrics.failed_tasks += 1
            self.status = AgentStatus.FAILED
            
            # Log error
            logger.error(f"Agent {self.name} failed: {e}")
            
            # Raise for coordinator to handle
            raise
        
        finally:
            self.metrics.total_tasks += 1
    
    async def _execute_with_retry(self, task: str, max_retries: int) -> str:
        """Execute with exponential backoff."""
        for attempt in range(max_retries):
            try:
                response = self.client.messages.create(
                    model="claude-3-5-sonnet-20241022",
                    max_tokens=2048,
                    messages=[{"role": "user", "content": task}]
                )
                
                # Track cost
                self.metrics.total_cost += self._calculate_cost(response)
                
                return response.content[0].text
                
            except Exception as e:
                if attempt == max_retries - 1:
                    raise
                
                # Exponential backoff
                await asyncio.sleep(2 ** attempt)
    
    def _calculate_cost(self, response) -> float:
        """Calculate API cost."""
        input_tokens = response.usage.input_tokens
        output_tokens = response.usage.output_tokens
        
        # Claude Sonnet pricing (example)
        input_cost = input_tokens * 0.003 / 1000
        output_cost = output_tokens * 0.015 / 1000
        
        return input_cost + output_cost
    
    def get_metrics(self) -> Dict:
        """Export metrics."""
        return {
            'agent': self.name,
            'status': self.status.value,
            'total_tasks': self.metrics.total_tasks,
            'success_rate': self.metrics.successful_tasks / max(self.metrics.total_tasks, 1),
            'avg_latency': self.metrics.total_latency / max(self.metrics.successful_tasks, 1),
            'total_cost': self.metrics.total_cost
        }
```

## Observability and Monitoring

```python
import structlog
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

# Set up tracing
trace.set_tracer_provider(TracerProvider())
tracer = trace.get_tracer(__name__)

# Add OTLP exporter
otlp_exporter = OTLPSpanExporter(endpoint="http://localhost:4317")
span_processor = BatchSpanProcessor(otlp_exporter)
trace.get_tracer_provider().add_span_processor(span_processor)

# Structured logging
logger = structlog.get_logger()

class ObservableCoordinator(Coordinator):
    """Coordinator with full observability."""
    
    async def process(self, task: str) -> str:
        """Process with tracing and logging."""
        with tracer.start_as_current_span("coordinator.process") as span:
            span.set_attribute("task", task)
            
            logger.info("processing_task", task=task)
            
            try:
                # Decompose
                with tracer.start_as_current_span("coordinator.decompose"):
                    subtasks = await self.decompose(task)
                    span.set_attribute("subtask_count", len(subtasks))
                    logger.info("decomposed_task", subtasks=len(subtasks))
                
                # Execute
                results = {}
                for subtask in subtasks:
                    with tracer.start_as_current_span(f"agent.{subtask['agent']}"):
                        result = await self.specialists[subtask['agent']].execute(subtask['task'])
                        results[subtask['id']] = result
                
                # Synthesize
                with tracer.start_as_current_span("coordinator.synthesize"):
                    answer = await self.synthesize(task, results)
                
                logger.info("task_completed", task=task)
                return answer
                
            except Exception as e:
                logger.error("task_failed", task=task, error=str(e))
                span.record_exception(e)
                span.set_status(trace.Status(trace.StatusCode.ERROR))
                raise
```

## Testing Multi-Agent Systems

```python
import pytest
from unittest.mock import Mock, AsyncMock

@pytest.mark.asyncio
async def test_coordinator_decomposition():
    """Test task decomposition."""
    coordinator = Coordinator({})
    coordinator.client = Mock()
    coordinator.client.messages.create = AsyncMock(return_value=Mock(
        content=[Mock(text='[{"id": "1", "agent": "search", "task": "Search docs"}]')]
    ))
    
    subtasks = await coordinator.decompose("Find Flask security info")
    
    assert len(subtasks) == 1
    assert subtasks[0]['agent'] == 'search'

@pytest.mark.asyncio
async def test_agent_execution():
    """Test agent execution with mock API."""
    agent = SearchAgent(Mock())
    agent.client = Mock()
    agent.client.messages.create = AsyncMock(return_value=Mock(
        content=[Mock(text='Flask security')]
    ))
    agent.search_api.search = AsyncMock(return_value=['result1', 'result2'])
    
    result = await agent.execute("Search for Flask security")
    
    assert result is not None
    agent.search_api.search.assert_called_once()

@pytest.mark.asyncio
async def test_message_bus():
    """Test pub/sub message bus."""
    bus = MessageBus()
    received = []
    
    async def handler(message):
        received.append(message)
    
    bus.subscribe('test', handler)
    await bus.publish('test', {'data': 'test'})
    
    await asyncio.sleep(0.1)  # Wait for async handlers
    assert len(received) == 1
    assert received[0]['data'] == 'test'
```

## Best Practices

1. **Design for failure** - Agents will fail. Implement retries, circuit breakers, fallbacks.

2. **Keep agents focused** - One agent, one responsibility. Don't build god agents.

3. **Use structured outputs** - JSON schemas, Pydantic models. Makes coordination reliable.

4. **Monitor everything** - Latency, cost, success rate, per agent.

5. **Test independently** - Unit test each agent with mocked dependencies.

6. **Version agents** - Deploy different agent versions independently.

7. **Implement timeouts** - Agents can hang. Set aggressive timeouts.

8. **Cache expensive operations** - Search results, embeddings, analysis.

9. **Cost management** - Track per-agent costs. Use cheaper models where possible.

10. **Security boundaries** - Agents may have different trust levels. Enforce permissions.

## Conclusion

Multi-agent systems transform complex AI tasks into manageable, composable components. By decomposing responsibilities, you gain testability, fault isolation, and scalability—at the cost of coordination complexity.

The patterns are well-established: coordinators orchestrate, specialists execute, message buses decouple. The tooling is maturing: LangGraph, AutoGen, CrewAI provide frameworks. The economics work: scaling cheap and expensive agents independently optimizes cost.

Start simple: coordinator + 2-3 specialists. Add observability early. Measure everything. Iterate based on bottlenecks.

Multi-agent systems aren't always the answer—sometimes a well-prompted single agent suffices. But for complex, multi-step tasks requiring different expertise, they're the right architecture.

**Further Resources:**
- [AutoGen Framework](https://microsoft.github.io/autogen/) - Microsoft's multi-agent framework
- [LangGraph](https://www.langchain.com/langgraph) - LangChain's graph-based agents
- [CrewAI](https://www.crewai.com/) - Role-based multi-agent system
- [Multi-Agent Systems Book](https://www.multiagent.com/) - Academic foundation
- [OpenTelemetry](https://opentelemetry.io/) - Observability standard
- [Anthropic Agent Patterns](https://docs.anthropic.com/claude/docs/agent-patterns) - Claude agent guidance
- [Agent Protocol](https://agentprotocol.ai/) - Standardized agent communication

---

*Agentic AI systems from November 2025, covering multi-agent architectures and production patterns.*

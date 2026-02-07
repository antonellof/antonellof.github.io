---
layout: post
title: "AI Agents: Architecture and Design Patterns"
date: 2025-03-15
categories: [Architecture]
tags: [AI Agents, Architecture, Patterns, LLM]
excerpt: "Design AI agent systems: agent patterns, tool use, memory management, planning, and architectural patterns for building production AI agents."
---

AI agents are fundamentally different from traditional LLM applications. Instead of one-shot prompts, agents reason iteratively, use tools, maintain state, and work toward goals autonomously. Building them requires rethinking your architecture from the ground up.

I built my first agent in early 2023—a simple ReAct loop that could search the web and answer questions. It worked, barely, with lots of error handling and retry logic. Fast forward to today, and the patterns have crystallized. Libraries like [LangGraph](https://github.com/langchain-ai/langgraph), [AutoGen](https://github.com/microsoft/autogen), and [CrewAI](https://github.com/joaomdmoura/crewAI) encode best practices, but understanding the fundamentals is crucial.

This post covers the core patterns that work in production—not the latest research paper, but battle-tested architectures running in real systems.

## The ReAct Pattern: Reason + Act

[ReAct](https://arxiv.org/abs/2210.03629) (Reasoning and Acting) is the foundational agent pattern. The agent alternates between thinking (reasoning about what to do) and acting (using tools to gather information or perform actions).

The loop:
1. **Thought**: Reason about the current state and what action to take
2. **Action**: Execute a tool with specific parameters  
3. **Observation**: Receive the tool's output
4. **Repeat**: Continue until the goal is achieved

Here's a minimal implementation:

```python
from anthropic import Anthropic
import json

class ReActAgent:
    def __init__(self, tools):
        self.client = Anthropic(api_key="your-key")
        self.tools = tools  # Dict of tool_name -> callable
        self.history = []
        
    def run(self, task: str, max_iterations: int = 10):
        """Execute task using ReAct loop."""
        self.history = [{
            "role": "user",
            "content": task
        }]
        
        for i in range(max_iterations):
            # Think: Ask LLM what to do next
            response = self.client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=1024,
                system=self._system_prompt(),
                messages=self.history
            )
            
            assistant_msg = response.content[0].text
            self.history.append({
                "role": "assistant", 
                "content": assistant_msg
            })
            
            # Parse action from response
            action = self._parse_action(assistant_msg)
            
            if action["type"] == "final_answer":
                return action["content"]
            
            # Act: Execute tool
            if action["type"] == "tool_use":
                tool_name = action["tool"]
                tool_args = action["args"]
                
                try:
                    result = self.tools[tool_name](**tool_args)
                    observation = f"Tool result: {result}"
                except Exception as e:
                    observation = f"Tool error: {str(e)}"
                
                # Observe: Add result to history
                self.history.append({
                    "role": "user",
                    "content": observation
                })
        
        raise TimeoutError("Agent exceeded max iterations")
    
    def _system_prompt(self):
        tool_descriptions = "\n".join([
            f"- {name}: {func.__doc__}" 
            for name, func in self.tools.items()
        ])
        
        return f"""You are a helpful assistant that can use tools.

Available tools:
{tool_descriptions}

You should:
1. Think step-by-step about the task
2. Use tools when needed to gather information
3. Return a final answer when ready

Format your responses as:
Thought: <your reasoning>
Action: <tool_name>(<args>)
OR
Thought: <reasoning>
Final Answer: <answer>"""
    
    def _parse_action(self, text: str):
        """Parse action from LLM response."""
        if "Final Answer:" in text:
            answer = text.split("Final Answer:")[-1].strip()
            return {"type": "final_answer", "content": answer}
        
        if "Action:" in text:
            action_line = text.split("Action:")[-1].strip()
            # Parse tool call (simplified)
            # In production, use proper parsing or structured output
            return {"type": "tool_use", "tool": "...", "args": {}}
        
        return {"type": "continue"}

# Example tools
def search_web(query: str) -> str:
    """Search the web for information."""
    # In production: use actual search API
    return f"Search results for: {query}"

def calculate(expression: str) -> float:
    """Evaluate a mathematical expression."""
    return eval(expression)  # Don't use eval in production!

# Run agent
agent = ReActAgent({
    "search_web": search_web,
    "calculate": calculate,
})

result = agent.run("What is the population of Tokyo times 2?")
print(result)
```

**Key insight**: The LLM decides which tool to use and when. You provide capabilities; the model chains them together.

Modern implementations use function calling (OpenAI) or tool use (Anthropic) for more reliable tool invocation. See [Anthropic's tool use guide](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) for production patterns.

## Tool Use: Extending Agent Capabilities

Tools are how agents interact with the world. A tool is any function the agent can call—search APIs, databases, code executors, file systems, external APIs.

### Defining Tools

Use structured schemas so the LLM knows how to call them:

```python
tools = [
    {
        "name": "search_web",
        "description": "Search the web for current information. Use this when you need up-to-date data or facts not in your training.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query, be specific"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "execute_python",
        "description": "Execute Python code in a sandboxed environment. Use for calculations, data processing, or algorithmic tasks.",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python code to execute"
                }
            },
            "required": ["code"]
        }
    },
    {
        "name": "read_file",
        "description": "Read contents of a file from the filesystem.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path to read"
                }
            },
            "required": ["path"]
        }
    }
]

# Use with Anthropic's tool use API
response = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "What's 15% of 482?"}]
)

# Claude returns structured tool use
if response.stop_reason == "tool_use":
    tool_use = response.content[-1]
    print(f"Tool: {tool_use.name}")
    print(f"Input: {tool_use.input}")
```

### Tool Safety

Tools can have side effects. Implement safeguards:

```python
class SafeToolExecutor:
    def __init__(self):
        self.read_only_tools = {"search_web", "read_file", "list_directory"}
        self.write_tools = {"write_file", "execute_code", "send_email"}
        
    def execute(self, tool_name: str, args: dict, require_confirmation: bool = True):
        """Execute tool with safety checks."""
        
        # Check if tool requires confirmation
        if tool_name in self.write_tools and require_confirmation:
            print(f"⚠️  Agent wants to use {tool_name} with args: {args}")
            confirm = input("Allow? (y/n): ")
            if confirm.lower() != 'y':
                return {"error": "User denied permission"}
        
        # Validate arguments
        if tool_name == "execute_python":
            # Check for dangerous imports
            if any(danger in args['code'] for danger in ['os', 'subprocess', 'eval']):
                return {"error": "Dangerous code detected"}
        
        # Rate limit
        if not self._check_rate_limit(tool_name):
            return {"error": "Rate limit exceeded"}
        
        # Execute
        try:
            result = self._execute_tool(tool_name, args)
            self._log_execution(tool_name, args, result)
            return result
        except Exception as e:
            return {"error": str(e)}
    
    def _check_rate_limit(self, tool_name: str) -> bool:
        # Implement rate limiting logic
        return True
```

Popular tool libraries:
- [LangChain Tools](https://python.langchain.com/docs/integrations/tools/) - 100+ pre-built tools
- [E2B](https://github.com/e2b-dev/e2b) - Secure code execution sandbox
- [Browserbase](https://www.browserbase.com/) - Browser automation for agents

## Memory Management

Agents need memory to maintain context across interactions. There are two types:

### Short-Term Memory (Conversation History)

Simply the message history passed to the LLM:

```python
class ConversationMemory:
    def __init__(self, max_tokens: int = 8000):
        self.messages = []
        self.max_tokens = max_tokens
        
    def add(self, role: str, content: str):
        """Add message and trim if needed."""
        self.messages.append({"role": role, "content": content})
        
        # Rough token estimation
        total_tokens = sum(len(m['content']) // 4 for m in self.messages)
        
        # Trim old messages if over limit (keep system message)
        while total_tokens > self.max_tokens and len(self.messages) > 2:
            removed = self.messages.pop(1)  # Keep index 0 (system)
            total_tokens -= len(removed['content']) // 4
    
    def get_recent(self, n: int = 10):
        """Get recent messages."""
        return self.messages[-n:]
    
    def summarize_and_compress(self, llm):
        """Summarize old messages to save tokens."""
        if len(self.messages) < 10:
            return
        
        # Summarize messages 1-5
        old_messages = self.messages[1:6]
        summary_prompt = f"Summarize this conversation:\n{old_messages}"
        summary = llm.complete(summary_prompt)
        
        # Replace with summary
        self.messages = [
            self.messages[0],  # System message
            {"role": "assistant", "content": f"Summary of earlier conversation: {summary}"},
            *self.messages[6:]  # Recent messages
        ]
```

### Long-Term Memory (External Storage)

For facts that persist across sessions, use a vector database:

```python
import pinecone
from openai import OpenAI

class LongTermMemory:
    def __init__(self):
        self.pc = pinecone.Pinecone(api_key="your-key")
        self.index = self.pc.Index("agent-memory")
        self.client = OpenAI()
        
    def remember(self, fact: str, metadata: dict = None):
        """Store a fact in long-term memory."""
        embedding = self.client.embeddings.create(
            model="text-embedding-3-small",
            input=fact
        ).data[0].embedding
        
        self.index.upsert([{
            "id": str(uuid.uuid4()),
            "values": embedding,
            "metadata": {"text": fact, **(metadata or {})}
        }])
    
    def recall(self, query: str, top_k: int = 5):
        """Retrieve relevant memories."""
        query_embedding = self.client.embeddings.create(
            model="text-embedding-3-small",
            input=query
        ).data[0].embedding
        
        results = self.index.query(
            vector=query_embedding,
            top_k=top_k,
            include_metadata=True
        )
        
        return [match.metadata['text'] for match in results.matches]

# Usage
memory = LongTermMemory()

# Agent learns user preferences
memory.remember("User prefers concise answers", {"type": "preference"})
memory.remember("User's company is called Acme Corp", {"type": "fact"})

# Later, recall relevant info
context = memory.recall("What does the user prefer?")
# Returns: ["User prefers concise answers", ...]
```

**Memory strategies:**
- **Buffer Memory**: Keep last N messages (simple, works for short conversations)
- **Summarization**: Periodically compress old messages into summaries
- **Entity Memory**: Track specific entities (people, places, facts)
- **Vector Memory**: Semantic retrieval of relevant past interactions

See [LangChain Memory docs](https://python.langchain.com/docs/modules/memory/) for more patterns.

## Production Considerations

After running agents in production serving thousands of requests:

### 1. Implement Guardrails

Agents can go off the rails. Add safety checks:

```python
class AgentGuardrails:
    def __init__(self, max_iterations=10, max_cost=1.0):
        self.max_iterations = max_iterations
        self.max_cost = max_cost  # USD
        self.current_cost = 0
        
    def check_iteration(self, iteration: int):
        """Prevent infinite loops."""
        if iteration >= self.max_iterations:
            raise AgentError(f"Exceeded max iterations: {self.max_iterations}")
    
    def check_cost(self, tokens_used: int, cost_per_1k: float):
        """Prevent runaway costs."""
        cost = (tokens_used / 1000) * cost_per_1k
        self.current_cost += cost
        
        if self.current_cost > self.max_cost:
            raise AgentError(f"Exceeded budget: ${self.current_cost:.2f}")
    
    def check_tool_call(self, tool_name: str, args: dict):
        """Validate tool calls."""
        # Check for suspicious patterns
        if tool_name == "execute_code":
            dangerous = ["import os", "eval(", "exec(", "subprocess"]
            if any(d in args.get('code', '') for d in dangerous):
                raise SecurityError("Dangerous code detected")
```

### 2. Observability and Logging

You need to see what agents are doing:

```python
import structlog
from datetime import datetime

logger = structlog.get_logger()

class ObservableAgent:
    def __init__(self):
        self.trace_id = str(uuid.uuid4())
        
    def log_step(self, step_type: str, content: dict):
        """Log each agent step."""
        logger.info(
            "agent_step",
            trace_id=self.trace_id,
            timestamp=datetime.utcnow().isoformat(),
            step_type=step_type,
            **content
        )
    
    def run(self, task: str):
        self.log_step("start", {"task": task})
        
        for i in range(max_iterations):
            self.log_step("iteration", {"number": i})
            
            # Think
            thought = self.think(task)
            self.log_step("thought", {"content": thought})
            
            # Act
            action = self.act(thought)
            self.log_step("action", {
                "tool": action.tool,
                "args": action.args
            })
            
            # Observe
            result = self.execute_tool(action)
            self.log_step("observation", {
                "result": str(result)[:500]  # Truncate long results
            })
        
        self.log_step("complete", {"result": final_answer})
```

Use tools like [LangSmith](https://www.langchain.com/langsmith), [Weights & Biases](https://wandb.ai/), or [Helicone](https://www.helicone.ai/) for agent observability.

### 3. Error Handling and Recovery

Agents fail. Handle it gracefully:

```python
class ResilientAgent:
    def execute_tool_with_retry(
        self, 
        tool_name: str, 
        args: dict,
        max_retries: int = 3
    ):
        """Execute tool with exponential backoff."""
        for attempt in range(max_retries):
            try:
                return self.tools[tool_name](**args)
            except RateLimitError as e:
                if attempt == max_retries - 1:
                    raise
                wait = (2 ** attempt) + random.random()
                time.sleep(wait)
            except Exception as e:
                logger.error("tool_error", 
                    tool=tool_name, 
                    error=str(e),
                    attempt=attempt
                )
                if attempt == max_retries - 1:
                    # Return error as observation
                    return {"error": f"Tool failed: {str(e)}"}
```

### 4. Testing Agents

Testing is hard. Agents are non-deterministic. Strategies:

```python
import pytest
from unittest.mock import Mock

def test_agent_can_search_and_answer():
    """Test agent can use search tool to answer questions."""
    
    # Mock tools with deterministic responses
    mock_search = Mock(return_value="Tokyo population: 14 million")
    
    agent = ReActAgent(tools={"search": mock_search})
    result = agent.run("What is the population of Tokyo?")
    
    # Verify tool was called
    mock_search.assert_called_once()
    
    # Verify answer contains expected info
    assert "14 million" in result or "14M" in result

def test_agent_respects_iteration_limit():
    """Test agent stops after max iterations."""
    
    agent = ReActAgent(tools={})
    
    with pytest.raises(TimeoutError):
        agent.run("Impossible task", max_iterations=3)

# Integration tests with real LLM (slow, expensive)
@pytest.mark.integration
@pytest.mark.slow
def test_agent_integration():
    """Full integration test with real LLM."""
    agent = ReActAgent(tools=real_tools)
    result = agent.run("What's 2+2?")
    assert "4" in result
```

### 5. Cost Management

LLM calls add up. Monitor and optimize:

- **Cache tool results**: Don't re-run expensive operations
- **Use cheaper models for simple tasks**: GPT-4o-mini for tool selection, GPT-4o for reasoning
- **Implement token limits**: Cap max tokens per request
- **Track costs in real-time**: Alert on spending anomalies

```python
class CostTracker:
    PRICING = {
        "gpt-4o": {"input": 0.0025, "output": 0.010},
        "gpt-4o-mini": {"input": 0.00015, "output": 0.0006},
        "claude-3-5-sonnet": {"input": 0.003, "output": 0.015},
    }
    
    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int):
        pricing = self.PRICING[model]
        cost = (input_tokens / 1000 * pricing["input"] + 
                output_tokens / 1000 * pricing["output"])
        return cost
```

## Conclusion

Building production AI agents requires more than chaining LLM calls. You need robust architecture: ReAct loops for reasoning, structured tool use, proper memory management, guardrails, and observability.

The ecosystem has matured significantly. [LangGraph](https://github.com/langchain-ai/langgraph) provides state machines for complex agent flows. [AutoGen](https://github.com/microsoft/autogen) enables multi-agent conversations. [Instructor](https://github.com/jxnl/instructor) makes structured outputs reliable. The primitives exist—use them.

Start simple: build a ReAct agent with 2-3 tools, add memory, then scale complexity. Every production agent I've built started as a simple loop and evolved based on real requirements.

The future is agentic. LLMs will increasingly work autonomously—browsing the web, writing code, managing infrastructure. The agents you build today are training wheels for tomorrow's AI systems.

**Further Resources:**
- [LangChain Agents Docs](https://python.langchain.com/docs/modules/agents/) - Comprehensive guide
- [LangGraph](https://github.com/langchain-ai/langgraph) - Build stateful agent workflows
- [AutoGen](https://github.com/microsoft/autogen) - Multi-agent framework from Microsoft
- [Anthropic Tool Use Guide](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) - Official patterns
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling) - Structured tool use
- [ReAct Paper](https://arxiv.org/abs/2210.03629) - Original research
- [LangSmith](https://www.langchain.com/langsmith) - Agent observability platform
- [Awesome LLM Agents](https://github.com/hyp1231/awesome-llm-powered-agent) - Curated resources

---

*AI agents architecture from March 2025 — updated with production guidance.*

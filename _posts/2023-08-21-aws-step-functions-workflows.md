---
layout: post
title: "AWS Step Functions: Orchestrating Serverless Workflows"
date: 2023-08-21
categories: [How-To]
tags: [AWS, Step Functions, Serverless, Workflows]
excerpt: "Our order processing was 800 lines of Lambda callback hell. I replaced it with a Step Functions state machine and finally understood what the workflow was doing."
---

The order processing system worked. That was the problem. It *worked* — orders got processed, payments cleared, shipments created — but nobody could explain how without reading 800 lines of Lambda functions chained together with SNS topics, SQS queues, and optimistic comments that said "this publishes to the next step."

Debugging a failed order meant tracing through CloudWatch logs across four Lambda functions, two queues, and a DynamoDB table used as a makeshift state tracker. Average debug time: 45 minutes. The on-call engineer kept a handwritten flowchart taped to their monitor.

I'd avoided Step Functions for years. State machines felt enterprise-y. JSON ASL (Amazon States Language) looked unpleasant. Another AWS service to learn. But the handwritten flowchart was the wake-up call — we already had a state machine. It was just hidden in imperative code, undocumented, and impossible to test.

Step Functions didn't just replace the plumbing. It made the workflow visible, testable, and something a new engineer could understand in fifteen minutes instead of three days.

## What Step Functions Actually Gives You

At its core, Step Functions is a managed state machine engine. You define states (steps), transitions (what happens next), and error handling (what happens when things break). AWS executes it, tracks state, retries failures, and gives you a visual execution graph.

**What you stop building yourself:**

- Workflow state persistence (no more DynamoDB "workflow status" tables)
- Retry logic with backoff (no more custom retry libraries)
- Parallel execution coordination (no more "wait for both SNS messages" hacks)
- Timeout handling (no more Lambda timeouts mid-workflow)
- Execution history and audit trail (no more log archaeology)

See the [Step Functions developer guide](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html) for the full service overview.

## Our Order Processing Workflow

### The State Machine

Here's the workflow that replaced our callback chain:

```json
{
  "Comment": "Order processing workflow",
  "StartAt": "ValidateOrder",
  "States": {
    "ValidateOrder": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:us-east-1:123456789:function:validate-order",
      "Next": "ProcessPayment"
    },
    "ProcessPayment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:us-east-1:123456789:function:process-payment",
      "Next": "CreateShipment"
    },
    "CreateShipment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:us-east-1:123456789:function:create-shipment",
      "End": true
    }
  }
}
```

Three steps. Linear flow. Boring. That's the point — 80% of business workflows are sequential steps with error handling, not complex graph algorithms.

Each `Task` state invokes a Lambda function. The Lambda receives the current state input, does its work, and returns output that becomes input to the next state. Step Functions handles the handoff.

**What changed in practice:**

- Each Lambda became single-purpose (~50 lines instead of ~200)
- The workflow was visible in the AWS Console — a diagram, not a flowchart on a monitor
- Failed executions showed exactly which step failed, with input/output at each state
- New engineers understood the flow without reading code

### Parallel Execution

Order confirmation needs to send an email AND update inventory. These are independent — no reason to run sequentially:

```json
{
  "ProcessInParallel": {
    "Type": "Parallel",
    "Branches": [
      {
        "StartAt": "SendEmail",
        "States": {
          "SendEmail": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:...:send-email",
            "End": true
          }
        }
      },
      {
        "StartAt": "UpdateInventory",
        "States": {
          "UpdateInventory": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:...:update-inventory",
            "End": true
          }
        }
      }
    ],
    "End": true
  }
}
```

Both branches run simultaneously. Step Functions waits for both to complete before proceeding. If either fails, the `Parallel` state fails — and your error handling kicks in.

Before Step Functions, we published two SNS messages and had a coordinator Lambda that polled DynamoDB waiting for both results. It worked until it didn't — race conditions, duplicate messages, and orphaned records were monthly occurrences.

## Error Handling: Where Step Functions Earns Its Keep

The payment step fails sometimes. Network timeouts, card declines, processor outages. Our error handling:

```json
{
  "ProcessPayment": {
    "Type": "Task",
    "Resource": "arn:aws:lambda:...:process-payment",
    "Retry": [
      {
        "ErrorEquals": ["States.TaskFailed"],
        "IntervalSeconds": 2,
        "MaxAttempts": 3,
        "BackoffRate": 2.0
      }
    ],
    "Catch": [
      {
        "ErrorEquals": ["PaymentFailed"],
        "Next": "HandlePaymentFailure"
      }
    ],
    "Next": "CreateShipment"
  }
}
```

**Retry:** transient failures (network blips, throttling) get retried automatically with exponential backoff. 2s, 4s, 8s. No custom retry code in the Lambda.

**Catch:** business-logic failures (card declined) route to a different path instead of failing the entire workflow. The `HandlePaymentFailure` state sends a "payment failed" email and marks the order accordingly.

In our old system, retry logic was copy-pasted across four Lambda functions with slightly different configurations. One had `maxRetries: 3`, another had `maxRetries: 5`, a third retried everything including card declines (bad). Step Functions centralized this in the state machine definition where you can actually see it.

### Error Handling Patterns I Use

**Retry for transient errors:**
```json
"Retry": [{
    "ErrorEquals": ["Lambda.ServiceException", "Lambda.TooManyRequestsException"],
    "IntervalSeconds": 1,
    "MaxAttempts": 3,
    "BackoffRate": 2
}]
```

**Catch for business errors:**
```json
"Catch": [{
    "ErrorEquals": ["OrderValidationError"],
    "ResultPath": "$.error",
    "Next": "NotifyValidationFailure"
}]
```

**Catch-all fallback:**
```json
"Catch": [{
    "ErrorEquals": ["States.ALL"],
    "Next": "HandleUnexpectedError"
}]
```

Every workflow gets a `HandleUnexpectedError` state. It logs, alerts, and marks the execution failed cleanly. No silent failures.

## Beyond Lambda: Step Functions Integrations

Step Functions isn't just Lambda chaining. It integrates directly with AWS services:

```json
{
  "WaitForApproval": {
    "Type": "Task",
    "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
    "Parameters": {
      "QueueUrl": "https://sqs.../approval-queue",
      "MessageBody": {
        "orderId.$": "$.orderId",
        "taskToken.$": "$$.Task.Token"
      }
    },
    "Next": "ProcessApprovedOrder"
  }
}
```

This sends a message to SQS and *pauses* the workflow until someone (or something) calls back with the task token. Human approval workflows without polling, without timeout hacks, without a "waiting for approval" DynamoDB record.

Other integrations I use regularly:

- **DynamoDB** — get/put/update items directly, no Lambda needed
- **SNS/SQS** — publish messages as workflow steps
- **EventBridge** — emit events at workflow milestones
- **Glue/Athena** — trigger data processing pipelines

Each direct integration eliminates a Lambda function. Fewer functions = fewer cold starts = fewer things to debug.

## Express vs. Standard Workflows

Step Functions has two workflow types. I picked wrong the first time:

| Feature | Standard | Express |
|---------|----------|---------|
| Max duration | 1 year | 5 minutes |
| Execution history | Full (detailed) | CloudWatch only |
| Pricing model | Per state transition | Per execution + duration |
| Exactly-once | Yes | At-least-once |
| Best for | Business workflows | High-volume event processing |

Our order processing uses **Standard** — executions last minutes to hours (waiting for payment confirmation), we need full audit history, and exactly-once semantics matter for payments.

A separate event-processing pipeline (webhook ingestion, ~10,000 events/hour) uses **Express** — sub-second executions, high volume, CloudWatch metrics are sufficient.

## Testing: The Part Nobody Talks About

Step Functions workflows are testable. Not as easily as unit tests, but better than "deploy and pray":

```bash
# Start a test execution with mock input
aws stepfunctions start-execution \
    --state-machine-arn arn:aws:states:...:order-processing \
    --input '{"orderId": "test-123", "amount": 99.99}'

# Check execution status
aws stepfunctions describe-execution \
    --execution-arn arn:aws:states:...:execution:order-processing:abc123
```

For automated testing, we used:

1. **Local Lambda testing** — each Lambda function unit-tested independently
2. **Integration tests** — deploy state machine to a test environment, trigger executions with test data, verify final state
3. **Step Functions Local** (Docker) — offline testing for CI pipelines

The project that failed because we skipped testing: a `Catch` block routed to the wrong state, and every payment failure sent customers a "shipment confirmed" email for three days. Test your error paths, not just the happy path.

## Cost: What We Actually Pay

Step Functions pricing surprised us pleasantly:

- **Standard workflows:** $0.025 per 1,000 state transitions
- Our order workflow: 5 state transitions per order
- ~10,000 orders/month = 50,000 transitions = $1.25/month

The Lambda functions cost 50x more than the orchestration layer. Step Functions is not the expensive part of serverless workflows. Developer time debugging callback chains is the expensive part.

## When NOT to Use Step Functions

- **Simple request-response** — API Gateway → Lambda → response. No workflow needed.
- **Long-running compute** — use ECS/Fargate for jobs running hours. Step Functions orchestrates them, but shouldn't BE the compute.
- **Ultra-low-latency** — state transitions add ~10-50ms overhead. Not for sub-millisecond paths.
- **When a queue is enough** — SQS + Lambda handles "process this message" without state machine complexity.

Use Step Functions when you have multi-step workflows with branching, error handling, parallel execution, or human approval steps. If your workflow is "receive message, process, done" — SQS is simpler.

## Practical Takeaways

Step Functions turned our most complex system into our most understandable one. The state machine diagram in the AWS Console is living documentation that never goes stale. Error handling is declarative and centralized. Debugging is "click the red step and read the error."

**Start here:**

1. Draw your current workflow on paper (or find the handwritten flowchart)
2. Identify steps, decision points, and error paths
3. Convert to ASL — start linear, add complexity later
4. Make each Lambda single-purpose
5. Add retry/catch before going to production
6. Test error paths explicitly

**Avoid:**

- Putting business logic in the state machine definition (belongs in Lambdas)
- Skipping the `Catch` blocks (every Task state needs error handling)
- Using Standard workflows for high-volume sub-second processing (use Express)
- Replacing simple queue processing with state machines (over-engineering)

That handwritten flowchart on the on-call engineer's monitor? We framed it. Then we replaced it with a Step Functions console link pinned in Slack. Average debug time dropped from 45 minutes to 8. The flowchart was a good state machine. It just needed to be executable.

---

*AWS Step Functions — August 2023. See the [Step Functions documentation](https://docs.aws.amazon.com/step-functions/) for ASL reference and integration list.*

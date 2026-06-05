---
layout: post
title: "AWS Lambda Cold Starts: Optimization Strategies"
date: 2023-02-08
categories: [Deep Dive]
tags: [AWS, Lambda, Performance, Cold Starts]
excerpt: "A user hit our login endpoint and waited 4.2 seconds. The Lambda wasn't slow — it was cold. Here's how I cut p99 latency from seconds to milliseconds without rewriting everything."
---

The Slack message arrived during standup: "Login takes forever on the first try." I pulled up CloudWatch, found the culprit, and felt that familiar serverless dread. P50 latency: 120ms. P99: 4,200ms. The function wasn't broken — it was cold.

Cold starts are the tax you pay for not running servers. AWS spins up an execution environment, downloads your code, runs your initialization logic, and only then executes your handler. For a lightweight function, that overhead can dwarf the actual work. For a Java function loading Spring Boot, it can feel like watching paint dry in slow motion.

I'd optimized Lambdas before — some successfully, some by throwing money at provisioned concurrency and calling it engineering. This post is what actually worked across Node.js and Java workloads, with the tradeoffs nobody puts in the architecture diagrams.

## What Actually Causes a Cold Start

A cold start happens when Lambda needs a fresh execution environment. Common triggers:

- **First invocation ever** — new function, new region, new concurrency slot
- **Idle timeout** — AWS recycled your warm container (typically after 10–15 minutes of inactivity)
- **Concurrency scaling** — traffic spike requires more containers than currently warm
- **Deployment** — new code version means new environments

Warm invocations reuse the existing container. Your database connections, cached config, and initialized SDK clients are already there. The handler runs in milliseconds. Cold invocations pay the full initialization bill every time.

The mistake I see most often: teams optimize the handler while ignoring everything that runs *before* the handler executes.

## Strategy 1: Fix Your Initialization (Free Money)

This is the highest-ROI change and it costs nothing except refactoring discipline.

```javascript
// Bad: Heavy initialization in handler
exports.handler = async (event) => {
    const db = await connectDatabase(); // Cold start penalty
    const cache = await initializeCache(); // Cold start penalty
    // ...
};

// Good: Initialize outside handler
const db = await connectDatabase();
const cache = await initializeCache();

exports.handler = async (event) => {
    // Use pre-initialized resources
    return await processEvent(event, db, cache);
};
```

I inherited a Lambda that connected to RDS, initialized AWS SDK clients, and parsed a 2MB config file — inside the handler. Every invocation paid that cost. Moving initialization to module scope cut cold starts by ~60%.

**Module-scope rules:**

- Runs once per container lifetime, not once per invocation
- Must complete before the handler can serve traffic
- Keep it fast — if module init takes 3 seconds, cold starts take 3+ seconds

**What belongs in module scope:** DB connection pools, SDK clients, parsed config, compiled regex, secrets fetched from Secrets Manager (with caching).

**What doesn't:** Request-specific data, per-user state, anything that varies per invocation.

### Lazy Loading for Heavy Dependencies

Not everything needs to load at cold start:

```javascript
let heavyLibrary = null;

async function getHeavyLibrary() {
    if (!heavyLibrary) {
        heavyLibrary = await import('some-enormous-package');
    }
    return heavyLibrary;
}

exports.handler = async (event) => {
    if (event.needsHeavyProcessing) {
        const lib = await getHeavyLibrary();
        // ...
    }
    // Fast path avoids loading the library at all
};
```

I used this pattern for a PDF generation dependency that was 40MB and used by 2% of requests. Cold starts for the common path dropped dramatically.

## Strategy 2: Shrink the Package

Lambda downloads your deployment package on every cold start. Bigger package, longer cold start. Obvious in theory, ignored in practice.

**What I do:**

```bash
# Audit package size before deploy
du -sh dist/
du -sh node_modules/

# Find the offenders
npx webpack-bundle-analyzer stats.json  # if using bundler
```

- **Bundle with esbuild/webpack** — tree-shake unused code
- **DevDependencies stay out of production** — I've seen `aws-sdk` v2 AND v3 in the same zip
- **Lambda layers for shared code** — one layer, many functions, downloaded once per container
- **Avoid fat native dependencies** — `sharp`, `puppeteer`, and friends hurt

One function I inherited was 89MB, mostly because someone committed `node_modules` with every AWS SDK service. Trimming to required clients got it to 12MB. Cold start dropped from 2.8s to 900ms. No architecture change, just housekeeping.

See [AWS Lambda deployment package limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) — 250MB unzipped, but smaller is always better.

## Strategy 3: Provisioned Concurrency (Money, But Predictable)

When you need warm containers *guaranteed*, provisioned concurrency is the lever:

```javascript
// CloudFormation / CDK
const function = new lambda.Function(this, 'MyFunction', {
    // ... configuration
});

new lambda.ProvisionedConcurrencyConfig(this, 'Provisioned', {
    function: function,
    qualifier: 'live',
    provisionedConcurrentExecutions: 10
});
```

This tells AWS: "Keep 10 execution environments initialized and ready." Cold starts disappear for traffic within that concurrency band.

**The bill:** You pay for provisioned capacity whether or not it's invoked, plus the normal per-invocation cost. Ten provisioned instances running 24/7 adds up.

**Where I use it:**

- Authentication endpoints (users notice latency immediately)
- Payment processing (cold start during checkout is unacceptable)
- Webhook receivers with tight SLA requirements

**Where I don't:**

- Background jobs that run every five minutes (cold starts are fine)
- Internal admin tools with three users
- Functions with spiky, unpredictable traffic (you'll over-provision or under-provision)

The project that taught me this lesson: we provisioned concurrency on *every* function in the account. Monthly Lambda bill went from $400 to $2,800. We kept it on three critical-path functions and accepted cold starts everywhere else. Bill dropped to $650. Good enough.

## Strategy 4: SnapStart for Java (Game Changer)

If you run Java on Lambda and haven't enabled SnapStart, stop reading and go enable it.

```yaml
# CloudFormation
Resources:
  MyFunction:
    Type: AWS::Lambda::Function
    Properties:
      SnapStart:
        ApplyOn: PublishedVersions
```

SnapStart snapshots the initialized execution environment after startup. Subsequent cold starts restore from the snapshot instead of re-running Spring's entire bean initialization dance.

I've seen Java cold starts drop from 8–15 seconds to under 1 second. For Quarkus and Micronaut apps, the improvement is similarly dramatic. Spring Boot benefits enormously.

**Caveats:**

- Only works with Java 11+ managed runtimes
- Applies to published versions, not `$LATEST` (use aliases)
- Functions with uniqueness requirements (timestamps in static init, random seeds) need review
- Must publish a version after enabling SnapStart

Read the [SnapStart documentation](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) — it's the single biggest Java Lambda improvement in years.

## Strategy 5: Right-Size Memory (Counterintuitive)

Lambda allocates CPU proportionally to memory. More memory = more CPU = faster initialization. Sometimes bumping memory from 128MB to 512MB makes cold starts faster *and* can reduce total cost because invocations finish quicker.

I test this with a simple matrix:

| Memory | Cold Start | Warm Duration | Monthly Cost |
|--------|-----------|---------------|--------------|
| 128MB  | 2.1s      | 450ms         | $12          |
| 512MB  | 0.8s      | 120ms         | $9           |

Higher memory, lower bill. Run your own numbers — this varies by workload.

## Strategy 6: Architecture Changes (When Nothing Else Works)

Sometimes the function itself is the problem.

**Split fat functions.** A monolithic "API handler" that routes twenty endpoints loads everything for every request. Separate functions per domain — auth loads auth deps, reporting loads reporting deps.

**Lambda Function URLs + CloudFront.** CloudFront can't warm your Lambda, but it can cache responses and absorb traffic spikes that would otherwise trigger scaling cold starts.

**The nuclear option: don't use Lambda.** I moved one latency-sensitive service to Fargate with a minimum task count of 1. Cost went up $30/month. P99 went from 3s to 80ms. Sometimes the right answer isn't optimization — it's a different compute model.

## Monitoring: You Can't Fix What You Don't Measure

Enable [Lambda Insights](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-insights.html) or instrument with X-Ray:

```javascript
// Log init duration vs handler duration
exports.handler = async (event) => {
    const handlerStart = Date.now();
    // ... work ...
    console.log(JSON.stringify({
        initDuration: handlerStart - global.startTime,
        handlerDuration: Date.now() - handlerStart,
        coldStart: !global.warm
    }));
    global.warm = true;
};
```

Track these metrics:

- **Init duration** — time spent before handler runs
- **Cold start rate** — percentage of invocations that are cold
- **Billed duration vs actual work** — are you paying for initialization on warm invocations?

I set a CloudWatch alarm when cold start rate exceeded 15% on user-facing functions. That caught a deployment that accidentally removed provisioned concurrency before a marketing campaign.

## The Warm-Ping Debate

Teams sometimes schedule EventBridge rules to invoke functions every five minutes, keeping containers warm. I don't recommend this:

- It's fragile (one missed ping = cold start)
- It costs money on invocations
- It doesn't help during traffic spikes beyond your ping concurrency
- Provisioned concurrency exists for exactly this use case

If you're paying for warm pings, do the math on provisioned concurrency instead. It's usually cheaper and more reliable.

## What I'd Do Tomorrow on a New Project

1. **Module-scope initialization** — non-negotiable, day one
2. **Bundle and trim packages** — CI gate on deployment zip size
3. **512MB default memory** — tune down after measuring, not up after complaining
4. **Provisioned concurrency on auth/payment only** — expand if metrics justify it
5. **SnapStart for any Java function** — enable before the first production deploy
6. **Alarms on p99 latency** — cold starts show up in percentiles, not averages

## Practical Takeaways

Cold starts aren't a bug — they're a tradeoff you accepted when you chose serverless. The goal isn't zero cold starts everywhere; it's zero cold starts where users feel them, and acceptable cold starts everywhere else.

The initialization refactor is free and fixes most pain. SnapStart fixes Java. Provisioned concurrency fixes the rest, for a price. Package size optimization is hygiene that compounds over time.

That login endpoint? Module-scope DB connection, trimmed bundle, 512MB memory, provisioned concurrency of 5. P99 dropped to 180ms. The user who filed the ticket became a serverless evangelist. Sometimes engineering is just making the first click feel instant.

---

*AWS Lambda cold start optimization — February 2023. Lambda runtimes and features evolve; check the [AWS Lambda documentation](https://docs.aws.amazon.com/lambda/) for current SnapStart runtimes and limits.*

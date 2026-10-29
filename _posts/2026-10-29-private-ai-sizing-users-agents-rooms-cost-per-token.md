---
layout: post
title: "Private AI Sizing: Users, Agents, Rooms, Cost per Token"
date: 2026-10-29
categories: [Architecture]
image: /assets/images/posts/private-ai-sizing-header.jpg
tags: [AI Infrastructure, Private AI, Sovereign AI, GPU Sizing, LLM Inference, KV Cache, Agentic AI, TCO, Cost per Token, Energy per Token, Data Center, AI Factory, Banking, Healthcare, Public Sector]
excerpt: "The first question a CTO asks about private AI is how many GPUs to buy. The answer comes from the other end: how many requests are in flight, whether the workload is chat or agents, what the regulator requires, the room the hardware goes in, and the cost and energy per token at the utilisation you will really get. Worked numbers for a bank, with prices as of October 2026."
---

<figure>
  <img src="{{ '/assets/images/posts/private-ai-sizing-header.jpg' | absolute_url }}" alt="Private AI Sizing. Six numbered steps, workload, memory then benchmark, the room, data placement, cost per token, operating model, lead to the GPU count as the output.">
</figure>

The conversation about private AI starts the same way almost every time. A team has a few use cases running on cloud GPUs, the bill is growing, and the business wants a predictable cost and control over where the data goes. The first question on the table is how many GPUs to buy.

I think this is the wrong first question. The number matters, and it is an output. Start from the GPU count and you get a quote. Start from the workload and you get a design, a cost you are able to defend, and a platform someone will run.

Most sizing guides skip the two steps where the real uncertainty lives: how many requests are in flight at the same time, and what the industry's regulator forces on the design. This post covers both, with a bank as the running example, and then memory, the room, data placement, cost, energy and operations. A note on numbers. Hardware prices, cloud rates and electricity costs in this post are market observations from October 2026, and they will be out of date within months. GPU rental rates fell by a third in the past year alone. The formulas, the Little's law chain and the breakeven logic do not age. Keep the method, replace the inputs.

## 1. Write down the workload before you talk to a vendor

Four numbers decide most of the design. Get them from the people who own the use case.

- Which model, and at which precision. A 70 billion parameter model in 8-bit floating point is about 70 GB of weights. In 16-bit, double that.
- How many requests are in flight at the same time, at peak. Not registered users, not daily users. Requests being served right now.
- How long the prompts and answers are. Retrieval-augmented generation makes prompts long, and long prompts eat memory.
- Which latency the users will accept. Time to first token for a chat assistant is a different target from throughput for a nightly batch job.

Add one constraint: where the data is allowed to live. For the bank, in the country, on hardware the bank controls.

<figure>
  <img src="{{ '/assets/images/posts/private-ai-sizing-six-steps.png' | absolute_url }}" alt="Six questions before the GPU count: workload, memory then benchmark, the room, data placement, cost per token, operating model. Each card lists its inputs and the output it produces. The GPU count is the result at the bottom.">
  <figcaption>Each step produces one number or one decision. The bill of materials falls out at the end.</figcaption>
</figure>

### From employees to requests in flight

The second number is the one nobody has. Sponsors know how many employees will get the assistant. The platform needs to know how many requests are being served at the same second. Little's law from queueing theory crosses the gap: requests in flight = arrival rate x time per request.

Take a bank with 5,000 employees licensed for an internal assistant.

- Adoption. One consultancy's copilot benchmarks put active users at [40 to 60 percent of licensed seats after six months](https://www.copilotconsulting.com/insights/microsoft-copilot-adoption-rates-benchmarks-2026), with daily actives at 30 to 40 percent of monthly actives, and slower uptake in financial services and healthcare. Call it 2,500 monthly users and 1,000 on a given day.
- Frequency. A session has 3 to 5 prompts, and most people run one or two sessions a day. Call it 6 prompts per daily user, so 6,000 requests a day.
- Peak hour. Office traffic concentrates. Assume 20 percent of the day lands in the busiest hour: 1,200 requests, one every three seconds.
- Duration. A 1,500-token prompt and a 300-token answer at 30 tokens per second take about 10 seconds end to end.

Little's law: 0.33 requests per second x 10 seconds = 3 or 4 requests in flight at peak. With a safety factor of three for lumpy arrivals and launches, plan for 10 to 12. For 5,000 employees. One 8-GPU node serves this with most of its capacity idle.

"200 concurrent users" on a vendor slide means 200 requests in flight, which by this arithmetic is a bank with 50,000 to 100,000 daily users or a customer-facing assistant, not an internal copilot. Microsoft's [provisioned throughput sizing](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/provisioned-throughput-sizing) asks for the same inputs: peak requests per minute, prompt size, response size, cache rate. Their worked example of 1,000 requests per minute is consumer scale.

Write the chain down: licensed, monthly active, daily active, prompts per day, peak hour share, seconds per request, requests in flight. Every link is an assumption the business owns and a number you will measure after launch.

### Agents change every number in the chain

An agent is a loop: the model reads, calls a tool, reads the result, plans again, and repeats until the task is done. Three things change.

Tokens per task. A chat exchange is a few hundred to a couple of thousand tokens. A five-step agent task in a fraud-check example runs to [about 13,500 tokens](https://www.spheron.network/blog/agentic-ai-inference-cost-2026/), and analyst estimates for enterprise agents sit in a 5 to 30 times range over chat. At the far end, a Stanford and Michigan study of coding agents on SWE-bench found [roughly a thousand times more tokens than a code chat](https://arxiv.org/abs/2604.22750), with input tokens and cache reads driving most of the cost and token use between runs of the same task varying up to 30 times.

Duration. A chat request lasts ten seconds. An agent run lasts minutes, so the same number of tasks per hour produces many more runs in flight, each holding a growing context in memory.

Concurrency. Each run makes many model calls in sequence and re-sends most of the previous context each time. Prefix caching and cache-aware routing stop being optional.

Back to the bank. Give 200 operations staff an agent that checks a transaction against policy, pulls three documents and drafts a note: 20 runs a day each, 4,000 runs a day, 800 in the peak hour, each about 3 minutes and 15,000 tokens. Little's law: 0.22 runs per second x 180 seconds = 40 runs in flight at 10 to 20 thousand tokens of context each, and 12 million tokens in the peak hour, or 3,300 tokens per second sustained. That is more load than the 5,000-employee assistant, from a group 25 times smaller.

The rule: size chat assistants from users and sessions, size agents from tasks per hour and tokens per task, and expect the agent line to dominate within a year.

### Peaks, and what happens above them

Everything above is sized for the peak hour, and the peak hour is itself an average. Inside it, arrivals bunch. Monday at nine, the minutes after an all-hands email, a batch job someone scheduled at noon, an agent that fans out forty calls at once. A platform sized for 12 requests in flight will see 30 for a few seconds several times a day, and once a quarter it will see 100.

Two numbers to agree with the business, not one. The peak you size for, and the peak you refuse. The first sets the GPU count. The second sets what the platform does when the first is exceeded, and that decision is part of the architecture.

The choice is between three behaviours. Queue the request, with a bound, so the user waits a few seconds instead of timing out. Shed it with a clear retry signal, so the client backs off instead of retrying into a system that is already full. Or degrade it: a smaller model, a shorter context, a lower priority class for the batch job so the clinician or the adviser keeps their latency. Which of the three applies to which workload is a business decision, and in a regulated environment it is also an audit question, because "what did the platform do under load" will be asked after an incident.

Routing picks the GPU. Admission control decides whether to take the request at all, based on free cache memory, remaining compute and concurrency limits. I wrote about how the serving engines and orchestrators implement it, and why agents need a different approach, in [Admission control for distributed LLM inference](https://www.fratepietro.com/2026/llm-admission-control-distributed-inference/). For sizing, the short version is this: the GPU count buys you the sized peak, and admission control buys you survival above it. Without the second, the first is a number on a slide. A platform with bounded queues and priority classes needs less headroom than one without, which is money.

Three practical rules follow. Size for the peak hour, not the peak second, and let admission control absorb the difference. Give agents their own concurrency budget, because one runaway agent run can take the capacity of a hundred chat users. And measure the refused and queued requests from day one, because that count is the earliest signal that the agent line is growing faster than planned.

## 2. Size the memory, then benchmark

Inference is a memory problem first. Each GPU holds the weights plus the key-value cache, the working memory of every conversation in flight. For a Llama-class 70B model the cache is about 0.32 MB per token in 16-bit. One H100 with 4-bit weights fits [about 28 requests at 4K context and almost none at 128K](https://www.spheron.network/blog/how-many-concurrent-users-can-one-h100-serve-a-kv-cache-sizi/), which is why context length is on the list in step 1.

KV cache per token = 2 x layers x KV heads x head dimension x bytes per value

For the bank's two workloads together, 12 chat requests at 8K context and 40 agent runs at 16K, the cache is about 750,000 tokens, around 240 GB in 16-bit or 120 GB in 8-bit. Add 70 GB of weights. One 8-GPU H200 node has about 1.1 TB of high-bandwidth memory, so the bank fits in one node with room to grow, two with redundancy. Memory is rarely the constraint for an internal platform. Throughput at the agreed latency is.

So stop trusting the paper here. Run the bank's own model with the bank's own prompts on the target hardware, and measure time to first token and tokens per second against the latency from step 1. NVIDIA's [benchmarking guide](https://developer.nvidia.com/blog/llm-inference-benchmarking-how-much-does-your-llm-inference-cost) gives the method: sweep concurrency, plot throughput against time to first token, pick the highest throughput that still meets the target (250 ms for chat in their example), and divide peak requests per second by requests per second per server. Vendor benchmarks tend to use shorter prompts than yours.

A pilot should leave you with a benchmark on your prompts, a reference architecture, and a clear view of what the platform will cost to run.

## 3. The industry decides more than the model does

The arithmetic is the same in every sector. Who the users are, what they ask, and which rules shape the design are not.

### Banking and insurance

The users are relationship managers, analysts, operations and compliance staff. The use cases that pass risk review first are grounded in internal documents: client materials, policy checks, know-your-customer summaries, code assistance. In October 2026 Deutsche Bank [deployed an AI platform inside its own technology environment](https://www.marketsmedia.com/deutsche-bank-deploys-ai-on-premise-in-ib-capital-markets/) for investment banking teams, so that sensitive data, proprietary knowledge and workflow activity stay inside the bank.

The rules are concrete. The ECB's [guide on cloud outsourcing](https://www.jonesday.com/en/insights/2025/11/new-ecb-guide-on-outsourcing-cloud-services-to-cloud-service-providers), published in July 2025 and used as a benchmark in the 2026 supervisory cycle, expects data storage restricted to approved jurisdictions with traceability, an assessment of third-country legal risk, an exit strategy with timelines and costs before go-live for every critical service, concentration risk assessed across providers, disaster recovery tested yearly including provider failure, and encryption in transit, at rest and where feasible in use. Under the Digital Operational Resilience Act an AI platform is an ICT system, so it enters the register of information with its dependency chain, model provider and hosting region included, and incidents on it are reportable. In November 2025 the European supervisors [designated 19 critical ICT third-party providers](https://www.dawiso.com/blog-post/ai-agents-in-banking-dora-compliance-2026), the three large hyperscalers among them.

For the design this means a private or in-country deployment is the simplest answer to the data-location and exit questions, open-weight models are themselves an exit path, and key management, audit trail and exit plan are part of the architecture.

### Healthcare

The users are clinicians, and the use cases that work are anchored to a source text. A German university hospital with more than 10,000 employees [deployed DeepSeek-R1 on-premise through vLLM](https://arxiv.org/abs/2604.22768) behind network segmentation and egress filtering, and got management, data protection and security to approve processing unanonymised patient data. Report corrections, simplifications and guideline lookups scored well. Open-ended generation of conclusions produced clinically relevant errors. Twenty-two users in one week, so early, but the architecture is published.

For the design: isolation first, then capacity. A hospital platform is small in GPUs and large in network and security engineering, and the peak-hour share is higher than in an office.

### Public sector

The scale is different. "OpenAI for Germany" for the public sector runs on [SAP's Delos Cloud, planned to grow to 4,000 GPUs](https://www.techradar.com/pro/germany-is-getting-its-own-sovereign-version-of-openai), for millions of public employees. That is a sovereign-cloud pattern: a dedicated in-country environment under national law, shared by many agencies. For a single ministry the question is which tenant quota, and which workloads need their own hardware anyway, usually those with classified data.

### Research institutions

The users already live in a batch scheduler. The mix is simulation, training and a growing inference tail, and data gravity dominates: datasets of tens of terabytes sit on a campus network. The pattern is colocation with redundant links to the campus, as in Helmholtz Munich's move of about 300 servers, plus public AI Factories such as JUPITER in Jülich for runs no single institute will fund. Tenders set the calendar, and the calendar is longer than a hardware generation.

| Sector | Typical users | Use cases that clear risk review first | What shapes the design |
| --- | --- | --- | --- |
| Banking and insurance | Advisers, analysts, operations, compliance | Grounded document work, policy checks, code assistance | ECB cloud guide, DORA register and incident reporting, exit strategy, key management, in-country data |
| Healthcare | Clinicians, researchers | Source-anchored tasks: report correction, simplification, guideline lookup | Patient data approval, network isolation, bursty clinical hours |
| Public sector | Civil servants across agencies | Drafting, search over regulations, citizen-service support | Sovereign cloud tenancy under national law, separate hardware for classified data |
| Research | Researchers, students | Training runs, simulation, inference for analysis | Data gravity to the campus, Slurm, public AI Factories, tender calendars |

## 4. Ask about the room before you ask about the rack

Power and cooling are not a detail. An H100 or H200 draws up to 700 W, a B200 1,000 to 1,200 W. An [8-GPU H100 node draws about 10 kW with server overhead, a B200 node 13 to 15 kW](https://www.spheron.network/blog/ai-inference-power-electricity-cost-2026/), and a GB200 NVL72 rack around 120 kW with liquid cooling to the chip. Most enterprise rooms were built for 5 to 15 kW per rack.

Four questions for the facility before anyone draws a rack:

- Kilowatts per rack, today and after the next upgrade of the room?
- A water loop, or a plan for one? Rear-door heat exchangers reach roughly 40 kW. Above that it is direct liquid cooling and coolant distribution units.
- Does the floor hold the weight?
- How long does extra power take to arrive? In some cities, years.

The bank's room is built for 8 kW per rack. So on-premise means air-cooled nodes spread across racks, or the GPU platform in a colocation site in the same country with a dedicated line, or inference near the users and anything heavier in colocation. Three options, three prices, and the constraints pick one. The 120 kW rack was never on the list: the bank does not need 72 GPUs in one NVLink domain to serve a 70B model.

## 5. Decide where the data lives, then where the compute goes

Data accumulates. Every dataset, model and log lands in one place, and after a year or two moving any of it takes months. The egress fee is the small part. Re-engineering pipelines and re-validating models is the large part.

Decide data placement early and put compute next to the data when the data is large or regulated. For a research institute that means colocation with links to the campus. For the bank it means the same country and the same legal control, whatever the building.

Sovereignty follows, and it is more than a location: who can access data and models, including support staff and foreign law, who holds the keys, where hardware and support come from, and whether you are able to leave. Open-weight models help because you know what you are running. Write the controls down at design time. In banking the ECB guide above is the list.

## 6. Cost per token, with real prices and the utilisation you will really get

The business case is the part most engineers skip and the part the board reads. Everything comes from the loaded cost per GPU-hour:

cost per GPU-hour = (hardware amortised over 3 to 5 years + power + space + network + software + people) / (GPUs x hours x utilisation)

Fill it in with the numbers you have today. Here is what they looked like in October 2026, so you have a worked example to replace. An [8-GPU H100 system costs 250,000 to 320,000 dollars new](https://www.cloudzero.com/blog/h100-gpu-cost/), about 285,000 typical, with H200 and B200 systems quote-based above that. NVIDIA's own worked example uses 320,000 dollars over four years plus 7,500 a year of hosting and software. Electricity at 0.12 dollars per kWh with a PUE of 1.4 comes to [about 150 dollars per GPU per month](https://www.spheron.network/blog/ai-inference-power-electricity-cost-2026/), roughly 0.21 dollars per GPU-hour, and about double that at European industrial rates. Add one platform engineer at 120,000 a year for two nodes, which is 0.86 dollars per GPU-hour on 16 GPUs.

At 100 percent utilisation that is about 2.20 dollars per GPU-hour in the US and 2.40 in Europe. Real utilisation is the divisor:

| Average utilisation | Loaded cost per GPU-hour, US power (Oct 2026) | Europe power (Oct 2026) |
| --- | --- | --- |
| 70 percent | 3.10 dollars | 3.40 dollars |
| 50 percent | 4.40 dollars | 4.80 dollars |
| 30 percent | 7.30 dollars | 8.00 dollars |

Compare with the cloud: the [market median for an H100 is about 3.25 dollars per GPU-hour](https://www.cloudzero.com/blog/h100-gpu-cost/) on demand across providers, 4.40 for an H200 and around 5.70 for a B200 on spot, with the large hyperscalers at 6 to 7 dollars. So, at these prices, a private platform beats on-demand cloud above roughly 60 to 70 percent utilisation and loses below 50, before counting data control. The crossover moves as both sides reprice: when cloud rates fall faster than hardware prices, the bar for private rises, and the utilisation sensitivity is what tells you where it sits this quarter. One [unit-economics analysis](https://introl.com/blog/inference-unit-economics-true-cost-per-million-tokens-guide) puts the breakeven for self-hosting against managed APIs above 8,000 conversations a day, which matches the arithmetic from step 1.

<figure>
  <img src="{{ '/assets/images/posts/private-ai-sizing-cost-per-token.png' | absolute_url }}" alt="Bar chart of relative cost per token for the same private cluster at 20 to 80 percent average GPU utilisation. At 20 percent the cost is 3.5 times the cost at 70 percent, at 30 percent 2.3 times, at 40 percent 1.75 times, at 50 percent 1.4 times, at 60 percent 1.17 times, at 80 percent 0.88 times.">
  <figcaption>Same hardware, same power, same people. Only the tokens change.</figcaption>
</figure>

Now the arithmetic from step 1 bites. The 5,000-employee assistant alone would run a node at a few percent utilisation outside the peak hour. The private case closes only when the platform carries steady work: the agent line, batch jobs at night, several use cases on shared capacity. Chat assistants justify a cloud subscription. Agents, batch and regulated data justify a platform.

The comparison for a board is three to five years of cost, cloud against private, with a sensitivity on utilisation, egress and committed-use discounts on the cloud side, people on the private side. In most cases the answer is a hybrid: private for the steady load, cloud or GPU-as-a-service for the bursts.

## 7. Energy per token

Cost per token is energy per token with a price attached, and the energy number is becoming a reporting line of its own.

Three reference points. Google measured a median Gemini text prompt at [0.24 watt-hours](https://arxiv.org/abs/2508.15734), about 860 joules, with 0.14 Wh on the accelerator and the rest in host, idle capacity and facility overhead, and a 33 times reduction per prompt over twelve months, 23 times from model changes and 1.4 times from utilisation. Microsoft Research puts [optimised frontier inference at a median 0.31 Wh per query](https://www.microsoft.com/en-us/research/?p=1170806), says public estimates overstate production energy by 4 to 20 times, and finds that long reasoning and agent queries raise energy per request by more than an order of magnitude. At the token level, a Carnegie Mellon [measurement on H200](https://arxiv.org/abs/2608.28044) puts Llama 3.1 8B at about 1.4 joules per output token at batch 16 and 2K context, and 5 to 6 joules per token at batch 1, a four times gap from batching alone.

For the bank's node the estimate is direct, and it depends on the node's power draw and your tariff more than on anything a vendor publishes. A 10 kW node at PUE 1.3 draws 13 kW. At the 3,300 tokens per second of the agent peak that is about 4 joules per token, or 1.1 kWh per million tokens, roughly 0.25 dollars of electricity per million tokens at European rates. At 30 percent utilisation the node draws most of that power anyway, so energy per token roughly triples. The levers, in order: a smaller or quantized model, prefix caching, batching, and only then the hardware generation.

The hardware is moving too. NVIDIA's [Rubin platform](https://nvidianews.nvidia.com/news/rubin-platform-ai-supercomputer), shipping from partners in the second half of 2026, carries 288 GB of HBM4 per GPU, 3.6 exaflops of 4-bit inference per 72-GPU rack, and a claim of up to 10 times lower cost per token than Blackwell for mixture-of-experts models. Spectrum-X Photonics switches with co-packaged optics claim 5 times better power efficiency than pluggable transceivers. Treat these as upper bounds until you run your own prompts, and remember that a faster rack is a denser rack: Rubin and Blackwell NVL72 are liquid-cooled, so step 4 comes back before the gain arrives.

## 8. Design the operating model with the hardware

On day two someone owns driver and firmware updates, the scheduler, capacity planning, incidents, patching, and a monthly report on utilisation, cost per token and energy per token. Decide who before the purchase order, because the answer changes the design.

Researchers in Slurm and enterprise teams in Kubernetes with the GPU Operator need different platforms, and many organisations need both. If nobody in-house will run it, a managed service is part of the architecture, with service levels in the same document as the bill of materials. In a bank the operating model also answers the DORA questions: who reports an incident on the platform, within which deadline, with which evidence.

## What the existing guides cover, and what they skip

[VMware's sizing guidance](https://blogs.vmware.com/cloud-foundation/2024/09/25/llm-inference-sizing-and-performance-guidance/) sets the latency targets most people quote, under 200 ms to first token and 30 tokens per second per user. The [KV-cache walkthrough](https://www.spheron.network/blog/how-many-concurrent-users-can-one-h100-serve-a-kv-cache-sizi/) gives per-model cache figures and a concurrency ceiling per GPU. The [users-to-GPU method](https://garagegeekblog.com/2026/05/07/llm-sizing-101-part-2-from-tokens-per-second-to-gpu-count/) converts concurrent users to system tokens per second with 20 to 30 percent headroom. NVIDIA's [benchmarking post](https://developer.nvidia.com/blog/llm-inference-benchmarking-how-much-does-your-llm-inference-cost) turns a benchmark into cost per million tokens, and Microsoft's [throughput sizing](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/provisioned-throughput-sizing) is the cleanest statement of the inputs.

All of them start from concurrent users or peak requests per minute as a given. None of them gets there from a headcount, treats agents as a different workload, says what the platform does above its sized peak, or includes the room, the regulator, the energy line or the operating model. Those are the steps where private AI projects stall.

## The bank on one page

Workload: 5,000 employees on a 70B assistant, 8-bit, about 12 requests in flight at peak, plus 200 operations staff on an agent, about 40 runs in flight at 16K context, 2 seconds to first token, data in country. Above the sized peak: bounded queue for chat, priority classes with agents and batch below interactive users, shed with a retry signal beyond that.

Compute: two 8-GPU H200 nodes, one for capacity and one for redundancy, validated on the bank's prompts, with headroom for the agent line to triple.

Network: NVLink inside the node, Ethernet between nodes, because inference replicas stay inside a node and the operations team already runs Ethernet.

Storage: an all-flash tier for model loading and cache offload. A parallel file system waits until fine-tuning starts.

Facility: the 8 kW room will not host the nodes in one rack, so in-country colocation with a dedicated line, or air-cooled nodes across racks. Priced both ways.

Regulation: register of information entry, exit strategy with costs, keys under the bank's control, incident reporting path, all written before go-live.

Cost and energy: loaded cost per GPU-hour, cost and energy per token at 40, 60 and 80 percent utilisation, against the current cloud bill including egress.

Operations: who runs it, which service levels, a quarterly utilisation review, and a count of queued and refused requests in the monthly report.

Every line traces to a requirement or a measurement, and every price carries a date. The GPU count appears in the second line, and it is the least interesting number on the page.

When someone asks how many GPUs they need, the useful reply is a question: for what, for whom and how often, chat or agents, under which regulator, in which room, and who will run it.

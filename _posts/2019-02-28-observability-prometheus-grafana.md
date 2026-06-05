---
layout: post
title: "Observability in Microservices: Prometheus and Grafana"
date: 2019-02-28
categories: [Architecture]
tags: [Prometheus, Grafana, Observability]
excerpt: "Our microservices were 'fine' until we couldn't tell which one was on fire. Prometheus and Grafana turned guesswork into graphs—and graphs into sleep."
render_with_liquid: false
---

"We're getting errors."

"Which service?"

"...the backend one?"

If you've had this conversation in Slack, congratulations—you've discovered why **monitoring isn't optional** once you split a monolith into seventeen deployable units that all insist they're healthy because their process didn't crash.

Logs tell you what happened. Traces tell you where it happened. **Metrics tell you how often, how bad, and whether it's getting worse**—usually before users paste your outage into Twitter.

In 2019, our stack for that third pillar was Prometheus (collect and alert) plus Grafana (make humans understand). This post is how we wired it up, what we instrumented, and the mistakes that taught us cardinality is not your friend.

## The three pillars (and why metrics come first)

**Observability** means you can answer novel questions about system behavior without redeploying code. Practically:

- **Metrics** — numbers over time: request rate, error rate, latency, CPU
- **Logs** — discrete events: stack traces, audit trails, "why did user 48291 fail?"
- **Traces** — request paths across services: where did those 800ms go?

You need all three eventually. But metrics are the fastest path to "is the thing on fire right now?" Start there.

## Prometheus: pull, don't push (mostly)

Prometheus scrapes HTTP endpoints on a schedule. Your app exposes `/metrics`; Prometheus polls it every N seconds and stores time-series data. No agent shipping logs around—just a pull model that scales surprisingly well.

Core pieces:
- Pull-based collection
- Built-in time-series database
- PromQL for queries
- Alerting rules that feed Alertmanager

## Stand up the stack

### Prometheus config

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
  
  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']
  
  - job_name: 'api-service'
    static_configs:
      - targets: ['api-service:8080']
    metrics_path: '/metrics'
```

Fifteen-second scrape interval is a reasonable default. Aggressive enough to catch spikes, gentle enough that you won't DDoS yourself. Tune per service if you have opinions.

### Docker Compose (the fastest way to experiment)

```yaml
version: '3'
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
  
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
  
  node-exporter:
    image: prom/node-exporter:latest
    ports:
      - "9100:9100"
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro

volumes:
  prometheus-data:
  grafana-data:
```

Spin this up, hit Grafana on port 3000, add Prometheus as a data source (`http://prometheus:9090`), and you're already ahead of teams still grepping production logs for "ERROR."

## Instrument your apps (this is where it gets useful)

Default process metrics are fine for "is the box alive?" Custom metrics answer "is *our code* alive?"

### Node.js with prom-client

```javascript
const express = require('express');
const client = require('prom-client');

// Create registry
const register = new client.Registry();

// Add default metrics
client.collectDefaultMetrics({ register });

// Create custom metrics
const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5]
});

const httpRequestTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status']
});

const activeConnections = new client.Gauge({
    name: 'active_connections',
    help: 'Number of active connections'
});

register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestTotal);
register.registerMetric(activeConnections);

const app = express();

// Middleware
app.use((req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        const labels = {
            method: req.method,
            route: req.route?.path || req.path,
            status: res.statusCode
        };
        
        httpRequestDuration.observe(labels, duration);
        httpRequestTotal.inc(labels);
    });
    
    next();
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

app.listen(8080);
```

The histogram is the important bit. Counters tell you volume; histograms let you compute percentiles—the difference between "average latency looks fine" and "p99 is murdering mobile users."

### Python

```python
from prometheus_client import start_http_server, Counter, Histogram, Gauge
import time

# Metrics
http_requests_total = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

http_request_duration = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration',
    ['method', 'endpoint']
)

active_connections = Gauge(
    'active_connections',
    'Active connections'
)

# Instrument your code
def handle_request(method, endpoint):
    with http_request_duration.labels(method=method, endpoint=endpoint).time():
        # Your code here
        http_requests_total.labels(
            method=method,
            endpoint=endpoint,
            status=200
        ).inc()

# Start metrics server
start_http_server(8000)
```

Expose `/metrics` on a port that isn't your public API. Security groups exist for a reason.

## PromQL: the language of "is it bad?"

PromQL looks weird for a day, then becomes second nature.

### The queries you'll actually use

```promql
# Rate of HTTP requests per second
rate(http_requests_total[5m])

# Average request duration
rate(http_request_duration_seconds_sum[5m]) / 
rate(http_request_duration_seconds_count[5m])

# 95th percentile latency
histogram_quantile(0.95, 
  rate(http_request_duration_seconds_bucket[5m])
)

# Error rate
rate(http_requests_total{status=~"5.."}[5m]) / 
rate(http_requests_total[5m])
```

`rate()` is your best friend. Raw counters only go up; `rate()` tells you how fast. The `[5m]` window smooths noise—shorter windows react faster but cry wolf more often.

### Infrastructure queries

```promql
# CPU usage percentage
100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Memory usage
(node_memory_MemTotal_bytes - node_memory_MemFree_bytes) / 
node_memory_MemTotal_bytes * 100

# Disk I/O
rate(node_disk_io_time_seconds_total[5m])

# Network traffic
rate(node_network_receive_bytes_total[5m])
```

## Alerting: wake humans only when necessary

A dashboard nobody looks at is art. An alert that pages you every Tuesday because someone ran a batch job is a morale problem.

### Alert rules

```yaml
# alerts.yml
groups:
  - name: api_alerts
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: |
          rate(http_requests_total{status=~"5.."}[5m]) / 
          rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }}"
      
      - alert: HighLatency
        expr: |
          histogram_quantile(0.95,
            rate(http_request_duration_seconds_bucket[5m])
          ) > 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High latency detected"
          description: "95th percentile latency is {{ $value }}s"
      
      - alert: ServiceDown
        expr: up{job="api-service"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Service is down"
          description: "{{ $labels.job }} is down"

  - name: infrastructure_alerts
    rules:
      - alert: HighCPUUsage
        expr: 100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU usage"
      
      - alert: LowDiskSpace
        expr: |
          (node_filesystem_avail_bytes{mountpoint="/"} / 
           node_filesystem_size_bytes{mountpoint="/"}) < 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Low disk space"
```

The `for: 5m` clause is critical. It means "condition must be true for five continuous minutes before firing." Without it, every deploy blip becomes a PagerDuty ticket and engineers start ignoring alerts—which is worse than no alerts.

### Alertmanager routing

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'cluster']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h
  receiver: 'slack-notifications'
  
  routes:
    - match:
        severity: critical
      receiver: 'pagerduty'
    
    - match:
        severity: warning
      receiver: 'email'

receivers:
  - name: 'slack-notifications'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#alerts'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
  
  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: 'YOUR_PAGERDUTY_KEY'
  
  - name: 'email'
    email_configs:
      - to: 'team@example.com'
        from: 'alerts@example.com'
        smarthost: 'smtp.example.com:587'
```

Route critical to PagerDuty, warnings to Slack, and resist the urge to page for everything. Alert fatigue kills observability programs faster than any technical limitation.

## Grafana: make the numbers legible

Prometheus stores data; Grafana makes you want to look at it. Build dashboards around **the four golden signals** where they apply: latency, traffic, errors, saturation.

### Dashboard panel example

```json
{
  "dashboard": {
    "title": "API Service Dashboard",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total[5m])",
            "legendFormat": "{{method}} {{route}}"
          }
        ]
      },
      {
        "title": "Error Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total{status=~\"5..\"}[5m]) / rate(http_requests_total[5m])",
            "legendFormat": "Error Rate"
          }
        ]
      },
      {
        "title": "Latency (95th percentile)",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))",
            "legendFormat": "p95"
          }
        ]
      }
    ]
  }
}
```

### Queries you'll paste into panels constantly

```promql
# Request rate by endpoint
sum(rate(http_requests_total[5m])) by (endpoint)

# Error rate percentage
sum(rate(http_requests_total{status=~"5.."}[5m])) / 
sum(rate(http_requests_total[5m])) * 100

# Active connections
active_connections

# CPU usage
100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
```

One dashboard per service, one overview dashboard for executives who ask "is it up?" without wanting PromQL tutorials.

## Kubernetes service discovery

Static targets don't scale in K8s. Pods come and go; Prometheus should notice:

```yaml
scrape_configs:
  - job_name: 'kubernetes-pods'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
```

Annotate pods with `prometheus.io/scrape: "true"` and friends. Let relabeling do the rest.

## What we learned the hard way

**Label consistency matters.** `http_method` in one service and `method` in another makes cross-service dashboards painful. Pick a convention and enforce it in code review.

**High cardinality will eat Prometheus alive.** Never use user IDs, request IDs, or unbounded URL paths as label values. We learned this when someone labeled by `user_id` and our TSDB grew like a chia pet. Use logs or traces for per-user debugging.

**Scrape interval is a tradeoff.** Faster scrapes mean fresher data and more load. Match interval to how quickly you need to detect failure.

**Recording rules precompute expensive queries.** If your dashboard runs a horrifying `histogram_quantile` across fifty services every refresh, pre-aggregate it.

**Monitor Prometheus itself.** If the metrics system is down, you're flying blind. Alert on `up{job="prometheus"}` and disk usage on the TSDB volume.

**Set retention deliberately.** Default local storage keeps ~15 days. Know your limit before an incident needs month-old data.

**Test alert delivery.** An alert that doesn't reach anyone is performance art. Verify PagerDuty and Slack integrations after every config change.

**Write good `help` text on metrics.** Future you grepping `http_requests_total` at 3am will appreciate knowing what `status` means.

## Start small, iterate loudly

Day one: node-exporter plus default app metrics. Week two: request duration histograms and error-rate alerts. Month two: SLO dashboards and recording rules.

You don't need perfect observability before you ship. You need enough signal to answer "which service?" without guessing—and enough discipline to not alert on noise.

Prometheus and Grafana won't fix your architecture. They'll make your architecture's mistakes visible early, which is almost as good.

---

*Written February 2019, covering Prometheus 2.0+ and Grafana's mainstream dashboard era. Ecosystem tooling (OpenTelemetry, Grafana Loki, etc.) has expanded since; pull-based metrics and thoughtful alerting remain the foundation.*

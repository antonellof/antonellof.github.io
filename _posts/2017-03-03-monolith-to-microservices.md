---
layout: post
title: "Migrating from Monolith to Microservices: A Practical Approach"
date: 2017-03-03
categories: [Case Study]
tags: [Microservices, Architecture, Migration, Refactoring]
excerpt: "We spent 2016 building a monolith that worked, then 2017 carefully taking it apart. No big-bang rewrite—just the Strangler Fig pattern, some hard-won boundary decisions, and a few things we'd definitely do differently."
---

# Migrating from Monolith to Microservices: A Practical Approach

Our monolith wasn't a disaster. That's almost the problem.

In 2016, we shipped fast. One repo, one database, one deployment. Features went from idea to production in days. The codebase was familiar. Onboarding meant cloning one repository and running `docker-compose up`. Life was good.

By early 2017, "good" had become "comfortable but cramped." Deployments made everyone hold their breath. Scaling meant scaling *everything* because one feature got popular. Three teams were editing the same modules and politely passive-aggressively reviewing each other's PRs.

Microservices promised independence. They delivered... distributed systems. With extra steps.

We spent six months migrating using the Strangler Fig pattern—gradually replacing pieces of the monolith rather than rewriting in a heroic weekend that would have ended in pizza, tears, and a rollback. Here's the honest account.

## Why We Left (And Why We Hesitated)

The pain was real:

- **Deployment bottlenecks** — One bad migration took down the entire app
- **Scaling mismatches** — User profile reads were 80% of traffic; we scaled the whole monolith for them
- **Team friction** — Merge conflicts in shared modules were a weekly ritual
- **Technology lock-in** — Python for everything, even when Go or Node would have been a better fit for specific jobs

But microservices aren't free upgrades. They're trade-offs:

- Function calls become network calls (with latency and failure modes)
- Distributed transactions become sagas, eventual consistency, and long debugging sessions
- "Works on my machine" becomes "works in my service mesh, probably"
- Infrastructure surface area multiplies

We migrated because the monolith's pain exceeded the distributed systems tax. If your monolith is merely *annoying*, fix the monolith. If it's actively limiting growth, read on.

## The Strangler Fig Pattern: Kill It Slowly

Named after the strangler fig tree that grows around a host tree until the host dies, this pattern lets you extract services incrementally while the monolith keeps running.

```
Old Monolith          New Architecture
┌─────────────┐       ┌─────────────┐
│             │       │  API Gateway│
│  Monolith   │───────│             │
│             │       └──────┬──────┘
└─────────────┘              │
                             ├─── User Service (new)
                             ├─── Order Service (new)
                             └─── Monolith (legacy)
```

No big bang. No "stop the world" rewrite. Traffic routes through a gateway; new services handle what they're ready for; the monolith handles everything else. Over months, the monolith shrinks.

### Step 1: Extract a Read-Heavy Service

We started with user profiles. Why?

- **Read-heavy** — Mostly GET requests, low risk of data corruption during migration
- **Clear boundaries** — User data belongs to users; few cross-cutting concerns
- **High traffic** — Immediate scaling benefit

```python
# Before: In monolith
class UserController:
    def get_profile(self, user_id):
        user = User.objects.get(id=user_id)
        return {
            'id': user.id,
            'name': user.name,
            'email': user.email
        }

# After: Extract to service
# user-service/app.py
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/users/<user_id>', methods=['GET'])
def get_user(user_id):
    user = db.get_user(user_id)
    return jsonify({
        'id': user.id,
        'name': user.name,
        'email': user.email
    })

# Monolith: Call service instead
import requests

class UserController:
    def get_profile(self, user_id):
        response = requests.get(
            f'http://user-service/users/{user_id}'
        )
        return response.json()
```

The monolith didn't disappear—it became a client. Users hitting `/profile` still went through familiar code paths; that code path now proxied to a new service. We could scale user reads independently, deploy user service changes without touching orders, and roll back by flipping a feature flag to read from the local database again.

Lesson learned: **start with reads.** Writes involve transactions, side effects, and the haunting question "what if the network fails mid-commit?"

### Step 2: Extract a Write-Heavy Service

Orders were scarier. Money involved. Inventory involved. Side effects everywhere.

```python
# order-service/app.py
from flask import Flask, jsonify, request
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

app = Flask(__name__)
engine = create_engine('postgresql://...')
Session = sessionmaker(bind=engine)

@app.route('/orders', methods=['POST'])
def create_order():
    data = request.json
    session = Session()
    
    try:
        # Create order
        order = Order(
            user_id=data['user_id'],
            total=data['total']
        )
        session.add(order)
        session.commit()
        
        # Publish event
        event_bus.publish('order.created', {
            'order_id': order.id,
            'user_id': order.user_id
        })
        
        return jsonify({'id': order.id}), 201
    except Exception as e:
        session.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        session.close()
```

The critical addition: **event publishing.** The monolith used to handle order creation and send confirmation emails in the same request. Now the order service commits the order and publishes `order.created`. Other services (notifications, analytics, inventory) subscribe.

We gave up synchronous simplicity for asynchronous resilience. An email failure no longer rolls back an order. That's the deal you make with microservices.

## Service Boundaries: The Hard Part

Everyone agrees you need "good boundaries." Nobody agrees where to draw them until six months later when you realize you drew them wrong.

### Boundaries That Worked

```python
# User Service - Owns user data
class UserService:
    def create_user(self, data):
        # User creation logic
        pass
    
    def update_profile(self, user_id, data):
        # Profile updates
        pass
    
    def get_user(self, user_id):
        # User retrieval
        pass

# Order Service - Owns order data
class OrderService:
    def create_order(self, user_id, items):
        # Order creation
        pass
    
    def get_order(self, order_id):
        # Order retrieval
        pass
```

Each service owns its data and its business rules. User service doesn't reach into order tables. Order service doesn't update user profiles. They talk via APIs and events.

The test we used: **could this team own this service end-to-end?** Deployment, monitoring, on-call, schema changes. If two teams would need to coordinate every change, the boundary was wrong.

### Boundaries That Didn't

```python
# Don't do this - too granular
class EmailService:
    def send_email(self, to, subject, body):
        # Too small, should be part of notification service
        pass

# Don't do this - too broad
class BusinessLogicService:
    def do_everything(self):
        # Too large, defeats purpose
        pass
```

A standalone email microservice sounds clean until you realize every other service needs it. Now you have a critical dependency with no clear owner and latency on every notification.

A "business logic" service is just a monolith with extra network hops and worse grep.

## Data: The Part Nobody Puts on Conference Slides

### Database Per Service

Each service gets its own database. This is non-negotiable for true service independence:

```python
# user-service/db.py
DATABASE_URL = 'postgresql://user-service-db/...'

# order-service/db.py
DATABASE_URL = 'postgresql://order-service-db/...'
```

Shared databases are shared coupling. If two services write to the same tables, you haven't migrated—you've distributed a monolith's problems across more repos.

### Sharing Data Without Sharing Tables

When order service needs user info, it doesn't query the user database. It listens for events:

```python
# User Service publishes event
event_bus.publish('user.created', {
    'user_id': user.id,
    'email': user.email
})

# Order Service subscribes
@event_bus.subscribe('user.created')
def handle_user_created(event):
    # Create order history for new user
    create_order_history(event['user_id'])
```

Eventual consistency enters your vocabulary. The order service's copy of user data might be seconds stale. Design for it. Show stale data gracefully. Don't pretend you're still in a single ACID transaction.

## API Gateway: One Front Door

Clients shouldn't need to know your internal service topology:

```python
# api-gateway/app.py
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

SERVICES = {
    'users': 'http://user-service:5000',
    'orders': 'http://order-service:5001',
}

@app.route('/<service>/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE'])
def proxy(service, path):
    if service not in SERVICES:
        return jsonify({'error': 'Service not found'}), 404
    
    service_url = SERVICES[service]
    url = f'{service_url}/{path}'
    
    response = requests.request(
        method=request.method,
        url=url,
        headers={k: v for k, v in request.headers if k != 'Host'},
        params=request.args,
        json=request.get_json() if request.is_json else None
    )
    
    return jsonify(response.json()), response.status_code
```

The gateway handles routing, authentication, rate limiting, and request logging. Services stay internal. When you split order service into order + inventory, clients don't change—only the gateway routing table does.

Our gateway was embarrassingly simple in March 2017. It worked. Don't let perfect gateway architecture block extraction.

## Service Discovery: Finding Each Other

Hardcoded URLs work until they don't. We used Consul:

```python
# Using Consul for service discovery
import consul

c = consul.Consul()

def get_service_url(service_name):
    services = c.health.service(service_name)[1]
    if not services:
        raise Exception(f'Service {service_name} not found')
    
    service = services[0]['Service']
    return f"http://{service['Address']}:{service['Port']}"

# Register service
c.agent.service.register(
    'user-service',
    service_id='user-service-1',
    address='user-service',
    port=5000
)
```

In Kubernetes-era hindsight, this looks quaint. In 2017, Consul (or Eureka, or etcd) was how services found each other without hardcoding IPs that changed every deploy.

## When Things Break (They Will)

### Circuit Breakers

When user service goes down, the monolith shouldn't hang forever waiting:

```python
from circuitbreaker import circuit

@circuit(failure_threshold=5, recovery_timeout=60)
def call_user_service(user_id):
    response = requests.get(
        f'http://user-service/users/{user_id}',
        timeout=5
    )
    return response.json()

# Falls back if circuit is open
def get_user_with_fallback(user_id):
    try:
        return call_user_service(user_id)
    except CircuitBreakerError:
        # Return cached data or default
        return get_cached_user(user_id) or {'id': user_id, 'name': 'Unknown'}
```

Fail fast. Return degraded responses. Don't cascade failures across your entire system because one service is having a bad day.

### Retries (With Backoff, Please)

```python
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=10)
)
def call_order_service(data):
    response = requests.post(
        'http://order-service/orders',
        json=data,
        timeout=5
    )
    response.raise_for_status()
    return response.json()
```

Retry transient failures. Don't retry forever. Exponential backoff prevents your recovery attempt from becoming a DDoS against your own order service.

## Testing: Trust But Verify

### Contract Tests

Services are independent deployables. Their interface is the contract:

```python
# Contract test for user service
def test_user_service_contract():
    # Test that service meets contract
    response = requests.get('http://user-service/users/1')
    
    assert response.status_code == 200
    data = response.json()
    
    # Verify contract
    assert 'id' in data
    assert 'name' in data
    assert 'email' in data
```

If user service changes its response shape without telling consumers, contract tests catch it before production does.

### Integration Tests

```python
# Test service interaction
def test_order_creation_flow():
    # Create user
    user = create_user({'name': 'Test User'})
    
    # Create order
    order = create_order(user['id'], [{'product_id': 1, 'quantity': 2}])
    
    # Verify order has user info
    assert order['user_id'] == user['id']
```

Unit tests prove services work alone. Integration tests prove they work together. You need both, especially when events are involved and timing matters.

## Monitoring: One Dashboard Per Service

You can't debug what you can't see:

```python
from prometheus_client import Counter, Histogram

request_count = Counter('requests_total', 'Total requests', ['service', 'method'])
request_duration = Histogram('request_duration_seconds', 'Request duration', ['service'])

@app.route('/users/<user_id>')
def get_user(user_id):
    with request_duration.labels('user-service').time():
        request_count.labels('user-service', 'GET').inc()
        # Process request
        return get_user_data(user_id)
```

Each service exports metrics. Each service has dashboards. Each service has alerts. "The app is slow" isn't actionable. "User service p99 latency doubled" is.

## What We'd Do Differently

Hindsight is a gift. Here's ours:

**Start smaller.** We tried extracting two services in parallel early on. Parallel migrations mean parallel confusion. One service at a time, fully operational, before starting the next.

**Spend more time on boundaries.** We redrew service lines twice. Upfront domain modeling (even lightweight event storming) would have saved weeks.

**Go event-driven from day one.** Retrofitting events onto services that initially used synchronous calls meant rewriting integration points. Events first, sync calls only when you genuinely need request-response.

**Consider a service mesh earlier.** We hand-rolled retries, circuit breakers, and tracing in every service. Istio/Linkerd weren't production-ready for us in early 2017, but the pain was real.

**Contract tests from day one.** We added them after a breaking change hit production. Obvious in retrospect.

## The Bottom Line

Migrating to microservices is a journey measured in months, not sprints:

- Use the Strangler Fig pattern—no big bang
- Extract read-heavy services first; earn confidence before touching writes
- Draw boundaries around business capabilities, not technical layers
- Database per service; share data via events, not shared tables
- API gateway for clients; service discovery for services
- Circuit breakers, retries, monitoring—distributed systems hygiene

Don't migrate because microservices are fashionable. Migrate because your monolith's specific pains outweigh the distributed systems tax.

Our six-month migration wasn't glamorous. There was no launch day confetti. Just gradually shrinking the monolith, gradually growing confidence, and one day realizing the monolith was mostly gone.

That was worth it. We deploy independently now. We scale what needs scaling. Teams own their services.

We also have more repos, more dashboards, and infinitely more "have you checked the logs in the other service?" conversations.

That's the deal. We took it. Mostly don't regret it.

---

*Migration lessons from March 2017, after six months of extracting services from our production monolith. Stack: Python/Flask services, PostgreSQL, Consul, Prometheus, hand-rolled event bus.*

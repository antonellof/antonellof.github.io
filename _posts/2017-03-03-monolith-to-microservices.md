---
layout: post
title: "Migrating from Monolith to Microservices: A Practical Approach"
date: 2017-03-03
categories: [Case Study]
tags: [Microservices, Architecture, Migration, Refactoring]
excerpt: "Lessons learned from migrating a monolithic application to microservices, including the Strangler Fig pattern, service boundaries, and avoiding common pitfalls."
---

Migrating from a monolith to microservices is one of the most challenging architectural transitions. We spent 2016 building a monolith that worked, then spent 2017 carefully extracting it into microservices. Here's what we learned—the good, the bad, and the "we should have done this differently."

## Why We Migrated

Our monolith was showing signs of strain:
- **Deployment bottlenecks**: One bug could break everything
- **Scaling issues**: Had to scale the entire app for one feature
- **Team conflicts**: Multiple teams stepping on each other
- **Technology constraints**: Couldn't use best tool for each job

But migration isn't free. We learned that microservices add complexity:
- Network calls replace function calls
- Distributed transactions are hard
- Debugging across services is challenging
- More infrastructure to manage

## The Strangler Fig Pattern

We used the Strangler Fig pattern—gradually replacing parts of the monolith:

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

### Step 1: Extract Read-Heavy Service

We started with the user profile service—read-heavy, well-defined boundaries:

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

### Step 2: Extract Write-Heavy Service

Orders service was more complex—needed transactions:

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

## Service Boundaries

The hardest part: deciding where to draw boundaries.

### Good Boundaries

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

### Bad Boundaries

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

## Data Management

### Database Per Service

Each service gets its own database:

```python
# user-service/db.py
DATABASE_URL = 'postgresql://user-service-db/...'

# order-service/db.py
DATABASE_URL = 'postgresql://order-service-db/...'
```

### Sharing Data

Use events, not direct database access:

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

## API Gateway

Single entry point for clients:

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

## Service Discovery

Services need to find each other:

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

## Handling Failures

### Circuit Breaker Pattern

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

### Retry Logic

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

## Testing Microservices

### Contract Testing

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

### Integration Testing

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

## Monitoring

Each service needs its own metrics:

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

## Migration Checklist

1. ✅ Identify service boundaries
2. ✅ Extract read-heavy services first
3. ✅ Set up API gateway
4. ✅ Implement service discovery
5. ✅ Add circuit breakers
6. ✅ Set up monitoring
7. ✅ Write contract tests
8. ✅ Migrate data gradually
9. ✅ Decommission monolith parts

## What We'd Do Differently

1. **Start smaller** - Extract one service at a time
2. **Better boundaries** - Spend more time on design
3. **Event-driven from start** - Would have made migration easier
4. **Service mesh** - Would have simplified communication
5. **More testing** - Contract tests from day one

## Conclusion

Migrating to microservices is a journey:
- Use Strangler Fig pattern
- Extract services gradually
- Maintain service boundaries
- Handle failures gracefully
- Monitor everything

Don't rush it. Take time to design boundaries. The migration took us 6 months, but it was worth it. We can now scale and deploy independently.

---

*Migration lessons from March 2017, after 6 months of extracting services from our monolith.*

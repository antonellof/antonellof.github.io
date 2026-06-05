---
layout: post
title: "Building Serverless APIs with AWS Lambda and API Gateway"
date: 2017-04-19
categories: [How-To]
tags: [AWS, Lambda, API Gateway, Serverless, REST API]
excerpt: "No servers, no SSH, no 3 AM paging because a box ran out of memory. Here's how we built production REST APIs on Lambda and API Gateway—with auth, validation, and the error handling that keeps you employed."
---

# Building Serverless APIs with AWS Lambda and API Gateway

The pitch for serverless APIs sounds like a late-night infomercial: "What if you never provisioned another server? What if scaling happened automatically? What if you only paid when someone actually hit your endpoint?"

The reality in 2017 was more nuanced—and more useful than the hype suggested. After shipping several production APIs on Lambda and API Gateway, I can say this: it works, it scales, and it has sharp edges you should know about before you deploy on Friday afternoon.

This is the guide I wanted when I was staring at my first API Gateway event object wondering why `body` was a string and `pathParameters` was sometimes undefined.

## The Architecture (It's Simpler Than You Think)

```
Client → API Gateway → Lambda → DynamoDB/S3/etc
         (Routing)    (Logic)   (Data)
```

API Gateway is the bouncer. It handles routing, authentication, rate limiting, CORS, and request/response transformation. Lambda is the kitchen—it does the actual work. Your data store is whatever makes sense (DynamoDB was our default for serverless APIs in 2017).

The split matters because it defines what you debug when things break. 401 errors? Probably Gateway auth config. 500s with weird timeouts? Probably Lambda. CORS errors that only happen in browsers? Definitely CORS config, and yes, you'll lose an afternoon to them anyway.

## Your First Handler (Yes, Routing Lives Here)

In 2017, a common pattern was a single Lambda with manual routing. It's not elegant, but it's honest:

```javascript
// handler.js
exports.handler = async (event) => {
    // Parse request
    const { httpMethod, path, body, headers } = event;
    
    // Route based on method and path
    if (httpMethod === 'GET' && path === '/users') {
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                users: await getUsers()
            })
        };
    }
    
    if (httpMethod === 'POST' && path === '/users') {
        const userData = JSON.parse(body);
        const user = await createUser(userData);
        
        return {
            statusCode: 201,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ user })
        };
    }
    
    return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Not found' })
    };
};
```

Three things to internalize immediately:

1. **`body` is a string.** API Gateway doesn't parse JSON for you. `JSON.parse(body)` or regret.
2. **You must return `statusCode`, `headers`, and `body`.** Lambda doesn't magically format HTTP responses.
3. **CORS headers go on every response.** Including errors. Especially errors. Browsers are unforgiving.

## Infrastructure: Pick Your Poison (SAM or Serverless Framework)

Hand-configuring API Gateway in the AWS Console is a character-building exercise. Use infrastructure-as-code.

### AWS SAM

```yaml
# template.yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.handler
      Runtime: nodejs12.x
      Events:
        ApiEvent:
          Type: Api
          Properties:
            Path: /{proxy+}
            Method: ANY
            RestApiId: !Ref ApiGateway

  ApiGateway:
    Type: AWS::Serverless::Api
    Properties:
      StageName: prod
      Cors:
        AllowMethods: "'GET,POST,PUT,DELETE,OPTIONS'"
        AllowHeaders: "'Content-Type,X-Amz-Date,Authorization'"
        AllowOrigin: "'*'"
```

SAM is AWS-native. CloudFormation under the hood. Good if you're already in the AWS ecosystem and want minimal abstraction.

### Serverless Framework

```yaml
# serverless.yml
service: my-api

provider:
  name: aws
  runtime: nodejs12.x
  region: us-east-1
  environment:
    TABLE_NAME: ${self:custom.tableName}

functions:
  api:
    handler: handler.handler
    events:
      - http:
          path: /{proxy+}
          method: ANY
          cors: true

resources:
  Resources:
    UsersTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: ${self:custom.tableName}
        AttributeDefinitions:
          - AttributeName: id
            AttributeType: S
        KeySchema:
          - AttributeName: id
            KeyType: HASH
        BillingMode: PAY_PER_REQUEST
```

Serverless Framework has a larger community, more plugins, and nicer DX for multi-function services. We used it for most projects.

Both work. Pick one and learn its deploy commands. `serverless deploy` and `sam deploy --guided` should be muscle memory.

## Structure Your API Like You Mean It

Once you have more than two endpoints, organize code like a real application.

### Route Module

```javascript
// routes/users.js
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_NAME = process.env.TABLE_NAME;

async function getUsers() {
    const result = await dynamodb.scan({
        TableName: TABLE_NAME
    }).promise();
    
    return result.Items;
}

async function getUserById(userId) {
    const result = await dynamodb.get({
        TableName: TABLE_NAME,
        Key: { id: userId }
    }).promise();
    
    return result.Item;
}

async function createUser(userData) {
    const user = {
        id: generateId(),
        ...userData,
        createdAt: new Date().toISOString()
    };
    
    await dynamodb.put({
        TableName: TABLE_NAME,
        Item: user
    }).promise();
    
    return user;
}

function generateId() {
    return Math.random().toString(36).substring(2, 15);
}

module.exports = {
    getUsers,
    getUserById,
    createUser
};
```

Business logic lives here. Database access lives here. The handler routes; it doesn't implement.

### Main Handler With Proper Responses

```javascript
// handler.js
const { getUsers, getUserById, createUser } = require('./routes/users');

exports.handler = async (event) => {
    const { httpMethod, pathParameters, body } = event;
    const route = httpMethod + ' ' + (pathParameters?.proxy || '');
    
    try {
        let response;
        
        switch (route) {
            case 'GET /users':
                response = await getUsers();
                return successResponse(response);
                
            case 'GET /users/{id}':
                const userId = pathParameters.proxy.split('/')[1];
                response = await getUserById(userId);
                return response 
                    ? successResponse(response)
                    : notFoundResponse();
                    
            case 'POST /users':
                const userData = JSON.parse(body);
                response = await createUser(userData);
                return successResponse(response, 201);
                
            default:
                return notFoundResponse();
        }
    } catch (error) {
        console.error('Error:', error);
        return errorResponse(error);
    }
};

function successResponse(data, statusCode = 200) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(data)
    };
}

function errorResponse(error, statusCode = 500) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
            error: error.message || 'Internal server error'
        })
    };
}

function notFoundResponse() {
    return {
        statusCode: 404,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Not found' })
    };
}
```

Centralized response helpers aren't exciting, but they prevent the bug where your 404 response is missing CORS headers and your frontend blames your API for a CORS issue that's actually a routing issue.

Initialize the DynamoDB client *outside* the handler. Connection reuse matters.

## Authentication: Don't Roll Your Own (Much)

### API Keys

Simple, effective for service-to-service or low-stakes endpoints:

```javascript
// Check API key
function validateApiKey(event) {
    const apiKey = event.headers['x-api-key'];
    const validKeys = process.env.API_KEYS.split(',');
    
    return validKeys.includes(apiKey);
}

exports.handler = async (event) => {
    if (!validateApiKey(event)) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Unauthorized' })
        };
    }
    
    // Process request
};
```

API Gateway can also validate API keys at the gateway level—less Lambda code, earlier rejection. Use that when you can.

### JWT Authentication

For user-facing APIs, JWTs in the `Authorization` header:

```javascript
const jwt = require('jsonwebtoken');

function verifyToken(event) {
    const token = event.headers.Authorization?.replace('Bearer ', '');
    
    if (!token) {
        throw new Error('No token provided');
    }
    
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        throw new Error('Invalid token');
    }
}

exports.handler = async (event) => {
    try {
        const user = verifyToken(event);
        event.user = user; // Add user to event
        
        // Process request with user context
        return successResponse({ message: 'Authenticated' });
    } catch (error) {
        return errorResponse(error, 401);
    }
};
```

Verify in Lambda or use API Gateway custom authorizers. Custom authorizers add latency but keep auth logic out of every function. For a single-function API, in-handler verification is fine.

## Error Handling: The Difference Between "Broken" and "Debuggable"

```javascript
class ApiError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

class NotFoundError extends ApiError {
    constructor(resource) {
        super(404, `${resource} not found`);
    }
}

class ValidationError extends ApiError {
    constructor(message) {
        super(400, message);
    }
}

exports.handler = async (event) => {
    try {
        // Your logic
        if (!user) {
            throw new NotFoundError('User');
        }
        
        if (!isValid(userData)) {
            throw new ValidationError('Invalid user data');
        }
        
        return successResponse(result);
    } catch (error) {
        if (error instanceof ApiError) {
            return errorResponse(error, error.statusCode);
        }
        
        // Log unexpected errors
        console.error('Unexpected error:', error);
        return errorResponse(new Error('Internal server error'), 500);
    }
};
```

Typed errors let you return correct status codes without a forest of if-else. Unexpected errors get logged with full stack traces but return generic messages to clients—because your database connection string doesn't belong in a JSON error response.

## Request Validation: Trust Nothing From the Internet

```javascript
const Joi = require('joi');

const createUserSchema = Joi.object({
    name: Joi.string().required().min(2).max(100),
    email: Joi.string().email().required(),
    age: Joi.number().integer().min(18).max(120).optional()
});

exports.handler = async (event) => {
    if (event.httpMethod === 'POST' && event.path === '/users') {
        const userData = JSON.parse(event.body);
        
        const { error, value } = createUserSchema.validate(userData);
        
        if (error) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: 'Validation failed',
                    details: error.details
                })
            };
        }
        
        // Use validated value
        const user = await createUser(value);
        return successResponse(user, 201);
    }
};
```

Validate at the boundary. Lambda bills per millisecond—don't waste compute discovering that `email` is missing after three database calls.

## CORS: The Necessary Evil

Browsers enforce CORS. API Gateway and Lambda must cooperate:

```javascript
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

exports.handler = async (event) => {
    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ''
        };
    }
    
    // Handle actual request
    return {
        statusCode: 200,
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ data: 'response' })
    };
};
```

`OPTIONS` preflight requests are real requests that need real responses. Forget them and spend two hours wondering why `curl` works but Chrome doesn't.

For production, replace `'*'` with your actual frontend origin. Wildcard CORS is fine for development, lazy for production.

## Deployment: Make It Boring

### Serverless Framework

```bash
# Install
npm install -g serverless

# Deploy
serverless deploy

# Deploy specific function
serverless deploy function -f api

# View logs
serverless logs -f api --tail
```

### AWS SAM

```bash
# Build
sam build

# Deploy
sam deploy --guided

# Test locally
sam local start-api
```

`sam local start-api` saved us hours. Test handlers locally with realistic API Gateway events before deploying to AWS.

CI/CD tip: deploy from your pipeline, not your laptop. Same artifacts, same process, fewer "works on my machine" deploys.

## Monitoring: Because "It Worked in Dev" Isn't a SLA

```javascript
// Custom metrics
const CloudWatch = require('aws-sdk/clients/cloudwatch');
const cloudwatch = new CloudWatch();

async function putMetric(metricName, value, unit = 'Count') {
    await cloudwatch.putMetricData({
        Namespace: 'MyAPI',
        MetricData: [{
            MetricName: metricName,
            Value: value,
            Unit: unit,
            Timestamp: new Date()
        }]
    }).promise();
}

exports.handler = async (event) => {
    const startTime = Date.now();
    
    try {
        const result = await processRequest(event);
        
        // Record success metric
        await putMetric('Requests', 1);
        await putMetric('RequestDuration', Date.now() - startTime, 'Milliseconds');
        
        return successResponse(result);
    } catch (error) {
        // Record error metric
        await putMetric('Errors', 1);
        throw error;
    }
};
```

CloudWatch gives you invocations, duration, and errors automatically. Custom metrics let you track business events—signups, failed validations, downstream timeouts.

Set alarms before you need them. "I'll watch the dashboard" lasts exactly until the first incident.

## Production Wisdom (Learned the Hard Way)

Keep functions focused—one Lambda per resource or logical group, not one Lambda per endpoint unless you have a good reason. Environment variables for configuration; secrets in Parameter Store or Secrets Manager, not in your `serverless.yml` git history.

Return proper HTTP status codes. A 200 with `{ "error": "not found" }` confuses clients and breaks caching semantics.

Validate input at the boundary. Enable CORS correctly (yes, again—it's that important). Use API Gateway's built-in rate limiting and caching for read-heavy endpoints. Version your API through Gateway stages (`dev`, `staging`, `prod`) so you can roll back without redeploying Lambda.

Start simple—one function, manual routing, DynamoDB. Add complexity when traffic demands it, not when architecture diagrams demand it.

## The Bottom Line

Serverless APIs with Lambda and API Gateway deliver what they promise:

- Automatic scaling without capacity planning spreadsheets
- Pay-per-use economics that favor spiky traffic
- No server patching, no SSH, no midnight disk-full pages
- Built-in gateway features: auth, throttling, caching, CORS (if you configure it)

They also demand discipline: structured error handling, input validation, proper response formatting, and monitoring from day one.

The patterns here handled millions of requests in our production APIs. None of them are clever. All of them are boring in the right ways.

Build boring. Ship reliable. Optimize when metrics tell you to, not when conference talks make you anxious.

---

*Serverless API patterns from April 2017—AWS Lambda, API Gateway, Node.js 12.x, Serverless Framework v1.x, and DynamoDB on-demand not yet available (provisioned capacity or careful capacity planning required).*

---
layout: post
title: "Building Serverless APIs with AWS Lambda and API Gateway"
date: 2017-04-15
categories: [How-To]
tags: [AWS, Lambda, API Gateway, Serverless, REST API]
excerpt: "Complete guide to building production-ready REST APIs using AWS Lambda and API Gateway, including authentication, error handling, and deployment strategies."
---

Serverless APIs eliminate server management while providing automatic scaling and pay-per-use pricing. After building several serverless APIs in production, here's how to build them right.

## Architecture Overview

```
Client → API Gateway → Lambda → DynamoDB/S3/etc
         (Routing)    (Logic)   (Data)
```

API Gateway handles:
- Request routing
- Authentication/authorization
- Rate limiting
- Request/response transformation

Lambda handles:
- Business logic
- Data processing
- External API calls

## Basic Lambda Function

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

## API Gateway Configuration

### SAM Template

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

## RESTful API Structure

### Route Handler

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

### Main Handler

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

## Authentication

### API Keys

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

### JWT Authentication

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

## Error Handling

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

## Request Validation

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

## CORS Configuration

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

## Deployment

### Using Serverless Framework

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

### Using AWS SAM

```bash
# Build
sam build

# Deploy
sam deploy --guided

# Test locally
sam local start-api
```

## Monitoring

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

## Best Practices

1. **Keep functions focused** - One function per resource/operation
2. **Use environment variables** - For configuration
3. **Implement proper error handling** - Return appropriate status codes
4. **Validate input** - Use schemas
5. **Enable CORS** - For web clients
6. **Use API Gateway features** - Rate limiting, caching
7. **Monitor performance** - Track metrics
8. **Version your API** - Use API Gateway stages

## Conclusion

Serverless APIs with Lambda and API Gateway provide:
- Automatic scaling
- Pay-per-use pricing
- No server management
- Built-in features (auth, rate limiting)

Start simple, add complexity as needed. The patterns shown here handle millions of requests in production.

---

*Serverless API patterns from April 2017, using AWS Lambda and API Gateway.*

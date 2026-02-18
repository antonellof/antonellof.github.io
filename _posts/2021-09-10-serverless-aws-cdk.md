---
layout: post
title: "Building Serverless Applications with AWS CDK"
date: 2021-09-10
categories: [How-To]
tags: [AWS, CDK, Serverless]
excerpt: "Build serverless applications with AWS CDK: Lambda functions, API Gateway, DynamoDB, S3, and infrastructure as code patterns for serverless architectures."
---

AWS CDK simplifies serverless infrastructure. After building production serverless apps, here's how to use CDK effectively.

## CDK Basics

### Installation

```bash
npm install -g aws-cdk
cdk --version

# Initialize project
cdk init app --language typescript
```

### Basic Stack

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export class ServerlessStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        
        // Lambda function
        const helloFunction = new lambda.Function(this, 'HelloFunction', {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset('lambda'),
        });
        
        // API Gateway
        new apigateway.LambdaRestApi(this, 'HelloApi', {
            handler: helloFunction,
        });
    }
}
```

## Lambda Functions

### Basic Function

```typescript
const myFunction = new lambda.Function(this, 'MyFunction', {
    runtime: lambda.Runtime.NODEJS_18_X,
    handler: 'index.handler',
    code: lambda.Code.fromAsset('lambda/my-function'),
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    environment: {
        TABLE_NAME: table.tableName,
    },
});
```

### Function with Layers

```typescript
const layer = new lambda.LayerVersion(this, 'MyLayer', {
    code: lambda.Code.fromAsset('layer'),
    compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
});

const function = new lambda.Function(this, 'MyFunction', {
    runtime: lambda.Runtime.NODEJS_18_X,
    handler: 'index.handler',
    code: lambda.Code.fromAsset('lambda'),
    layers: [layer],
});
```

## API Gateway

### REST API

```typescript
const api = new apigateway.RestApi(this, 'MyApi', {
    restApiName: 'My API',
    description: 'My serverless API',
});

const helloResource = api.root.addResource('hello');
helloResource.addMethod('GET', new apigateway.LambdaIntegration(helloFunction));
```

### HTTP API

```typescript
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';

const httpApi = new apigatewayv2.HttpApi(this, 'MyHttpApi');

httpApi.addRoutes({
    path: '/hello',
    methods: [apigatewayv2.HttpMethod.GET],
    integration: new apigatewayv2.HttpLambdaIntegration(
        'HelloIntegration',
        helloFunction
    ),
});
```

## DynamoDB

### Table Definition

```typescript
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const table = new dynamodb.Table(this, 'MyTable', {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
});

// Grant permissions
table.grantReadWriteData(myFunction);
```

## S3

### Bucket and Lambda Trigger

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

const bucket = new s3.Bucket(this, 'MyBucket', {
    removalPolicy: cdk.RemovalPolicy.DESTROY,
});

const processorFunction = new lambda.Function(this, 'Processor', {
    runtime: lambda.Runtime.NODEJS_18_X,
    handler: 'index.handler',
    code: lambda.Code.fromAsset('lambda/processor'),
});

bucket.addEventNotification(
    s3.EventType.OBJECT_CREATED,
    new s3n.LambdaDestination(processorFunction)
);
```

## EventBridge

### Event Rule

```typescript
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

const rule = new events.Rule(this, 'ScheduleRule', {
    schedule: events.Schedule.rate(cdk.Duration.hours(1)),
});

rule.addTarget(new targets.LambdaFunction(myFunction));
```

## Best Practices

1. **Use constructs** - Reusable components
2. **Environment variables** - Configuration
3. **IAM permissions** - Least privilege
4. **Error handling** - Dead letter queues
5. **Monitoring** - CloudWatch alarms
6. **Testing** - Unit and integration tests
7. **Documentation** - Clear comments
8. **Versioning** - Semantic versioning

## Conclusion

AWS CDK enables:
- Type-safe infrastructure
- Reusable constructs
- Better DX
- Infrastructure as code

Start with simple stacks, then build reusable constructs. The patterns shown here create production serverless applications.

---

*Building serverless applications with AWS CDK from September 2021, covering Lambda, API Gateway, and DynamoDB.*

---
layout: post
title: "Building RESTful APIs with Laravel 5: Best Practices"
date: 2016-01-15
categories: [How-To]
tags: [PHP, Laravel, REST API, Backend]
excerpt: "A comprehensive guide to building production-ready RESTful APIs using Laravel 5, covering resource controllers, API authentication, versioning, and response formatting."
---

Building robust RESTful APIs is a cornerstone of modern web development. Laravel 5, with its elegant syntax and powerful features, makes API development both efficient and enjoyable. In this guide, I'll share best practices I've learned while building production APIs that serve millions of requests.

## Why Laravel for APIs?

Laravel 5 introduced significant improvements for API development:
- Resource controllers for RESTful routing
- Eloquent API resources for response transformation
- Built-in authentication with JWT support
- API rate limiting out of the box
- Comprehensive testing tools

## Setting Up Your API Structure

First, let's create a clean API structure. I recommend separating API routes from web routes:

```php
// routes/api.php
Route::group(['prefix' => 'v1', 'namespace' => 'Api\V1'], function () {
    Route::apiResource('users', 'UserController');
    Route::apiResource('posts', 'PostController');
});
```

## Resource Controllers

Laravel's resource controllers provide a conventional structure for CRUD operations:

```php
// app/Http/Controllers/Api/V1/UserController.php
<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Http\Resources\UserResource;
use Illuminate\Http\Request;

class UserController extends Controller
{
    public function index()
    {
        $users = User::paginate(15);
        return UserResource::collection($users);
    }

    public function store(Request $request)
    {
        $this->validate($request, [
            'name' => 'required|string|max:255',
            'email' => 'required|email|unique:users',
            'password' => 'required|min:8'
        ]);

        $user = User::create([
            'name' => $request->name,
            'email' => $request->email,
            'password' => bcrypt($request->password)
        ]);

        return new UserResource($user);
    }

    public function show($id)
    {
        $user = User::findOrFail($id);
        return new UserResource($user);
    }

    public function update(Request $request, $id)
    {
        $user = User::findOrFail($id);
        
        $this->validate($request, [
            'name' => 'string|max:255',
            'email' => 'email|unique:users,email,' . $id
        ]);

        $user->update($request->only(['name', 'email']));
        
        return new UserResource($user);
    }

    public function destroy($id)
    {
        User::findOrFail($id)->delete();
        return response()->json(null, 204);
    }
}
```

## API Resources for Response Transformation

API Resources provide a transformation layer between your models and JSON responses:

```php
// app/Http/Resources/UserResource.php
<?php

namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\Resource;

class UserResource extends Resource
{
    public function toArray($request)
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'created_at' => $this->created_at->toIso8601String(),
            'updated_at' => $this->updated_at->toIso8601String(),
            'posts' => PostResource::collection($this->whenLoaded('posts')),
            'links' => [
                'self' => route('users.show', $this->id)
            ]
        ];
    }
}
```

## Authentication with JWT

For API authentication, I recommend using JWT tokens:

```php
// config/jwt.php
return [
    'secret' => env('JWT_SECRET'),
    'ttl' => 60, // minutes
    'refresh_ttl' => 20160, // minutes
];
```

```php
// app/Http/Controllers/Api/AuthController.php
<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use JWTAuth;
use Tymon\JWTAuth\Exceptions\JWTException;

class AuthController extends Controller
{
    public function login(Request $request)
    {
        $credentials = $request->only('email', 'password');

        try {
            if (!$token = JWTAuth::attempt($credentials)) {
                return response()->json(['error' => 'Invalid credentials'], 401);
            }
        } catch (JWTException $e) {
            return response()->json(['error' => 'Could not create token'], 500);
        }

        return response()->json(compact('token'));
    }

    public function me()
    {
        return response()->json(JWTAuth::user());
    }

    public function refresh()
    {
        $token = JWTAuth::refresh(JWTAuth::getToken());
        return response()->json(compact('token'));
    }
}
```

## Error Handling

Consistent error responses are crucial for API consumers:

```php
// app/Exceptions/Handler.php
<?php

namespace App\Exceptions;

use Exception;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Foundation\Exceptions\Handler as ExceptionHandler;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

class Handler extends ExceptionHandler
{
    public function render($request, Exception $exception)
    {
        if ($request->wantsJson()) {
            if ($exception instanceof ModelNotFoundException) {
                return response()->json([
                    'error' => 'Resource not found'
                ], 404);
            }

            if ($exception instanceof ValidationException) {
                return response()->json([
                    'error' => 'Validation failed',
                    'messages' => $exception->errors()
                ], 422);
            }

            if ($exception instanceof NotFoundHttpException) {
                return response()->json([
                    'error' => 'Endpoint not found'
                ], 404);
            }

            return response()->json([
                'error' => 'Internal server error'
            ], 500);
        }

        return parent::render($request, $exception);
    }
}
```

## API Versioning

Plan for versioning from day one:

```php
// routes/api.php
Route::group(['prefix' => 'v1', 'namespace' => 'Api\V1'], function () {
    // Version 1 routes
});

Route::group(['prefix' => 'v2', 'namespace' => 'Api\V2'], function () {
    // Version 2 routes with breaking changes
});
```

## Rate Limiting

Protect your API from abuse with rate limiting:

```php
// app/Http/Kernel.php
protected $middlewareGroups = [
    'api' => [
        'throttle:60,1', // 60 requests per minute
        'bindings',
    ],
];
```

For authenticated users, you can increase the limit:

```php
Route::middleware('auth:api')->group(function () {
    Route::get('/user', function (Request $request) {
        return $request->user();
    })->middleware('throttle:1000,1'); // 1000 requests per minute
});
```

## Testing Your API

Always write tests for your API endpoints:

```php
// tests/Feature/UserApiTest.php
<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class UserApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_can_list_users()
    {
        User::factory()->count(3)->create();

        $response = $this->getJson('/api/v1/users');

        $response->assertStatus(200)
                 ->assertJsonCount(3, 'data');
    }

    public function test_can_create_user()
    {
        $userData = [
            'name' => 'John Doe',
            'email' => 'john@example.com',
            'password' => 'password123'
        ];

        $response = $this->postJson('/api/v1/users', $userData);

        $response->assertStatus(201)
                 ->assertJson([
                     'data' => [
                         'name' => 'John Doe',
                         'email' => 'john@example.com'
                     ]
                 ]);

        $this->assertDatabaseHas('users', [
            'email' => 'john@example.com'
        ]);
    }

    public function test_validation_fails_with_invalid_email()
    {
        $response = $this->postJson('/api/v1/users', [
            'name' => 'John Doe',
            'email' => 'invalid-email',
            'password' => 'password123'
        ]);

        $response->assertStatus(422)
                 ->assertJsonValidationErrors('email');
    }
}
```

## Pagination Best Practices

Always paginate list endpoints:

```php
public function index()
{
    $users = User::paginate(15);
    
    return UserResource::collection($users)->additional([
        'meta' => [
            'total' => $users->total(),
            'per_page' => $users->perPage(),
            'current_page' => $users->currentPage(),
            'last_page' => $users->lastPage()
        ]
    ]);
}
```

## Documentation

Document your API using tools like Laravel API Documentation Generator or integrate Swagger:

```php
/**
 * @api {get} /api/v1/users List Users
 * @apiName GetUsers
 * @apiGroup User
 *
 * @apiParam {Number} page Page number
 * @apiParam {Number} per_page Items per page
 *
 * @apiSuccess {Object[]} data List of users
 * @apiSuccess {Number} data.id User ID
 * @apiSuccess {String} data.name User name
 * @apiSuccess {String} data.email User email
 */
```

## Conclusion

Building RESTful APIs with Laravel 5 becomes straightforward when following these practices:
- Use resource controllers for consistent structure
- Implement API resources for response transformation
- Add proper authentication (JWT recommended)
- Handle errors consistently
- Version your API from the start
- Implement rate limiting
- Write comprehensive tests
- Document your endpoints

Laravel's elegant syntax and powerful features make it an excellent choice for API development. Start with these patterns and adjust based on your specific requirements.

---

*This article reflects best practices as of January 2016. Laravel has evolved significantly since then, but these core principles remain relevant.*

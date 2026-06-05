---
layout: post
title: "Building RESTful APIs with Laravel 5: Best Practices"
date: 2016-01-21
categories: [How-To]
tags: [PHP, Laravel, REST API, Backend]
excerpt: "How I stopped shipping APIs that made mobile devs hate me — resource controllers, JWT auth, versioning, and the Laravel 5 patterns that actually survive production traffic."
---

The mobile team sent a Slack message at 4:47pm on a Friday: "Why does your API return HTML error pages?" I'd built the endpoint in Laravel 5, tested it in Postman, declared victory, and moved on. What I hadn't done was think like an API consumer — consistent JSON, predictable errors, auth that doesn't leak session cookies into a native app.

That Friday taught me something I've repeated on every API since: REST isn't about being pedantic about HTTP verbs. It's about making life easy for the people integrating with your backend at 4:47pm on a Friday.

This guide covers the Laravel 5 patterns I landed on after building APIs that eventually served millions of requests. The framework has evolved a lot since 2016, but the principles — structure, transformation, auth, errors — still hold.

## Why Laravel for APIs?

Laravel 5 was a genuine shift for API work. Before that, you were often bolting JSON responses onto controllers built for Blade templates. Laravel 5 gave you:

- Resource controllers that map cleanly to REST conventions
- Eloquent API resources for response transformation (no more manually building arrays in every action)
- Authentication primitives you could extend for token-based flows
- Rate limiting middleware you could actually turn on without writing custom throttling
- A testing story that made endpoint tests feel natural, not bolted-on

The syntax is pleasant, yes. But the real win is convention — your team knows where things live, and new endpoints don't reinvent patterns.

## Setting Up Your API Structure

First decision that saves you pain later: separate API routes from web routes. Your mobile app doesn't need CSRF middleware. Your SPA doesn't need session flash data.

```php
// routes/api.php
Route::group(['prefix' => 'v1', 'namespace' => 'Api\V1'], function () {
    Route::apiResource('users', 'UserController');
    Route::apiResource('posts', 'PostController');
});
```

Notice the `v1` prefix. We'll come back to why that's not premature optimization — it's insurance.

## Resource Controllers

Laravel's resource controllers give you a conventional CRUD structure. This matters more than it sounds: when every controller follows the same shape, code review gets faster and onboarding gets easier.

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

One lesson I learned the hard way: keep controllers thin. Validation, authorization, and response shaping belong here; business logic belongs in services or actions. Fat controllers become untestable controllers.

## API Resources for Response Transformation

This is the layer that fixed my Friday-afternoon incident. API Resources sit between your Eloquent models and JSON output, which means you control exactly what leaves your server — no accidental password hashes, no internal flags, no "we'll filter it in the client."

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

The `whenLoaded('posts')` pattern is easy to overlook and expensive to ignore. Without it, you'll N+1 query your way into a slow API and wonder why list endpoints feel fine in development but collapse under load.

## Authentication with JWT

For stateless API consumers — mobile apps, SPAs, third-party integrations — JWT tokens were the standard approach in the Laravel 5 era. Session cookies work for same-origin web apps; they get awkward everywhere else.

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

Practical note on TTL: a 60-minute token with refresh capability is a reasonable default. Shorter tokens are more secure but annoy users; longer tokens are convenient but widen your breach window. Pick your tradeoff and document it for API consumers.

## Error Handling

Inconsistent error responses are how you earn angry Slack messages. Your API should fail predictably — same JSON shape, meaningful HTTP status codes, no HTML stack traces leaking into production.

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

The `wantsJson()` check is the whole game. Web requests get your normal error pages; API requests get JSON. Simple, but easy to forget until someone screenshots your 500 page in the mobile app.

## API Versioning

"We'll version later" is how you ship breaking changes that silently break production integrations. Version from day one, even if v1 is the only version for months.

```php
// routes/api.php
Route::group(['prefix' => 'v1', 'namespace' => 'Api\V1'], function () {
    // Version 1 routes
});

Route::group(['prefix' => 'v2', 'namespace' => 'Api\V2'], function () {
    // Version 2 routes with breaking changes
});
```

When you need v2, you clone controllers into `Api\V2`, make breaking changes there, and give consumers a migration window. Much better than changing field names in v1 and hoping nobody notices.

## Rate Limiting

Your API will get hammered — by bots, by buggy retry loops, by that one integration that polls every 100ms because someone forgot to implement backoff. Rate limiting isn't optional.

```php
// app/Http/Kernel.php
protected $middlewareGroups = [
    'api' => [
        'throttle:60,1', // 60 requests per minute
        'bindings',
    ],
];
```

Authenticated users doing legitimate work deserve higher limits:

```php
Route::middleware('auth:api')->group(function () {
    Route::get('/user', function (Request $request) {
        return $request->user();
    })->middleware('throttle:1000,1'); // 1000 requests per minute
});
```

Return `429 Too Many Requests` with a `Retry-After` header when you can. Good API clients respect it; bad ones will keep hammering you anyway, but at least you tried.

## Testing Your API

If you don't test endpoints, you're testing in production. Laravel makes this painless:

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

Test the unhappy paths too — 401 without a token, 404 for missing resources, 422 for validation failures. Happy-path-only tests give false confidence.

## Pagination

Returning unbounded lists is a performance trap and an integration nightmare. Always paginate:

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

Fifteen per page is a reasonable default. Document it. Let consumers request a different `per_page` if you support it, but cap the maximum — someone will ask for 10,000 records per request eventually.

## Documentation

Undocumented APIs become archaeology projects. Six months later, nobody remembers what that endpoint returns or which fields are required.

Tools like Laravel API Documentation Generator or Swagger integration pay for themselves the first time a new developer integrates without pinging you on Slack:

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

## Wrapping Up

Building RESTful APIs with Laravel 5 comes down to a handful of decisions you make early: structure your routes with versioning in mind, transform responses through API Resources so you control the contract, authenticate statelessly for non-browser clients, handle errors as JSON consistently, throttle aggressively, and test the paths that break at 4:47pm on Fridays.

Laravel's syntax makes the implementation pleasant. The discipline — thinking like an API consumer, not a backend developer checking boxes — is what keeps your integrations from becoming a support ticket factory.

---

*This article reflects Laravel 5 patterns from January 2016. Laravel has evolved significantly since then — Sanctum, API Resources v2, and modern testing tooling have improved the ergonomics — but these core principles still apply.*

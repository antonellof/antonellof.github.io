---
layout: post
title: "Go for System Programming: Building High-Performance Services"
date: 2024-09-20
categories: [How-To]
tags: [Go, System Programming, Performance, Backend]
excerpt: "Build high-performance system services with Go: goroutines, channels, HTTP servers, database connections, and patterns for building scalable backend services."
---

Go (Golang) was designed at Google to solve real problems: slow build times, complex dependency management, and the difficulty of writing concurrent code correctly. After a decade in production at companies like Uber, Cloudflare, and Docker, Go has proven itself as the language for infrastructure software.

I moved to Go from Python in 2016. The compiled binaries, built-in concurrency, and fast compile times felt like superpowers. A Python API that served 100 req/sec became a Go service handling 10,000 req/sec on the same hardware. The language's simplicity meant new team members were productive within days.

## Why Go for Systems?

**Concurrency primitives** - Goroutines and channels make concurrent programming intuitive. The Go scheduler handles thousands of goroutines on a handful of OS threads.

**Single binary deployment** - `go build` produces a single static binary with no runtime dependencies. Copy it to a server and run. No Python virtualenvs, no Node.js node_modules, no JVM.

**Fast compilation** - Large codebases compile in seconds. The tight edit-compile-test loop makes development productive.

**Standard library** - [net/http](https://pkg.go.dev/net/http), [database/sql](https://pkg.go.dev/database/sql), [encoding/json](https://pkg.go.dev/encoding/json)—production-quality packages included. You can build real systems without external dependencies.

**Performance** - Memory-safe like Java, fast like C. Low latency, predictable GC pauses, efficient memory usage.

Read Rob Pike's [Go at Google](https://go.dev/talks/2012/splash.article) for the language's design philosophy.

## Concurrency: Goroutines and Channels

Go's killer feature is lightweight concurrency. Goroutines are functions that run concurrently—similar to threads but managed by the Go runtime, not the OS. Starting a goroutine costs ~2KB of stack space vs 2MB for an OS thread.

### Goroutines

```go
package main

import (
    "fmt"
    "time"
)

func main() {
    // Start goroutines - they run concurrently
    go sayHello("World")
    go sayHello("Go")
    
    // Wait for goroutines to complete
    time.Sleep(2 * time.Second)
}

func sayHello(name string) {
    for i := 0; i < 3; i++ {
        fmt.Printf("Hello, %s! (%d)\n", name, i)
        time.Sleep(500 * time.Millisecond)
    }
}
```

The `go` keyword spawns a new goroutine. The Go scheduler multiplexes goroutines onto OS threads—you can run 100,000 goroutines without thinking about thread pools.

### Channels

Channels are Go's way of communicating between goroutines. "Don't communicate by sharing memory; share memory by communicating" is the Go proverb.

```go
package main

import "fmt"

func main() {
    // Create a channel
    data := make(chan int)
    results := make(chan int)
    
    // Producer goroutine
    go func() {
        for i := 1; i <= 5; i++ {
            data <- i  // Send to channel
        }
        close(data)  // Signal no more data
    }()
    
    // Consumer goroutine
    go func() {
        sum := 0
        for value := range data {  // Receive until closed
            sum += value * 2
        }
        results <- sum  // Send result
    }()
    
    // Wait for result
    total := <-results  // Receive from channel
    fmt.Printf("Total: %d\n", total)  // Prints: Total: 30
}
```

**Channel patterns:**
- **Buffered channels**: `make(chan int, 100)` - holds 100 values before blocking
- **Select statement**: Wait on multiple channels (like switch for channels)
- **Done channel**: Signal completion with `chan struct{}`

```go
// Worker pool pattern
func processJobs(jobs <-chan Job, results chan<- Result, workerCount int) {
    var wg sync.WaitGroup
    
    // Start workers
    for i := 0; i < workerCount; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            for job := range jobs {
                result := process(job)
                results <- result
            }
        }(i)
    }
    
    // Wait and close results
    go func() {
        wg.Wait()
        close(results)
    }()
}
```

Learn more in [Effective Go: Concurrency](https://go.dev/doc/effective_go#concurrency).

## HTTP Server: Production-Ready in the Standard Library

Go's [net/http](https://pkg.go.dev/net/http) package is production-ready out of the box. No need for Express, Flask, or other frameworks—the standard library handles routing, middleware, graceful shutdown, and HTTP/2.

### Basic HTTP Server

```go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "time"
)

type Response struct {
    Message string    `json:"message"`
    Time    time.Time `json:"time"`
}

func main() {
    // Define routes
    http.HandleFunc("/", handleRoot)
    http.HandleFunc("/api/hello", handleHello)
    http.HandleFunc("/api/data", handleData)
    
    // Start server
    log.Println("Server starting on :8080")
    if err := http.ListenAndServe(":8080", nil); err != nil {
        log.Fatal(err)
    }
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("Welcome to Go API"))
}

func handleHello(w http.ResponseWriter, r *http.Request) {
    name := r.URL.Query().Get("name")
    if name == "" {
        name = "World"
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(Response{
        Message: "Hello, " + name,
        Time:    time.Now(),
    })
}

func handleData(w http.ResponseWriter, r *http.Request) {
    // Only accept POST
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    
    // Parse JSON body
    var input map[string]interface{}
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }
    
    // Process and respond
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "received": input,
        "processed": true,
    })
}
```

### Production Patterns

For real services, use a router like [gorilla/mux](https://github.com/gorilla/mux), [chi](https://github.com/go-chi/chi), or [gin](https://github.com/gin-gonic/gin):

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "time"
    
    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
)

func main() {
    r := chi.NewRouter()
    
    // Middleware
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.Timeout(60 * time.Second))
    
    // Routes
    r.Get("/", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Hello, Chi!"))
    })
    
    r.Route("/api", func(r chi.Router) {
        r.Get("/users", listUsers)
        r.Get("/users/{id}", getUser)
        r.Post("/users", createUser)
    })
    
    // Server with graceful shutdown
    srv := &http.Server{
        Addr:         ":8080",
        Handler:      r,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }
    
    // Start server in goroutine
    go func() {
        log.Println("Starting server on :8080")
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()
    
    // Wait for interrupt signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, os.Interrupt)
    <-quit
    
    // Graceful shutdown
    log.Println("Shutting down server...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    
    if err := srv.Shutdown(ctx); err != nil {
        log.Fatal("Server forced to shutdown:", err)
    }
    
    log.Println("Server exited")
}

func listUsers(w http.ResponseWriter, r *http.Request) {
    // Implementation
}

func getUser(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    // Implementation
}

func createUser(w http.ResponseWriter, r *http.Request) {
    // Implementation
}
```

The pattern: middleware stack, route handlers, graceful shutdown. This scales to thousands of requests per second on modest hardware.

## Best Practices from Production

After building Go services that handle millions of requests daily:

1. **Use goroutines liberally** - Don't fear spawning goroutines. Use worker pools for CPU-bound tasks, spawn per-request goroutines for I/O.

2. **Handle errors explicitly** - Go's error handling is verbose but safe. Check every error, wrap with context:

```go
result, err := fetchData(ctx, id)
if err != nil {
    return fmt.Errorf("failed to fetch data for id %d: %w", id, err)
}
```

3. **Use context.Context for cancellation** - Pass `context.Context` as first parameter to functions that do I/O or long computations:

```go
func FetchUser(ctx context.Context, userID int) (*User, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }
    // Request will be cancelled if context is cancelled
    resp, err := client.Do(req)
    // ...
}
```

4. **Profile before optimizing** - Use [pprof](https://pkg.go.dev/net/http/pprof) for CPU and memory profiling:

```go
import _ "net/http/pprof"

go func() {
    log.Println(http.ListenAndServe("localhost:6060", nil))
}()
```

Then: `go tool pprof http://localhost:6060/debug/pprof/profile`

5. **Use proper database connection pooling** - [database/sql](https://pkg.go.dev/database/sql) handles pooling:

```go
db, err := sql.Open("postgres", connStr)
db.SetMaxOpenConns(25)
db.SetMaxIdleConns(5)
db.SetConnMaxLifetime(5 * time.Minute)
```

6. **Structure projects clearly** - Follow [Go project layout](https://github.com/golang-standards/project-layout):
```
myapp/
├── cmd/
│   └── myapp/
│       └── main.go
├── internal/
│   ├── api/
│   ├── database/
│   └── service/
├── pkg/
│   └── client/
└── go.mod
```

7. **Write tests** - Testing is built-in:

```go
func TestAddUser(t *testing.T) {
    user := User{Name: "Alice", Age: 30}
    if err := AddUser(user); err != nil {
        t.Fatalf("AddUser failed: %v", err)
    }
}

// Table-driven tests
func TestCalculate(t *testing.T) {
    tests := []struct {
        name     string
        input    int
        expected int
    }{
        {"positive", 5, 10},
        {"negative", -5, -10},
        {"zero", 0, 0},
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := Calculate(tt.input)
            if got != tt.expected {
                t.Errorf("got %d, want %d", got, tt.expected)
            }
        })
    }
}
```

8. **Monitor goroutines** - Track goroutine count to detect leaks:

```go
go func() {
    ticker := time.NewTicker(30 * time.Second)
    for range ticker.C {
        log.Printf("Goroutines: %d", runtime.NumGoroutine())
    }
}()
```

### Popular Libraries

- **HTTP routers**: [chi](https://github.com/go-chi/chi), [gorilla/mux](https://github.com/gorilla/mux), [gin](https://github.com/gin-gonic/gin)
- **Database**: [pgx](https://github.com/jackc/pgx) (Postgres), [go-sql-driver/mysql](https://github.com/go-sql-driver/mysql)
- **Redis**: [go-redis](https://github.com/redis/go-redis)
- **Config**: [viper](https://github.com/spf13/viper), [envconfig](https://github.com/kelseyhightower/envconfig)
- **Logging**: [zap](https://github.com/uber-go/zap), [zerolog](https://github.com/rs/zerolog)
- **Testing**: [testify](https://github.com/stretchr/testify), [gomock](https://github.com/golang/mock)

## Conclusion

Go's strength is its simplicity. The language fits in your head—no magic, no hidden complexity. Goroutines and channels make concurrent programming intuitive. The standard library covers 90% of what you need.

For infrastructure software—APIs, microservices, CLI tools, databases, proxies—Go is hard to beat. Fast compile times keep development productive. Single-binary deployment makes operations simple. The language's deliberate simplicity means teams can focus on solving problems, not learning frameworks.

The Go community's focus on pragmatism over cleverness has created a stable, boring (in the best way) ecosystem. When you need to build reliable systems that scale, Go delivers.

**Further Resources:**
- [Go Documentation](https://go.dev/doc/) - Official comprehensive docs
- [Effective Go](https://go.dev/doc/effective_go) - Essential reading
- [Go by Example](https://gobyexample.com/) - Learn by doing
- [Go Proverbs](https://go-proverbs.github.io/) - Philosophy in practice
- [Awesome Go](https://github.com/avelino/awesome-go) - Curated libraries
- [Go Time Podcast](https://changelog.com/gotime) - Community discussions
- [Practical Go](https://dave.cheney.net/practical-go) - Dave Cheney's wisdom

---

*Go system programming from September 2024, covering concurrency and HTTP servers.*

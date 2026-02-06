---
layout: post
title: "Building a Queue Worker System with Beanstalk"
date: 2016-11-15
categories: [Architecture]
tags: [Beanstalk, Queue, Workers, Background Jobs]
excerpt: "Implement a robust queue worker system using Beanstalkd, covering job queuing, worker processes, priority handling, and monitoring for reliable background job processing."
---

Beanstalkd is a simple, fast work queue that's perfect for background job processing. After building queue systems handling millions of jobs, I've learned that simplicity often beats complexity. Here's how to build a production-ready queue worker system with Beanstalkd.

## Why Beanstalkd?

Beanstalkd offers:
- **Simplicity**: No complex setup, just works
- **Speed**: Very fast, handles thousands of jobs/second
- **Persistence**: Jobs survive restarts
- **Priority**: Built-in priority support
- **Delays**: Schedule jobs for later execution

## Installation

```bash
# Using Docker
docker run -d --name beanstalkd \
    -p 11300:11300 \
    schickling/beanstalkd

# Or install directly
apt-get install beanstalkd
```

## Basic Concepts

- **Tube**: Like a queue (e.g., "emails", "images")
- **Job**: A unit of work
- **Producer**: Puts jobs into tubes
- **Worker**: Reserves and processes jobs
- **Priority**: Lower number = higher priority
- **Delay**: Time before job becomes ready
- **TTR**: Time To Run - max time worker has to process

## Producer Implementation

### Python Producer

```python
from beanstalkc import Connection
import json
import time

class JobProducer:
    def __init__(self, host='localhost', port=11300):
        self.conn = Connection(host, port)
    
    def put_job(self, tube, data, priority=1024, delay=0, ttr=300):
        """
        Put job into tube
        priority: Lower = higher priority (default 1024)
        delay: Seconds before job becomes ready
        ttr: Time To Run in seconds
        """
        self.conn.use(tube)
        job_data = json.dumps(data)
        job_id = self.conn.put(job_data, priority=priority, delay=delay, ttr=ttr)
        return job_id
    
    def close(self):
        self.conn.close()

# Usage
producer = JobProducer()

# Send email job
producer.put_job(
    'emails',
    {
        'to': 'user@example.com',
        'subject': 'Welcome',
        'template': 'welcome'
    },
    priority=512,  # Higher priority
    ttr=60  # 60 seconds to process
)

# Schedule job for later
producer.put_job(
    'reports',
    {'report_type': 'daily'},
    delay=3600  # Run in 1 hour
)
```

### PHP Producer

```php
<?php

use Pheanstalk\Pheanstalk;

class JobProducer
{
    private $pheanstalk;
    
    public function __construct($host = 'localhost', $port = 11300)
    {
        $this->pheanstalk = Pheanstalk::create($host, $port);
    }
    
    public function putJob($tube, $data, $priority = 1024, $delay = 0, $ttr = 300)
    {
        $this->pheanstalk->useTube($tube);
        
        $jobData = json_encode($data);
        
        return $this->pheanstalk
            ->put($jobData, $priority, $delay, $ttr);
    }
}

// Usage
$producer = new JobProducer();

$producer->putJob('emails', [
    'to' => 'user@example.com',
    'subject' => 'Welcome',
    'template' => 'welcome'
], 512, 0, 60);
```

## Worker Implementation

### Python Worker

```python
from beanstalkc import Connection
import json
import signal
import sys

class QueueWorker:
    def __init__(self, host='localhost', port=11300):
        self.conn = Connection(host, port)
        self.running = True
        self.setup_signal_handlers()
    
    def setup_signal_handlers(self):
        signal.signal(signal.SIGTERM, self.handle_shutdown)
        signal.signal(signal.SIGINT, self.handle_shutdown)
    
    def handle_shutdown(self, signum, frame):
        print("Shutting down gracefully...")
        self.running = False
    
    def watch_tube(self, tube):
        """Watch a tube for jobs"""
        self.conn.watch(tube)
        self.conn.ignore('default')  # Ignore default tube
    
    def reserve_job(self, timeout=1):
        """Reserve a job with timeout"""
        try:
            job = self.conn.reserve(timeout=timeout)
            return job
        except:
            return None
    
    def process_job(self, job, handler):
        """Process a job with handler function"""
        try:
            data = json.loads(job.body)
            handler(data)
            job.delete()
            return True
        except Exception as e:
            print(f"Error processing job: {e}")
            # Bury job for manual inspection
            job.bury()
            return False
    
    def run(self, tube, handler):
        """Run worker loop"""
        self.watch_tube(tube)
        print(f"Worker started, watching tube: {tube}")
        
        while self.running:
            job = self.reserve_job(timeout=1)
            
            if job:
                self.process_job(job, handler)
            
            # Allow signal handling
            if not self.running:
                break
        
        print("Worker stopped")

# Email handler
def send_email_handler(data):
    print(f"Sending email to {data['to']}")
    # Actual email sending logic
    send_email(data['to'], data['subject'], data['template'])

# Run worker
worker = QueueWorker()
worker.run('emails', send_email_handler)
```

### PHP Worker

```php
<?php

use Pheanstalk\Pheanstalk;

class QueueWorker
{
    private $pheanstalk;
    private $running = true;
    
    public function __construct($host = 'localhost', $port = 11300)
    {
        $this->pheanstalk = Pheanstalk::create($host, $port);
        
        // Handle shutdown signals
        pcntl_signal(SIGTERM, [$this, 'handleShutdown']);
        pcntl_signal(SIGINT, [$this, 'handleShutdown']);
    }
    
    public function handleShutdown($signal)
    {
        echo "Shutting down gracefully...\n";
        $this->running = false;
    }
    
    public function watchTube($tube)
    {
        $this->pheanstalk->watch($tube);
        $this->pheanstalk->ignore('default');
    }
    
    public function run($tube, $handler)
    {
        $this->watchTube($tube);
        echo "Worker started, watching tube: {$tube}\n";
        
        while ($this->running) {
            pcntl_signal_dispatch();
            
            $job = $this->pheanstalk
                ->reserveWithTimeout(1); // 1 second timeout
            
            if ($job) {
                $this->processJob($job, $handler);
            }
        }
        
        echo "Worker stopped\n";
    }
    
    private function processJob($job, $handler)
    {
        try {
            $data = json_decode($job->getData(), true);
            $handler($data);
            $this->pheanstalk->delete($job);
        } catch (Exception $e) {
            echo "Error processing job: {$e->getMessage()}\n";
            $this->pheanstalk->bury($job);
        }
    }
}

// Handler function
function sendEmailHandler($data)
{
    echo "Sending email to {$data['to']}\n";
    // Actual email sending logic
}

// Run worker
$worker = new QueueWorker();
$worker->run('emails', 'sendEmailHandler');
```

## Advanced Patterns

### Priority-Based Processing

```python
class PriorityWorker(QueueWorker):
    def put_priority_job(self, tube, data, priority_level='normal'):
        priorities = {
            'critical': 1,
            'high': 256,
            'normal': 1024,
            'low': 2048
        }
        
        priority = priorities.get(priority_level, 1024)
        return self.put_job(tube, data, priority=priority)

# Usage
producer = PriorityWorker()
producer.put_priority_job('emails', email_data, 'critical')  # Processed first
producer.put_priority_job('emails', email_data, 'low')  # Processed last
```

### Delayed Jobs

```python
class ScheduledJobProducer(JobProducer):
    def schedule_job(self, tube, data, delay_seconds):
        """Schedule job to run after delay"""
        return self.put_job(tube, data, delay=delay_seconds)
    
    def schedule_at(self, tube, data, run_at_timestamp):
        """Schedule job to run at specific time"""
        delay = max(0, run_at_timestamp - time.time())
        return self.put_job(tube, data, delay=int(delay))

# Usage
producer = ScheduledJobProducer()

# Run in 1 hour
producer.schedule_job('reports', report_data, delay_seconds=3600)

# Run at specific time
import datetime
run_time = datetime.datetime(2016, 12, 25, 9, 0, 0).timestamp()
producer.schedule_at('reports', report_data, run_time)
```

### Job Retries

```python
class RetryWorker(QueueWorker):
    def process_job(self, job, handler, max_retries=3):
        try:
            data = json.loads(job.body)
            
            # Check retry count
            retry_count = data.get('_retry_count', 0)
            
            if retry_count >= max_retries:
                print(f"Job failed after {max_retries} retries")
                job.bury()
                return False
            
            # Process job
            handler(data)
            job.delete()
            return True
            
        except Exception as e:
            print(f"Error: {e}, retrying...")
            
            # Increment retry count
            data['_retry_count'] = retry_count + 1
            
            # Release job back to queue with delay
            job.release(delay=60 * (retry_count + 1))  # Exponential backoff
            return False
```

### Multiple Tubes

```python
class MultiTubeWorker(QueueWorker):
    def run_multiple(self, tubes, handlers):
        """Watch multiple tubes"""
        for tube in tubes:
            self.conn.watch(tube)
        self.conn.ignore('default')
        
        print(f"Watching tubes: {', '.join(tubes)}")
        
        while self.running:
            job = self.reserve_job(timeout=1)
            
            if job:
                tube = job.stats()['tube']
                handler = handlers.get(tube)
                
                if handler:
                    self.process_job(job, handler)
                else:
                    job.release()
            
            if not self.running:
                break

# Usage
handlers = {
    'emails': send_email_handler,
    'images': process_image_handler,
    'reports': generate_report_handler
}

worker = MultiTubeWorker()
worker.run_multiple(['emails', 'images', 'reports'], handlers)
```

## Monitoring and Management

### Job Statistics

```python
class QueueMonitor:
    def __init__(self, host='localhost', port=11300):
        self.conn = Connection(host, port)
    
    def get_tube_stats(self, tube):
        """Get statistics for a tube"""
        self.conn.watch(tube)
        stats = self.conn.stats_tube(tube)
        return {
            'name': stats['name'],
            'current_jobs_ready': stats['current-jobs-ready'],
            'current_jobs_urgent': stats['current-jobs-urgent'],
            'current_jobs_reserved': stats['current-jobs-reserved'],
            'current_jobs_delayed': stats['current-jobs-delayed'],
            'current_jobs_buried': stats['current-jobs-buried'],
            'total_jobs': stats['total-jobs'],
        }
    
    def get_server_stats(self):
        """Get server-wide statistics"""
        return self.conn.stats()
    
    def list_tubes(self):
        """List all tubes"""
        return self.conn.list_tubes()

# Usage
monitor = QueueMonitor()
stats = monitor.get_tube_stats('emails')
print(f"Ready jobs: {stats['current_jobs_ready']}")
print(f"Buried jobs: {stats['current_jobs_buried']}")
```

### Buried Job Management

```python
class BuriedJobManager:
    def __init__(self, host='localhost', port=11300):
        self.conn = Connection(host, port)
    
    def list_buried_jobs(self, tube):
        """List buried jobs in a tube"""
        self.conn.watch(tube)
        buried_jobs = []
        
        while True:
            try:
                job = self.conn.peek_buried()
                if not job:
                    break
                
                buried_jobs.append({
                    'id': job.jid,
                    'body': job.body
                })
                job.kick()  # Move to ready
            except:
                break
        
        return buried_jobs
    
    def kick_buried_jobs(self, tube, count=1):
        """Kick buried jobs back to ready"""
        self.conn.use(tube)
        return self.conn.kick(count)

# Usage
manager = BuriedJobManager()
buried = manager.list_buried_jobs('emails')

for job in buried:
    print(f"Buried job {job['id']}: {job['body']}")

# Kick jobs back
manager.kick_buried_jobs('emails', count=10)
```

## Production Deployment

### Supervisor Configuration

```ini
[program:beanstalk-worker]
command=/usr/bin/python /app/worker.py
directory=/app
user=www-data
autostart=true
autorestart=true
stderr_logfile=/var/log/beanstalk-worker.err.log
stdout_logfile=/var/log/beanstalk-worker.out.log
numprocs=4
process_name=%(program_name)s_%(process_num)02d
```

### Systemd Service

```ini
[Unit]
Description=Beanstalk Queue Worker
After=network.target beanstalkd.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/app
ExecStart=/usr/bin/python /app/worker.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Best Practices

1. **Set appropriate TTR** - Give workers enough time
2. **Handle failures gracefully** - Bury or retry failed jobs
3. **Monitor buried jobs** - Alert on high buried count
4. **Use priorities wisely** - Don't overuse high priority
5. **Scale workers horizontally** - Multiple workers per tube
6. **Log job processing** - Track success/failure rates
7. **Use delays for retries** - Exponential backoff
8. **Clean up old jobs** - Monitor job age

## Conclusion

Beanstalkd provides a simple, fast queue system:
- Easy to set up and use
- Handles high throughput
- Built-in priority and delays
- Reliable job processing

Start with basic producers and workers, then add retries, monitoring, and scaling as needed. The simplicity of Beanstalkd makes it perfect for most queue use cases.

---

*Beanstalkd queue patterns from November 2016, using beanstalkd 1.10.*

---
layout: post
title: "Building a Queue Worker System with Beanstalk"
date: 2016-11-22
categories: [Architecture]
tags: [Beanstalk, Queue, Workers, Background Jobs]
excerpt: "Your users don't want to wait for emails, thumbnails, and PDFs. Beanstalkd is the boring, fast queue that processes millions of jobs without making you learn Kafka. Here's how we built workers that actually survive production."
---

Nobody wants to wait for an email to send.

Or a thumbnail to generate. Or a PDF to render. Or a webhook to retry for the third time. These jobs belong off the request path — in a queue, handled by workers that can fail, retry, and scale without the user refreshing and wondering if the button worked.

We tried the complex options first. RabbitMQ with exchanges and routing keys. Custom Redis lists with hand-rolled reliability semantics. Both worked. Both required a dedicated person to understand them.

Then we found Beanstalkd — a work queue so simple it fits in your head in one coffee break. No clustering drama. No protocol specification the size of a novella. Just tubes, jobs, priorities, and the reliability primitives you actually need. After processing millions of jobs through it, simplicity wasn't a compromise. It was the feature.

## Why Beanstalkd

- **Simple**: One binary. One protocol. One mental model.
- **Fast**: Thousands of jobs per second on modest hardware.
- **Persistent**: Jobs survive restarts (with the right options).
- **Priority**: Built-in, not bolted on.
- **Delays**: Schedule jobs for later without a separate scheduler.

It's not Kafka. It's not trying to be. It's the queue you reach for when "process this later" is the requirement and "operate a distributed log platform" is not.

## Getting Started

```bash
# Using Docker
docker run -d --name beanstalkd \
    -p 11300:11300 \
    schickling/beanstalkd

# Or install directly
apt-get install beanstalkd
```

Thirty seconds to a running queue. Try that with a managed Kafka cluster.

## The Vocabulary

Beanstalkd has five concepts. That's the whole model:

- **Tube**: A named queue (`emails`, `images`, `reports`)
- **Job**: A unit of work (usually JSON)
- **Producer**: Puts jobs in tubes
- **Worker**: Reserves and processes jobs
- **Priority**: Lower number = higher priority (yes, inverted — you'll get used to it)
- **Delay**: Seconds before a job becomes ready
- **TTR** (Time To Run): How long a worker has before the job goes back to ready

## Producers: Putting Work in the Queue

### Python

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

### PHP

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

The request returns immediately. The email sends when a worker gets to it. User sees "Welcome!" and moves on. That's the whole value proposition.

## Workers: The Other Half

A producer without a worker is a storage system. Workers reserve jobs, process them, and either delete (success) or bury/release (failure).

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

Signal handlers matter. Without graceful shutdown, a deploy kills workers mid-job and jobs reappear as timed-out — processed twice, or not at all, depending on your luck.

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

`bury()` on failure is a choice. The job goes to a graveyard for inspection instead of retrying forever. We'll add smarter retry logic below.

## Patterns That Make It Production-Ready

### Priority: Not Everything Is Urgent

Password reset emails before weekly newsletters. Beanstalkd handles this natively:

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

Don't make everything `critical`. That's how you recreate the problem queues were supposed to solve.

### Delayed Jobs: Cron Without Cron

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

"Send this email in 24 hours" is a delayed job, not a cron entry, not a database table of scheduled tasks with a poller. Simpler. Fewer moving parts.

### Retries: Because Things Fail

Burying on first failure is fine for debugging. Production wants retries with backoff:

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

`release(delay=...)` puts the job back in the queue with a delay. Exponential backoff keeps a failing downstream service from getting hammered by retry storms.

### Multiple Tubes, One Worker

Small teams don't want ten worker processes. One worker can watch multiple tubes:

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

One low-priority report job won't block urgent emails if you use separate tubes and priorities correctly.

## Monitoring: Buried Jobs Are Smoke

### Queue Statistics

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

Alert on buried job count. Buried jobs are failures you haven't looked at yet. A climbing buried count means something is systematically broken.

### Managing Buried Jobs

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

`kick` resurrects buried jobs for retry. Use after you've fixed the underlying bug, not before.

## Production Deployment

### Supervisor: Multiple Workers, One Config

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

`numprocs=4` runs four workers. Scale horizontally by adding processes, not by making one worker multithreaded. Beanstalkd handles the distribution.

### Systemd Alternative

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

## What We Learned

Set TTR generously — a job that exceeds TTR gets released back to ready and may run twice. Handle failures with `release` and exponential backoff, not infinite immediate retries. Monitor buried jobs like they're production incidents waiting to happen. Use priorities sparingly. Scale workers horizontally. Log job IDs on processing so you can trace failures.

Beanstalkd won't solve distributed transactions or event sourcing. It solves "do this thing later, reliably, fast" — which is 90% of what background jobs actually need.

Start with a producer, a worker, and one tube. Add priorities when some jobs matter more. Add delays when you need scheduling. Add retries when failures happen (they will). Add monitoring when buried jobs start accumulating. Each layer solves a real problem.

The queue that ships is the simple one. Beanstalkd is embarrassingly simple. That's why it worked.

---

*Beanstalkd queue patterns from November 2016, using beanstalkd 1.10. Redis queues, SQS, and Sidekiq have since become common alternatives; Beanstalkd remains a solid choice for straightforward job processing.*

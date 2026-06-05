---
layout: post
title: "Infrastructure as Code with Terraform: Getting Started"
date: 2019-01-26
categories: [How-To]
tags: [Terraform, IaC, DevOps, AWS]
excerpt: "I once rebuilt a production VPC from memory at 2am. Never again. Here's how Terraform turned our infrastructure from tribal knowledge into something you can actually review in a PR."
---

At 2:14am on a Tuesday, our primary region went sideways. Not catastrophically—just enough that someone had to rebuild networking from scratch while the rest of the team watched Slack like it was a horror movie.

The person who knew the VPC layout was on vacation. The runbook was a Google Doc last edited during the Obama administration. We got it working eventually, but the process involved a lot of clicking in the AWS console and a concerning amount of hope.

That week we adopted Terraform. Not because HashiCorp had great swag (they did), but because **infrastructure deserves the same rigor as application code**: version control, review, rollback, and the ability to answer "what changed?" without archaeology.

Terraform is Infrastructure as Code (IaC). You describe what you want—VPCs, instances, buckets—in declarative configuration files. Terraform figures out how to get there and tracks what it built in a **state file**. Change the config, run `plan`, review the diff, run `apply`. It's gloriously boring in the best way.

## Install Terraform (the easy part)

```bash
# macOS
brew install terraform

# Linux
wget https://releases.hashicorp.com/terraform/0.12.0/terraform_0.12.0_linux_amd64.zip
unzip terraform_0.12.0_linux_amd64.zip
sudo mv terraform /usr/local/bin/

# Verify
terraform version
```

In 2019 we're on Terraform 0.12+, which finally made HCL feel like a real language instead of a puzzle. If you're reading this years later and wondering why the syntax looks slightly different from 0.11 blog posts—yes, we survived that migration. You can too.

## Your first configuration

Everything starts with a provider. Terraform doesn't talk to AWS by itself; the AWS provider does the heavy lifting.

```hcl
# main.tf
terraform {
  required_version = ">= 0.12"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}
```

Now create something. An S3 bucket is the "Hello, World" of cloud IaC—useful, low blast radius, and impossible to misconfigure into a security incident if you're careful with ACLs:

```hcl
# Create S3 bucket
resource "aws_s3_bucket" "my_bucket" {
  bucket = "my-unique-bucket-name-12345"
  
  tags = {
    Name        = "My Bucket"
    Environment = "Production"
  }
}
```

Run `terraform init` once per project (downloads providers), then `terraform plan` to preview changes. **Always plan before apply.** I cannot stress this enough. The one time you skip it is the time Terraform destroys something you loved.

## Building a real stack

A lone bucket is fine for learning. Production needs networking, compute, and security groups that don't say "SSH from 0.0.0.0/0" unless you're actively trying to get on a security mailing list.

### Security group (your firewall, but as code)

```hcl
resource "aws_security_group" "web" {
  name        = "web-sg"
  description = "Security group for web servers"
  vpc_id      = aws_vpc.main.id
  
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
  
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  tags = {
    Name = "Web Security Group"
  }
}
```

Notice SSH is restricted to `10.0.0.0/8`. Your future self—and your security team—will send thank-you notes.

### VPC (the foundation everything else stands on)

```hcl
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  
  tags = {
    Name = "Main VPC"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true
  
  tags = {
    Name = "Public Subnet"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  
  tags = {
    Name = "Main IGW"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  
  tags = {
    Name = "Public Route Table"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
```

### EC2 instance (compute with user data)

```hcl
resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t2.micro"
  
  vpc_security_group_ids = [aws_security_group.web.id]
  subnet_id              = aws_subnet.public.id
  
  user_data = <<-EOF
    #!/bin/bash
    yum update -y
    yum install -y httpd
    systemctl start httpd
    systemctl enable httpd
  EOF
  
  tags = {
    Name = "Web Server"
  }
}
```

The magic here is **resource references**: `aws_security_group.web.id` creates an implicit dependency. Terraform won't create the instance before the security group exists. No more "I created things in the wrong order and now DNS doesn't work."

## Variables: stop copy-pasting regions

Hardcoding `us-east-1` in seventeen files is how you accidentally deploy staging to production. Variables fix that:

```hcl
# variables.tf
variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t2.micro"
}

variable "environment" {
  description = "Environment name"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

# Use variables
resource "aws_instance" "web" {
  instance_type = var.instance_type
  # ...
}
```

Terraform 0.13+ validation blocks are underrated. They turn "someone typo'd prod as prdo" from a 3am incident into a friendly error at plan time.

Populate values per environment:

```hcl
# terraform.tfvars
region        = "us-east-1"
instance_type = "t3.medium"
environment   = "production"
```

## Outputs: give other systems something to grab

Your CI/CD pipeline needs the instance IP. Your DNS needs the load balancer hostname. Outputs are Terraform's way of saying "here's what got created":

```hcl
# outputs.tf
output "instance_id" {
  description = "ID of the EC2 instance"
  value       = aws_instance.web.id
}

output "instance_public_ip" {
  description = "Public IP of the EC2 instance"
  value       = aws_instance.web.public_ip
}

output "s3_bucket_name" {
  description = "Name of the S3 bucket"
  value       = aws_s3_bucket.my_bucket.id
}
```

## Modules: DRY for infrastructure

After you've copy-pasted the same EC2 block three times, you'll crave modules. A module is a reusable package of Terraform resources—think of it as a function, but for VPCs.

```
modules/ec2/
├── main.tf
├── variables.tf
├── outputs.tf
└── README.md
```

```hcl
# modules/ec2/main.tf
resource "aws_instance" "this" {
  ami           = var.ami_id
  instance_type = var.instance_type
  
  vpc_security_group_ids = var.security_group_ids
  subnet_id              = var.subnet_id
  
  tags = merge(
    var.tags,
    {
      Name = var.name
    }
  )
}

# modules/ec2/variables.tf
variable "ami_id" {
  type = string
}

variable "instance_type" {
  type    = string
  default = "t2.micro"
}

variable "security_group_ids" {
  type = list(string)
}

variable "subnet_id" {
  type = string
}

variable "name" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

# modules/ec2/outputs.tf
output "instance_id" {
  value = aws_instance.this.id
}

output "instance_public_ip" {
  value = aws_instance.this.public_ip
}
```

Using it:

```hcl
# main.tf
module "web_server" {
  source = "./modules/ec2"
  
  ami_id             = "ami-0c55b159cbfafe1f0"
  instance_type      = "t3.medium"
  security_group_ids = [aws_security_group.web.id]
  subnet_id          = aws_subnet.public.id
  name               = "Web Server"
  
  tags = {
    Environment = "Production"
    Team        = "Platform"
  }
}

# Use module output
resource "aws_eip" "web" {
  instance = module.web_server.instance_id
  vpc      = true
}
```

The `merge()` on tags is a small thing that pays off huge when you have organization-wide tagging policies and don't want to repeat `Environment` on every resource.

## State: the file that knows what Terraform built

Terraform state is a JSON inventory of your real infrastructure. **Treat it like a database backup**, because losing it means Terraform forgets what it manages—and might try to recreate everything.

Local state works for solo experiments:

```hcl
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
```

Teams need remote state in S3 with locking:

```hcl
terraform {
  backend "s3" {
    bucket         = "my-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}
```

The DynamoDB table prevents two people from running `apply` simultaneously and creating a resource soup:

```hcl
# Create DynamoDB table for locking
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  
  attribute {
    name = "LockID"
    type = "S"
  }
}
```

I once watched two engineers apply the same module concurrently without locking. We ended up with duplicate load balancers and a very awkward finance conversation. Locking is not optional for shared infrastructure.

## Workspaces: one codebase, many environments

Workspaces let you reuse the same Terraform config for staging and production without duplicating repos:

```bash
# Create workspace
terraform workspace new production
terraform workspace new staging

# Switch workspace
terraform workspace select production

# List workspaces
terraform workspace list

# Use in configuration
resource "aws_instance" "web" {
  instance_type = terraform.workspace == "production" ? "t3.large" : "t2.micro"
  # ...
}
```

Workspaces are convenient but not a full multi-account strategy. For serious isolation, most teams use separate state backends (or separate AWS accounts) per environment. Workspaces are great for "I need a quick staging slice" not "this must never touch prod."

## The workflow that actually works

Commit your `.tf` files to Git. Run `terraform fmt` so formatting debates die quietly. Run `terraform validate` in CI. **Never apply from a laptop without a plan review** for production.

```bash
# Initialize
terraform init

# Validate configuration
terraform validate

# Format files
terraform fmt

# Plan changes
terraform plan

# Apply changes
terraform apply

# Destroy infrastructure
terraform destroy

# Show state
terraform show

# List resources
terraform state list

# Remove from state
terraform state rm aws_instance.web

# Import existing resource
terraform import aws_instance.web i-1234567890abcdef0
```

The `import` command deserves a moment of respect. You will inherit infrastructure someone built by hand in 2014. Import lets Terraform adopt existing resources instead of trying to recreate them and failing spectacularly.

## Lessons from production

**Version control everything.** If it's not in Git, it doesn't exist. Console changes are technical debt with interest.

**Modules are how you scale.** Start flat, extract patterns when you feel the pain of duplication. Don't module-ize on day one—you'll guess wrong.

**Remote state and locking are non-negotiable** for teams. Local `terraform.tfstate` on someone's MacBook is a disaster waiting for a spilled coffee.

**Plan is your friend.** `terraform plan -out=plan.tfplan` saved us more than once in CI pipelines where apply only runs on approved artifacts.

**Variables and validation catch mistakes early.** Cheaper at plan time than at 2am.

**Format and validate in CI.** Bikeshedding about indentation is exhausting; let the robot decide.

## Where to start

Pick one non-critical resource—a dev S3 bucket, a throwaway VPC—and get the full loop working: write, plan, apply, change, plan again, destroy. Once muscle memory kicks in, extract modules and wire up remote state.

Terraform won't make infrastructure easy. Cloud is still hard. But it makes infrastructure **legible**—reviewable, reproducible, and something you can hand to the engineer who's covering vacation shifts without whispering ancient console rituals.

That's worth more than any single `apply` ever saved us.

---

*Written January 2019, covering Terraform 0.12+ and AWS provider ~> 3.0. Syntax and provider versions have evolved since; the workflow and state discipline remain the point.*

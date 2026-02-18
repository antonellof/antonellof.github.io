---
layout: post
title: "Infrastructure as Code with Terraform: Getting Started"
date: 2019-01-26
categories: [How-To]
tags: [Terraform, IaC, DevOps, AWS]
excerpt: "Learn Infrastructure as Code with Terraform. Create, manage, and version your cloud infrastructure using declarative configuration files."
---

Terraform enables managing infrastructure as code. After using Terraform in production, here's how to get started effectively.

## What is Terraform?

Terraform is an Infrastructure as Code (IaC) tool that:
- Manages cloud infrastructure declaratively
- Supports multiple providers (AWS, GCP, Azure)
- Tracks state changes
- Enables version control for infrastructure

## Installation

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

## Basic Configuration

### Provider Configuration

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

### Simple Resource

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

## Common Resources

### EC2 Instance

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

### Security Group

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

### VPC Configuration

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

## Variables

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

### Variable Files

```hcl
# terraform.tfvars
region        = "us-east-1"
instance_type = "t3.medium"
environment   = "production"
```

## Outputs

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

## Modules

### Module Structure

```
modules/ec2/
├── main.tf
├── variables.tf
├── outputs.tf
└── README.md
```

### Module Definition

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

### Using Modules

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

## State Management

### Local State

```hcl
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
```

### Remote State (S3)

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

### State Locking

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

## Workspaces

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

## Best Practices

1. **Version control** - Commit Terraform files to Git
2. **Use modules** - Reusable components
3. **Remote state** - Store state in S3
4. **State locking** - Prevent concurrent modifications
5. **Use variables** - Don't hardcode values
6. **Validate** - Run `terraform validate`
7. **Format** - Run `terraform fmt`
8. **Plan before apply** - Always review changes

## Common Commands

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

## Conclusion

Terraform enables:
- Version-controlled infrastructure
- Reproducible environments
- Multi-cloud support
- Team collaboration

Start with simple resources, then use modules and workspaces as you scale. The patterns shown here handle production infrastructure.

---

*Terraform Infrastructure as Code from January 2019, covering Terraform 0.12+ features.*

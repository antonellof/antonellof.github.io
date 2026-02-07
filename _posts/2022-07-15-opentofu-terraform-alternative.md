---
layout: post
title: "OpenTofu: Open Source Alternative to Terraform"
date: 2022-07-15
categories: [How-To]
tags: [OpenTofu, Terraform, IaC]
excerpt: "Migrate to OpenTofu: Terraform-compatible open source alternative. Learn installation, migration, and differences from Terraform."
---

OpenTofu is an open-source fork of Terraform. After migrating to OpenTofu, here's what you need to know.

## What is OpenTofu?

OpenTofu:
- **Terraform-compatible** - Same syntax
- **Open source** - MPL 2.0 license
- **Community-driven** - Linux Foundation
- **Drop-in replacement** - Same commands

## Installation

```bash
# Install OpenTofu
brew install opentofu

# Or download binary
wget https://github.com/opentofu/opentofu/releases/download/v1.6.0/tofu_1.6.0_linux_amd64.zip
unzip tofu_1.6.0_linux_amd64.zip
sudo mv tofu /usr/local/bin/
```

## Migration

### From Terraform

```bash
# Rename terraform to tofu
mv terraform.tfstate tofu.tfstate

# Use tofu instead of terraform
tofu init
tofu plan
tofu apply
```

### State Migration

```bash
# OpenTofu uses same state format
# No migration needed for state files
```

## Differences

### Command Changes

```bash
# Terraform
terraform init
terraform plan
terraform apply

# OpenTofu
tofu init
tofu plan
tofu apply
```

### Compatibility

- **Same syntax** - HCL unchanged
- **Same providers** - Compatible
- **Same state** - Compatible format
- **Same workflows** - Drop-in replacement

## Best Practices

1. **Test migration** - In dev first
2. **Update CI/CD** - Change commands
3. **Update docs** - Reflect changes
4. **Monitor** - Track usage
5. **Contribute** - Open source
6. **Stay updated** - New releases
7. **Community** - Join discussions
8. **Document** - Migration notes

## Conclusion

OpenTofu provides:
- Terraform compatibility
- Open source license
- Community support
- Drop-in replacement

Migrate gradually, test thoroughly. OpenTofu works as a Terraform replacement.

---

*OpenTofu from July 2022, covering migration from Terraform.*

# Real-AWS deployment of StreamForge. Written, validated, linted and security-scanned in
# CI; NEVER applied by this project (zero-cost constraint). See README.md.
terraform {
  required_version = "1.17.1"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "6.72.0" }
    random = { source = "hashicorp/random", version = "3.7.2" }
  }
  # Remote state (S3 + native lockfile). Configured at init time:
  #   terraform init -backend-config="bucket=<state-bucket>" -backend-config="key=streamforge/terraform.tfstate"
  backend "s3" {
    region       = "eu-west-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "streamforge", Environment = var.environment, ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

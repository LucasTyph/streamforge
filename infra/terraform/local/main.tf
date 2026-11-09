# Applies the pipeline module to the local emulators (ADR-002).
# Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (see .env.example).
# Run: make tf-local

terraform {
  required_version = "1.17.1"
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.72.0" }
  }
}

variable "s3_endpoint" {
  type    = string
  default = "http://localhost:8333"
}

variable "sqs_endpoint" {
  type    = string
  default = "http://localhost:9324"
}

variable "sns_endpoint" {
  type    = string
  default = "http://localhost:9911"
}

provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true

  endpoints {
    s3  = var.s3_endpoint
    sqs = var.sqs_endpoint
    sns = var.sns_endpoint
  }
}

module "pipeline" {
  source        = "../modules/pipeline"
  web_origins   = ["http://localhost:3000", "http://streamforge.localhost"]
  manage_queues = false # ElasticMQ ignores some attributes, see ADR-002
}

output "pipeline" {
  value = module.pipeline
}

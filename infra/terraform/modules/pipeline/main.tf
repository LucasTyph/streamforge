# Buckets, topics, queues (+DLQs) and subscriptions for the video pipeline.
# Used by infra/terraform/local (emulators) and, later, infra/terraform/aws.

terraform {
  required_version = ">= 1.11" # modules declare a minimum; root modules pin exactly
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.72.0" }
  }
}

variable "prefix" {
  type    = string
  default = "streamforge"
}

variable "web_origins" {
  description = "Browser origins allowed to PUT upload parts / GET media."
  type        = list(string)
}

variable "max_receive_count" {
  type    = number
  default = 3
}

variable "manage_queues" {
  description = "Create SQS queues here. false = queues pre-exist (ElasticMQ declares them in its config, see ADR-002)."
  type        = bool
  default     = true
}

variable "account_id" {
  description = "Account ID used to build queue ARNs when manage_queues = false."
  type        = string
  default     = "000000000000"
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for buckets, topics and queues (null = provider defaults, e.g. on emulators)."
  type        = string
  default     = null
}

variable "harden_buckets" {
  description = "Public access block, versioning, SSE and lifecycle on the buckets (real AWS; SeaweedFS lacks these APIs)."
  type        = bool
  default     = true
}

variable "enable_queue_policies" {
  description = "Attach SQS policies allowing SNS delivery (real AWS only; emulators don't enforce IAM)."
  type        = bool
  default     = true
}

data "aws_region" "current" {}

locals {
  topics = ["video-uploaded", "video-probed", "job-status"]

  # queue => { topic it subscribes to, visibility timeout (s) }
  queues = {
    probe          = { topic = "video-uploaded", visibility = 60 }
    transcode      = { topic = "video-probed", visibility = 120 } # workers extend via heartbeats
    thumbnail      = { topic = "video-probed", visibility = 120 }
    catalog-status = { topic = "job-status", visibility = 30 }
  }
}

resource "aws_s3_bucket" "raw" {
  bucket        = "${var.prefix}-raw"
  force_destroy = true
}

resource "aws_s3_bucket" "processed" {
  bucket        = "${var.prefix}-processed"
  force_destroy = true
}

resource "aws_s3_bucket_cors_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.web_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"] # browser needs part ETags to complete the multipart upload
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_cors_configuration" "processed" {
  bucket = aws_s3_bucket.processed.id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.web_origins
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_sns_topic" "this" {
  for_each          = toset(local.topics)
  name              = "${var.prefix}-${each.key}"
  kms_master_key_id = var.kms_key_arn
}

resource "aws_sqs_queue" "dlq" {
  for_each                  = var.manage_queues ? local.queues : {}
  name                      = "${var.prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days
  kms_master_key_id         = var.kms_key_arn
}

resource "aws_sqs_queue" "this" {
  for_each                   = var.manage_queues ? local.queues : {}
  name                       = "${var.prefix}-${each.key}"
  visibility_timeout_seconds = each.value.visibility
  receive_wait_time_seconds  = 20 # long polling
  kms_master_key_id          = var.kms_key_arn
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })
}

locals {
  queue_arns = { for k, _ in local.queues : k => (var.manage_queues ? aws_sqs_queue.this[k].arn :
  "arn:aws:sqs:${data.aws_region.current.region}:${var.account_id}:${var.prefix}-${k}") }
}

resource "aws_sqs_queue_policy" "allow_sns" {
  for_each  = var.manage_queues && var.enable_queue_policies ? local.queues : {}
  queue_url = aws_sqs_queue.this[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.this[each.key].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.this[each.value.topic].arn } }
    }]
  })
}

resource "aws_sns_topic_subscription" "this" {
  for_each             = local.queues
  topic_arn            = aws_sns_topic.this[each.value.topic].arn
  protocol             = "sqs"
  endpoint             = local.queue_arns[each.key]
  raw_message_delivery = true
}

output "buckets" {
  value = { raw = aws_s3_bucket.raw.id, processed = aws_s3_bucket.processed.id }
}

output "topic_arns" {
  value = { for k, t in aws_sns_topic.this : k => t.arn }
}

output "queue_arns" {
  value = local.queue_arns
}

# ---- bucket hardening (real AWS) -------------------------------------------------
locals {
  buckets = { raw = aws_s3_bucket.raw.id, processed = aws_s3_bucket.processed.id }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = var.harden_buckets ? local.buckets : {}
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true # processed media would be served through CloudFront (OAC), not public S3
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = var.harden_buckets ? local.buckets : {}
  bucket   = each.value
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = var.harden_buckets ? local.buckets : {}
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = var.harden_buckets ? local.buckets : {}
  bucket   = each.value
  rule {
    id     = "cleanup"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 } # abandoned browser uploads
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

output "bucket_arns" {
  value = { raw = aws_s3_bucket.raw.arn, processed = aws_s3_bucket.processed.arn }
}

output "dlq_arns" {
  value = { for k, q in aws_sqs_queue.dlq : k => q.arn }
}

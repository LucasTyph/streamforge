# ADR-002: AWS emulation approach

- **Status:** Accepted (updated after M1 verification)
- **Date:** 2026-11-09

## Context
The project uses S3, SNS and SQS and must cost nothing. Since 2026-03-23, LocalStack ships
as a single image that needs an auth token tied to an account, and the
`LOCALSTACK_ACKNOWLEDGE_ACCOUNT_REQUIREMENT` workaround stopped working in April 2026. The
free tier appears to be limited to non-commercial use. We want anyone to be able to clone
and run the project with no sign-up.

## Decision
Use token-free, open-source emulators, each with the official AWS SDKs pointed at a
configurable endpoint (`AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_SQS`, `AWS_ENDPOINT_URL_SNS`):

| AWS service | Local stand-in | Notes |
|---|---|---|
| SQS | **ElasticMQ** (official `softwaremill/elasticmq-native` image) | SQS query/JSON API, DLQ redrive policies, visibility timeouts |
| S3 | **SeaweedFS** (`weed server -s3`, official `chrislusf/seaweedfs` image) | Presigned URLs and multipart upload |
| SNS | **sns-shim**: a small Go service in this repo (`go/cmd/sns-shim`) | Implements the subset we use (CreateTopic, Subscribe, Publish, plus the attribute and tag calls Terraform makes) and fans out to ElasticMQ with raw message delivery |

**Upload notification:** SeaweedFS does not emit S3-style `ObjectCreated` events. Instead,
catalog-api publishes `video-uploaded` to SNS after `CompleteMultipartUpload` succeeds. This
is a valid real-AWS design too (it avoids a duplicate S3 event). On real AWS, the
`infra/terraform/aws` modules can still configure the native S3 → SNS notification.

Garage was considered for S3. SeaweedFS was chosen because it runs as one small process
and supports multipart and presigned URLs out of the box.

## Verified in M1 (2026-11-09)
| Check | Result |
|---|---|
| S3 bucket CORS on SeaweedFS 4.53 | **Works.** `aws_s3_bucket_cors_configuration` applies; preflight from an allowed origin returns `Access-Control-Expose-Headers: ETag`, other origins get 403. |
| Presigned multipart upload on SeaweedFS | **Works**, with `requestChecksumCalculation: "WHEN_REQUIRED"` on the JS SDK v3 S3 client. The SDK default adds a CRC32 of the *empty* body to presigned URLs, which fails with `BadDigest`. Real S3 has the same issue, so this isn't an emulator workaround. |
| Terraform `aws_s3_bucket*`, `aws_sns_topic`, `aws_sns_topic_subscription` | **Work** against SeaweedFS and sns-shim. A second `terraform plan` shows no changes. |
| Terraform `aws_sqs_queue` against ElasticMQ 1.7.1 | **Does not work.** ElasticMQ doesn't store `MessageRetentionPeriod`, `MaximumMessageSize` or `SqsManagedSseEnabled`, so the provider's "attributes applied" waiter never succeeds (3-minute timeout). Deleting a queue also fails, because the provider doesn't recognise ElasticMQ's error code. |

**Decision for SQS:** locally, queues and DLQs (`maxReceiveCount = 3`) are declared in
`deploy/elasticmq/elasticmq.conf`, and the pipeline module runs with `manage_queues = false`
(it still creates the SNS->SQS subscriptions from computed queue ARNs). On real AWS the same
module creates the queues (`manage_queues = true`). `scripts/smoke-messaging.sh` checks that
the two definitions agree: every topic reaches its queues, and every queue redrives to its DLQ.
ElasticMQ keeps messages in memory, so restarting it drops in-flight messages (dev only).

**Still open (M6):** KEDA `aws-sqs-queue` scaler against ElasticMQ with a custom endpoint.
Fallback: a Prometheus queue-depth exporter and KEDA's `prometheus` scaler.

## Consequences
- No account or token is needed to run the project.
- One extra service (sns-shim) to build and maintain. It stays small and tested.
- The README must describe this accurately: "AWS APIs (S3, SNS, SQS) via local emulators
  (SeaweedFS, ElasticMQ, a custom SNS shim); Terraform IaC". It must not claim LocalStack
  or a real AWS deployment.

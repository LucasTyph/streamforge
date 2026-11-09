# ADR-002: AWS emulation approach

- **Status:** Accepted (some details to verify in M1)
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

## To verify in M1 (record the results here)
- S3 bucket CORS on SeaweedFS (needed for browser PUTs). If missing, route browser
  uploads through a same-origin proxy path in dev and document it.
- Terraform AWS provider against each emulator (`aws_s3_bucket`, `aws_sqs_queue` with
  redrive, `aws_sns_topic`/`aws_sns_topic_subscription` against sns-shim). If a resource
  can't be managed this way, create it with an init script, and keep Terraform as the
  source of truth for real AWS.
- KEDA `aws-sqs-queue` scaler against ElasticMQ with a custom endpoint (M6). Fallback:
  Prometheus queue-depth exporter + KEDA `prometheus` scaler.

## Consequences
- No account or token is needed to run the project.
- One extra service (sns-shim) to build and maintain. It stays small and tested.
- The README must describe this accurately: "AWS APIs (S3, SNS, SQS) via local emulators
  (SeaweedFS, ElasticMQ, a custom SNS shim); Terraform IaC". It must not claim LocalStack
  or a real AWS deployment.

# Résumé bullets

Every number below is measured and recorded in [results.md](results.md). Pick 4-6. Keep the
wording about AWS as it is: the project uses the AWS APIs against local emulators and
includes Terraform for real AWS that was validated but never applied.

**Project line:** StreamForge: event-driven video processing platform (Go, TypeScript,
Kubernetes, Terraform). github.com/LucasTyph/streamforge

- Built an event-driven video pipeline (Go workers, Fastify API, Next.js) on Kubernetes
  that turns browser uploads into adaptive HLS using AWS APIs (S3, SNS, SQS) via local
  emulators; the full stack starts with one command.
- Implemented queue-based autoscaling with KEDA: workers scale from 0 to 4 replicas within
  about 20 s of a 20-upload burst and back to 0 after the queue drains; 2 workers cut batch
  time by 34% (305 s to 202 s for 20 videos).
- Designed the pipeline for at-least-once delivery (idempotent jobs, visibility heartbeats,
  retries, dead-letter queues with redrive) and proved it with a chaos test: 28 worker pods
  killed mid-batch, 20/20 videos completed with every output segment intact.
- Used benchmarks to find and fix a queueing bug: workers scaled down mid long-poll left
  messages hidden for up to 2 minutes; a short-claim receive pattern cut p95 time-to-ready
  from 178 s to 56 s in the same 2-worker test.
- Added end-to-end observability with OpenTelemetry, Prometheus, Loki and Tempo: each video
  is one distributed trace (31 spans across 4 services) propagated through SNS/SQS message
  attributes, with logs linked to traces and dashboards and alerts defined as code.
- Set up CI/CD with GitHub Actions and ArgoCD: path-filtered tests and security scans,
  multi-arch images to GHCR, and GitOps deploys; a pushed commit was live in staging in
  under 4 minutes (228 s).
- Wrote Terraform for both the local environment (applied in-cluster) and a production AWS
  design (VPC, EKS, RDS, ElastiCache, KMS, least-privilege IAM roles per service) that
  passes validation, tflint and 420 checkov checks; the AWS configuration was not deployed.
- Load-tested the API with k6 at 200 requests/s (12,003 requests, 0 errors, p95 11 ms) and
  hardened every workload: non-root, read-only root filesystem, default-deny
  NetworkPolicies, resource limits and PodDisruptionBudgets.

## If asked in an interview
- **"Did you deploy to AWS?"** No. It uses the official AWS SDKs against emulators, and the
  AWS Terraform is validated and scanned only. The README lists what would change.
- **"Why didn't 4 workers beat 2?"** The benchmark ran on a 6-vCPU laptop; four parallel
  ffmpeg jobs saturate it (13 s per transcode alone, 30 s with four in parallel). On real
  nodes the next step is node autoscaling.
- **"What broke?"** See the "Failures found" notes in results.md: storage OOM under upload
  bursts, hidden messages on scale-down, videos stuck when a worker died on its last retry.

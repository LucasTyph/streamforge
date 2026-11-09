# StreamForge

Event-driven video processing platform: upload a video in the browser, and a pipeline of
autoscaling workers probes it, transcodes it to adaptive HLS, and generates thumbnails,
with live progress in the UI.

> **Status:** M0 (bootstrap) complete; M1 next. See [docs/PROGRESS.md](docs/PROGRESS.md).

## Stack
Go workers · TypeScript/Fastify API · Next.js · Postgres · Redis · Kubernetes (k3d, Helm,
KEDA, ArgoCD, CloudNativePG) · Terraform · GitHub Actions · OpenTelemetry/Prometheus/Loki/Tempo/Grafana.

AWS APIs (S3, SNS, SQS) are used through the official AWS SDKs against **local,
S3/SQS-compatible emulators** (see [ADR-002](docs/adr/002-aws-emulation.md)).
Terraform modules for real AWS are included but are only validated and linted, never applied.

## Quick start
_Coming in M1/M4:_ `make dev` (docker-compose) and `make up` (full stack on k3d).

## Docs
- [Architecture Decision Records](docs/adr/)
- [Progress](docs/PROGRESS.md)

## License
[MIT](LICENSE)

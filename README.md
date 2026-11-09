# StreamForge

Event-driven video processing platform: upload a video in the browser, and a pipeline of
autoscaling workers probes it, transcodes it to adaptive HLS, and generates thumbnails,
with live progress in the UI.

> **Status:** M3 (player, live progress, Ops page) complete; M4 (containers + Kubernetes) next. See [docs/PROGRESS.md](docs/PROGRESS.md).

## Stack
Go workers · TypeScript/Fastify API · Next.js · Postgres · Redis · Kubernetes (k3d, Helm,
KEDA, ArgoCD, CloudNativePG) · Terraform · GitHub Actions · OpenTelemetry/Prometheus/Loki/Tempo/Grafana.

AWS APIs (S3, SNS, SQS) are used through the official AWS SDKs against local emulators:
SeaweedFS (S3), ElasticMQ (SQS) and a small SNS shim written in Go
(see [ADR-002](docs/adr/002-aws-emulation.md)).
Terraform modules for real AWS are included but are only validated and linted, never applied.

## Quick start (dev loop)
Requires WSL2/Linux with Docker. Install the tools with `scripts/install-tools.sh` (see ADR-001).

```bash
make dev   # infra in Docker + Terraform + demo user, then API (:4000) and web (:3000) with hot reload
```
Open http://localhost:3000 and sign in as `demo@streamforge.local` / `demo-password`.
API docs: http://localhost:4000/docs. `make help` lists all targets.

| Target | What it does |
|---|---|
| `make test` | Go + TypeScript unit tests |
| `make media` | Generate deterministic test clips into `media/` |
| `node scripts/upload-videos.mjs media/*.mp4` | Upload through the API and wait for READY/FAILED |
| `make test-integration` | Testcontainers worker tests + upload flow and SNS->SQS routing against the running stack |
| `make test-e2e` | Playwright: upload -> READY -> plays (needs `make dev`; one-time: `sudo env "PATH=$PATH" npx playwright install-deps chromium` in `apps/web`) |
| `make lint` | go vet/gofmt, tsc, terraform fmt |
| `make down` / `make clean` | Stop the stack / also delete its data |

`make up` (full stack on k3d) arrives in M4.

## Limitations
- Local SQS queues are declared in ElasticMQ's config, not Terraform (ADR-002).
- ElasticMQ keeps messages in memory; restarting it drops in-flight messages.
- Processed media is anonymously readable from the local S3 endpoint (production: CloudFront + signed cookies). See ADR-003.

## Docs
- [Architecture Decision Records](docs/adr/)
- [Progress](docs/PROGRESS.md)

## License
[MIT](LICENSE)

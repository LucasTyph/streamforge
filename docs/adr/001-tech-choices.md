# ADR-001: Tech choices

- **Status:** Accepted
- **Date:** 2026-11-09

## Context
StreamForge is a portfolio prototype that has to run fully locally on a 16 GB Windows 11 +
WSL2 laptop (about 10 GB for WSL/Docker), cost nothing, and show real depth in
containers, Kubernetes, AWS APIs, IaC, CI/CD and observability.

## Decision
| Area | Choice |
|---|---|
| Workers + progress-svc | Go, one module (`go/cmd/{probe,transcode,thumbnail,progress}`, `go/internal/`) |
| API | TypeScript + Fastify, Drizzle ORM + SQL migrations, zod, `@fastify/swagger` |
| Frontend | Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, hls.js |
| Auth | argon2 hashing, JWT in an httpOnly cookie |
| AWS SDKs | aws-sdk-go-v2, AWS SDK for JS v3, endpoints configurable via env |
| Data | Postgres, Redis |
| Orchestration | docker-compose (dev loop), k3d + Helm (Kubernetes) |
| Postgres on K8s | CloudNativePG |
| GitOps | ArgoCD app-of-apps |
| Autoscaling | KEDA (workers 0→N on queue depth), HPA on catalog-api |
| IaC | Terraform: `infra/terraform/local` (applied to emulators), `infra/terraform/aws` (validate/lint only) |
| CI / registry | GitHub Actions, GHCR |
| Observability | kube-prometheus-stack (trimmed), Loki, Tempo, OTel Collector, Grafana |
| Testing | Go `testing` + Testcontainers, Vitest, Playwright, k6 |
| Security | Trivy, tflint, checkov, gitleaks |

Rules: no Bitnami charts/images, no MinIO, official upstream images, exact version pins
(no `latest`). Tool versions are pinned in this ADR once they are installed in WSL (M0 completion).

### Pinned tool versions
_To be filled after installation inside WSL._

## Consequences
- Two languages (Go, TS) cost a little more tooling, but each fits its job: process control
  and small images for the workers, fast iteration for the API and UI.
- Everything has to fit the RAM budget, so every workload gets requests/limits, and a
  `lite` mode skips observability.

# Progress

## M0 — Bootstrap
- [x] Environment check (2026-11-09): only git + python present on Windows; WSL2, Docker and the rest are missing. See below.
- [x] AWS emulation decision: token-free fallback ([ADR-002](adr/002-aws-emulation.md))
- [x] Repo skeleton: `.gitattributes` (LF), `.editorconfig`, `.gitignore`, MIT license, README, ADR-001, ADR-002
- [x] User installs WSL2 (Ubuntu) + Docker Desktop with WSL integration, sets `.wslconfig`
- [x] Repo cloned into the WSL filesystem (`~/code/streamforge`)
- [x] Dev tools installed and verified inside WSL (2026-11-09) (go, node LTS + pnpm, make, k3d, kubectl, helm, terraform, k6, ffmpeg, jq), versions pinned in ADR-001 and `scripts/install-tools.sh`
- [x] Docker Desktop WSL integration working in Ubuntu-24.04 (Docker 29.9.3; Ubuntu set as default WSL distro)

**M0 complete (2026-11-09).**

## M1 — Local foundation + upload
- [x] docker-compose: Postgres, Redis, SeaweedFS (S3), ElasticMQ (SQS), sns-shim (Go)
- [x] Emulator gaps verified and recorded in ADR-002 (SQS queues declared in ElasticMQ config)
- [x] `infra/terraform/modules/pipeline` + `infra/terraform/local`, applied with `make tf-local`, no drift
- [x] catalog-api: auth (argon2id + JWT cookie), `POST /videos`, presigned parts, complete/abort, `GET /videos[/:id]`, `/healthz` `/readyz`, OpenAPI at `/docs`, Drizzle migrations
- [x] Web: login/sign-up + upload page with per-chunk progress, retries, cancel; library table
- [x] Tests: Go unit (sns-shim), Vitest unit (upload planning, hashing, upload pool/retry), integration (100 MB presigned flow + SNS->SQS event), `scripts/smoke-messaging.sh`
- [x] Acceptance: signed in as the demo user in a browser and uploaded a 100 MB file; record shows `UPLOADED` (2026-11-09)

**M1 complete (2026-11-09).** Deferred to M3: shadcn/ui (plain Tailwind for now).

## M2–M7
Not started. See the build brief.

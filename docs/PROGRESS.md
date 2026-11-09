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
- [ ] docker-compose: Postgres, Redis, SeaweedFS (S3), ElasticMQ (SQS), sns-shim
- [ ] Verify emulator gaps (S3 CORS, presigned multipart, Terraform provider calls) and record in ADR-002
- [ ] `infra/terraform/local`
- [ ] catalog-api: auth, videos, presigned multipart, health, OpenAPI, migrations
- [ ] Web: login + upload with chunked progress

## M2–M7
Not started. See the build brief.

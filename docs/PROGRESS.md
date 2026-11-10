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

## M2 — Processing pipeline
- [x] Shared Go worker loop (`internal/worker`): long polling, visibility heartbeats, backoff, give-up before DLQ, drain/release on SIGTERM
- [x] probe-worker: ffprobe via presigned URL, validation (video stream, <= 5:00), rendition ladder, publishes `video-probed`
- [x] transcode-worker: one ffmpeg run -> 360p/720p HLS (never upscales, 4 s segments, veryfast), master playlist written last as the commit marker, progress to Redis
- [x] catalog-api: `jobs` table + state machine, `catalog-status` consumer, READY/FAILED aggregation with readable reasons, `playbackUrl`
- [x] Tests: Go unit (media, consumer), Vitest unit + Postgres integration (state machine), Testcontainers (redelivery idempotency, corrupt upload, DLQ after 3 attempts)
- [x] `scripts/gen-test-media.sh`, `scripts/upload-videos.mjs`
- [x] Acceptance: 5 generated clips -> READY with fetchable HLS; corrupt and 6-minute files -> FAILED with reasons; SIGTERM mid-transcode -> released and finished on attempt 2 (2026-11-09)

**M2 complete (2026-11-09).** The web UI only shows status so far; the player arrives in M3.

## M3 — Product polish
- [x] thumbnail-worker: poster, sprite sheet, WebVTT scrub index (VTT written last); Testcontainers coverage incl. redelivery
- [x] progress-svc (Go): SSE, HS256 cookie auth, Redis per-user channels ([ADR-004](adr/004-live-progress.md))
- [x] Live per-stage progress in the UI (probing, transcoding %, thumbnails), status pushes from catalog-api
- [x] UI: shadcn/ui, library grid with posters, video page with hls.js player, quality selector, scrub previews, empty/loading/error states, dark/light mode, responsive (checked at 375 px)
- [x] Ops page: queue + DLQ depths, DLQ peek, redrive, recent failed jobs (`ADMIN_EMAILS`)
- [x] Verified in a browser: playback, Auto quality, scrub preview tile, DLQ redrive of a failing message
- [x] Playwright e2e (`make test-e2e`): upload -> READY -> plays -> scrub preview; corrupt upload -> FAILED with reason. 2/2 passing in Chromium, 2 consecutive runs (2026-11-09). One-time setup: `sudo env "PATH=$PATH" npx playwright install-deps chromium`

**M3 complete (2026-11-09).** Videos processed before M3 have no thumbnails (not backfilled).

## M4 — Containers + Kubernetes
- [x] Multi-stage, non-root images: Go on distroless static, ffmpeg workers on Alpine 3.24 (ffmpeg 8.1.3), catalog-api and web (Next.js standalone) on distroless Node 26; HEALTHCHECK where the image has a runtime. Sizes in results.md
- [x] k3d cluster: 1 server + 2 agents (k3s v1.37.2), local registry, Traefik ingress on :80 (`deploy/k3d/cluster.yaml`)
- [x] Helm: `sf-lib` library chart + `streamforge-deps` + `streamforge` ([ADR-005](adr/005-kubernetes.md)): probes, requests/limits, PDBs, default-deny NetworkPolicies with per-component allow-lists, ServiceAccounts (no token unless needed), read-only root filesystems, Secrets from a gitignored file
- [x] CloudNativePG (operator 1.30.1) for Postgres, Redis StatefulSet, SeaweedFS/ElasticMQ/sns-shim in-cluster, Terraform Job with `kubernetes` state backend and offline provider mirror
- [x] Migrations under a Postgres advisory lock; seed Job; `COOKIE_SECURE` setting
- [x] Acceptance: `make up-lite` -> http://streamforge.localhost; Playwright e2e passes against the cluster (2026-11-09)

**M4 complete (2026-11-09).** `make up` = `make up-lite` until observability lands in M6.

## M5 — CI/CD + GitOps + IaC
- [x] `ci.yml`: path-filtered Go/TS unit + integration (Testcontainers, compose emulators), Helm lint/render per env, Terraform fmt/validate/tflint/checkov, gitleaks, Trivy, actionlint; all actions pinned by SHA
- [x] `release.yml`: changed services only, multi-arch (amd64 + arm64) to GHCR `:<sha>`, SBOM + provenance, Trivy gate, GitOps bump of staging tags
- [x] `e2e.yml`: k3d in the runner, `make up-lite`, Playwright; `promote.yml`: manual staging -> prod
- [x] ArgoCD app-of-apps (`deploy/argocd`): CNPG operator, staging + prod (deps wave 0, app wave 1), per-env values/images files ([ADR-006](adr/006-cicd-gitops.md))
- [x] `infra/terraform/aws`: VPC, private EKS + IRSA, RDS, ElastiCache, KMS, hardened pipeline module; validate + tflint clean, checkov 420 passed / 0 failed (justified skips)
- [x] Verified locally with the CI tool versions: `make tf-aws-validate`, `make security` (gitleaks, Trivy, actionlint), Helm strict lint + env renders, arm64 images built and smoke-tested
- [x] Public repo https://github.com/LucasTyph/streamforge (history rewritten to the GitHub no-reply email; build brief removed)
- [x] First CI runs caught real bugs, all fixed: `go/internal/media` was never committed (`.gitignore` `media/`), CRITICAL openssh CVEs in the terraform image base, checkov-action module fetch, tests racing the pipeline workers, a GitOps bump race between two release runs
- [x] `ci` and `release` green on main; all 8 images multi-arch on GHCR (public)
- [x] `make gitops-up` on a fresh cluster: ArgoCD installs CNPG + staging from git; Playwright passes against http://staging.streamforge.localhost
- [x] Merge -> staging measured: commit `38cc69c` (API reports its version in `/healthz`) served by staging ~3.8 min after the push (2026-11-10)

**M5 complete (2026-11-10).** Prod waits for its first manual promotion (Actions -> promote).
Known issue: a single-replica rollout returned one `504` through Traefik (no preStop delay yet), to fix in M6.

## M6–M7
Not started: M6 autoscaling (KEDA) + observability (Prometheus, Loki, Tempo, Grafana); M7 load tests, benchmarks, chaos, final README.

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
- [ ] Playwright e2e (`make test-e2e`) written; **blocked on system libraries for headless Chromium** (`sudo env "PATH=$PATH" npx playwright install-deps chromium`)

## M4–M7
Not started. See the build brief.

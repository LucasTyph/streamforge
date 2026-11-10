# ADR-006: CI/CD and GitOps

- **Status:** Accepted
- **Date:** 2026-11-10

## Context
Every change should be tested, scanned and turned into immutable images, and the local
cluster should converge on what's in git without anyone running `helm upgrade`, all on
free GitHub Actions minutes (public repo) and GHCR.

## Decisions

**Workflows** (`.github/workflows/`), every third-party action pinned to a full commit SHA:
- `ci.yml` (PRs and `main`): path filters so only affected jobs run. Go vet/gofmt/unit
  (`-race`) and Testcontainers tests with real ffmpeg; pnpm typecheck + Vitest;
  catalog-api integration tests against the docker-compose emulators; Helm `lint --strict`
  plus rendering of each chart with every environment's values; Terraform fmt/validate
  (local + AWS), tflint and checkov; gitleaks over full history; Trivy (dependencies,
  Dockerfiles, Kubernetes misconfig, secrets); actionlint.
- `release.yml` (`main`): builds only the services whose files changed (per-service path
  filters, or `all` on manual dispatch) for linux/amd64 + linux/arm64, pushes
  `ghcr.io/<owner>/streamforge/<service>:<short sha>` with SBOM and provenance, fails on
  CRITICAL fixable CVEs (Trivy), then commits the new tags to
  `deploy/gitops/staging/images.yaml`.
- `e2e.yml` (PRs touching code or deploy): `make up-lite` on k3d inside the runner, then the
  Playwright test. It uses the same install script and Makefile as a laptop.
- `promote.yml` (manual, `production` environment): copies staging's image tags to prod.

**Tags.** One immutable git-SHA tag per service, never `latest`. Because only changed
services are rebuilt, the GitOps file holds a tag per service, not one global tag.
`scripts/gitops-bump.sh` rejects anything that isn't a hex SHA.

**Multi-arch without slow emulation.** Go cross-compiles in a native build stage
(`--platform=$BUILDPLATFORM`). Node build stages also run natively: pnpm installs native
optional dependencies (argon2) for both CPUs (`supportedArchitectures`), and the output
is architecture-independent JS. Only the small runtime stages run per architecture. This
was verified locally: the arm64 API image hashes a password with argon2 under emulation,
and the arm64 probe worker runs ffprobe 8.1.3.

**GitOps.** ArgoCD (chart 10.17.1, trimmed: no Dex, notifications or ApplicationSet)
watches `main`. One `root` Application (applied by `make gitops-up`) points at
`deploy/argocd/apps`, a small Helm chart that renders:
- wave -1: the CloudNativePG operator (its official chart, pinned);
- per environment (staging, prod), each in its own namespace: `<env>-deps` (wave 0) and
  `<env>-app` (wave 1), with value files `deploy/gitops/<env>/{values,images}.yaml`.

A custom health check for `Application` makes the waves wait for health. Helm hooks (the
Terraform and seed Jobs) become ArgoCD PostSync hooks. Staging changes on every merge;
prod changes only through `promote.yml`.

**Secrets.** No secret values in git. ArgoCD-managed releases run with
`secrets.create=false`, and `scripts/gitops-secrets.sh` creates random per-environment
Secrets out of band. In a shared or real cluster this would be Sealed Secrets or External
Secrets Operator (AWS Secrets Manager, where RDS already keeps its master password).

**Real AWS** (`infra/terraform/aws`): VPC (3 AZs, flow logs), private-endpoint EKS with
Graviton nodes and IRSA, RDS Postgres 18 (Multi-AZ, KMS, rotated master secret),
ElastiCache Valkey (TLS + auth), the same `pipeline` module hardened (SSE-KMS, public
access blocks, versioning, lifecycle, queue policies) and least-privilege IAM roles per
service. It is validated, linted and checkov-scanned in CI, and never applied. Every
checkov skip has a written reason in `.checkov.yaml`.

## Consequences
- The bot pushes to `main` with `GITHUB_TOKEN`. Pushes made with that token don't trigger
  other workflows, so there are no build loops (`[skip ci]` is a second guard). Branch
  protection on `main` would require a PR-based bump (e.g. a GitHub App token).
- GHCR packages start private. Making them public, or adding an image pull secret, is
  needed before the local cluster can pull them.
- Staging and prod on one laptop cost RAM. They run single replicas with smaller volumes;
  the manual `make up-lite` release and the GitOps environments can't all run at once
  within 10 GB.

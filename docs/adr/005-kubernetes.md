# ADR-005: Kubernetes packaging on k3d

- **Status:** Accepted
- **Date:** 2026-11-09

## Context
The stack must run on a local cluster within ~10 GB of RAM, be installable with one
command, and use production patterns an interviewer can dig into: probes, resource
limits, PDBs, NetworkPolicies, non-root containers, an operator-managed database, and
IaC applied from inside the cluster.

## Decisions

**Cluster.** k3d (k3s v1.37.2) with 1 server and 2 agents, a local registry
(`localhost:5111` from the host, `registry.localhost:5111` inside the cluster), and
the bundled Traefik ingress on host port 80 (k3d load balancer -> servicelb -> Traefik). Image tags are immutable: the git SHA, plus a
timestamp when the tree is dirty. `latest` is never used.

**Charts.** One library chart (`sf-lib`) renders a component from a short values block:
ServiceAccount, Deployment/StatefulSet, Service, PDB and NetworkPolicy, all with the same
hardened defaults. Two application charts use it:
- `streamforge-deps`: Postgres (CloudNativePG `Cluster`), Redis, SeaweedFS, ElasticMQ,
  sns-shim, the S3 ingress and the Terraform bootstrap Job.
- `streamforge`: web, catalog-api, progress-svc, the three workers, the app ingress and
  the seed Job.

They are separate releases because they change at different rates, and ArgoCD (M5)
can sync them as separate applications. The CloudNativePG operator comes from its
official chart (pinned to 0.29.1, operator 1.30.1) via `make platform`.

**Hardened defaults** (library): `runAsNonRoot` (uid 65532), `readOnlyRootFilesystem`
with explicit `emptyDir`s for `/tmp`, `/work` and the Next.js cache, all capabilities
dropped, no privilege escalation, `RuntimeDefault` seccomp, and no service-account token
unless the pod needs the Kubernetes API. Every container has requests and limits.
Exceptions: Redis runs as its image's uid 999.

**Networking.** One host, `streamforge.localhost`: `/` → web, `/api` → catalog-api (a
Traefik `stripPrefix` middleware), `/events` → progress-svc. Same origin, so the session
cookie works with no CORS. The browser-facing S3 endpoint is a second host,
`s3.streamforge.localhost`. It can't be a path prefix: SigV4 signs the request path, so
rewriting `/s3/...` would break presigned URLs. Each release starts from a
default-deny-all NetworkPolicy, and every component gets an explicit allow-list
(ingress from named components or Traefik; egress to named components plus DNS).
Postgres pods restrict ingress only: CloudNativePG's instance manager must reach the
Kubernetes API, whose address varies by distribution.

**Database.** CloudNativePG `Cluster` (1 instance locally) creates the
`streamforge-pg-app` Secret that the API and seed Job read. Migrations run in the API at
startup and in the seed Job under a Postgres advisory lock, so replicas can't race.

**Terraform in the cluster.** A post-install/upgrade Job runs the same
`infra/terraform/local` code against the in-cluster emulators. The image bakes in the
providers (the Job has no internet egress), and a generated `backend_override.tf`
switches to the `kubernetes` backend. State lives in a Secret, re-runs are incremental,
and `make tf-local` keeps its local backend.

**Graceful shutdown.** Each pod's `terminationGracePeriodSeconds` is longer than its
drain timeout: probe 40 s vs 30 s, thumbnail 30 s vs 20 s, transcode 15 s vs 5 s (long
transcodes are released, not finished; ADR-003), progress-svc 25 s vs its 15 s heartbeat.

## Consequences
- Secrets are random values in the gitignored `deploy/helm/secrets.local.yaml` (`make
  secrets`). Sealed Secrets or an external secret store would replace this in a shared
  cluster.
- Cookies are not `Secure` on the local HTTP ingress (`COOKIE_SECURE=false`); production
  would terminate TLS at the ingress and set it to true.
- Processed media is readable anonymously from the S3 host (ADR-003).

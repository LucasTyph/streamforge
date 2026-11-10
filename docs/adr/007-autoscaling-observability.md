# ADR-007: Autoscaling and observability

- **Status:** Accepted
- **Date:** 2026-11-10

## Context
Workers should cost nothing when idle and scale with the backlog, within a laptop's RAM.
Every video should be one trace across services, logs should link to traces, and a
dashboard should show queue depth against worker replicas over time.

## Decisions

**KEDA on SQS queue depth.** Each worker Deployment has a `ScaledObject` with the
`aws-sqs-queue` scaler pointed at ElasticMQ through `awsEndpoint`, counting visible plus
in-flight messages (`scaleOnInFlight`). This was the open question in ADR-002, and it
works against the emulator with no Prometheus fallback. Ranges: probe 0..2,
transcode 0..4 (1 message per replica; ~350 MiB and up to 2 CPUs each), thumbnail 0..3
(2 per replica). Scale-up adds up to 2 pods per 15 s; scale-down removes 1 pod per 30 s
after a 60 s window; `cooldownPeriod` 60 s before 1 → 0. The Helm library omits
`replicas` whenever an autoscaler owns a Deployment, so Helm and ArgoCD don't fight it.
Credentials come from a `TriggerAuthentication` over the same Secret the services use.
catalog-api has a CPU HPA (2..4).

**Tracing.** OpenTelemetry SDKs in Go and Node, exporting OTLP/HTTP to an OTel Collector
DaemonSet, then to Tempo. W3C `traceparent` travels in SNS/SQS message attributes: the
API injects it when publishing `video-uploaded`, every worker extracts it per message
(consumer span) and injects it into what it publishes, and catalog-api continues it when
applying job-status events. Step spans cover ffprobe, download, ffmpeg, uploads and
publishes. The video's trace id is stored on the video row, and the UI links to it in
Grafana. Request spans come from `@fastify/otel` (Fastify hooks, no ESM loader). Probe and
scrape paths are ignored.

**Logs.** Services log JSON with `trace_id`/`span_id`: a `slog` handler in Go, a pino child
logger per request in Node. The Collector tails only `streamforge*` pod logs (filelog +
k8sattributes) into Loki over OTLP. Grafana's Loki datasource turns `trace_id` into a link
to Tempo, and Tempo's spans link back to Loki.

**Metrics.** Prometheus (kube-prometheus-stack, trimmed) scrapes one `PodMonitor`:
worker job counters, duration histograms and in-flight gauges; catalog-api's RED
histogram, status-event counter, video counts and queue/DLQ depth (refreshed per scrape,
bounded to 3 s); progress-svc SSE clients; plus kube-state-metrics and cAdvisor.
NetworkPolicies allow scrapes from `monitoring` on the metrics port and OTLP egress to it.

**Dashboards and alerts as code.** `observability/dashboards.py` generates the two
dashboards (Pipeline, Services RED), and a small chart ships them with a `PrometheusRule`:
DLQ not empty, p95 transcode > 2 min, crash-looping pods, API 5xx ratio > 5%. Each alert
links a runbook.

**Same values for `make up` and GitOps.** `make observability` and the ArgoCD app-of-apps
(multi-source Applications) install the same pinned charts with the same files in
`observability/values/`.

## Measured trade-offs (docs/results.md)
- Go services in containers need `GOMEMLIMIT` below their limit. SeaweedFS idled at
  497 MiB and was OOM-killed at 1 GiB by a 20-upload burst; with `GOMEMLIMIT=850MiB` it
  idles at 119 MiB and peaked at 896 MiB (limit now 1280 MiB). Grafana 13 needs ~400 MiB:
  its 256 MiB limit OOM-killed it, and a 400 MiB `GOMEMLIMIT` made it thrash. It now gets
  768 MiB and 640 MiB.
- The bundled kube-prometheus-stack dashboards are off (Grafana memory); only StreamForge's
  ship.
- The full stack plus a 20-video burst pushed the WSL VM to ~8.8 GB of its 10 GB, Windows
  dropped to ~0.6 GB free, and WSL briefly stopped responding. The run still completed.
  This is the budget's edge: prod is paused in GitOps, and `make up-lite` exists for
  machines with less RAM.

## Consequences
- The browser does not start the trace; it starts at catalog-api's upload-complete request.
  Browser tracing would need the OTel web SDK and a public OTLP endpoint.
- Queue-depth gauges come from catalog-api, so they disappear if every API pod is down.
  KEDA reads ElasticMQ directly and doesn't depend on them.

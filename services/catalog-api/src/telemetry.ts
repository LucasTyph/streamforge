// Tracing (OpenTelemetry) and metrics (Prometheus) for catalog-api.
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { type Context, context, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";

const SERVICE = "catalog-api";

/** Request spans via Fastify hooks (no ESM loader hooks needed). */
export const fastifyOtel = new FastifyOtelInstrumentation({
  registerOnInitialization: false,
  ignorePaths: (r) => ["/healthz", "/readyz", "/metrics"].includes(r.url), // probes and scrapes would drown the traces
  // Name the request span "METHOD /route" (default: "request"). Setting instrumentHooks or
  // instrumentHandler to false stopped request spans entirely here, so defaults stay.
  requestHook: (span, req) => span.updateName(`${req.method} ${req.routeOptions.url ?? req.url}`),
});

/**
 * Starts the OTel SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set (standard OTEL_* env vars
 * configure the exporter). Without it, spans still exist in-process for log correlation.
 */
export function startTracing(): () => Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => {};
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE, [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? "dev" }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [fastifyOtel],
  });
  sdk.start();
  return () => sdk.shutdown();
}

export const tracer = trace.getTracer("streamforge/catalog-api");

/** W3C trace context of `ctx` as a string map (SNS/SQS message attributes). */
export function injectContext(ctx: Context | null = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx ?? context.active(), carrier);
  return carrier;
}

export function extractContext(attrs: Record<string, string>): Context {
  return propagation.extract(context.active(), attrs);
}

export function traceIds(ctx: Context | null = context.active()) {
  const sc = trace.getSpan(ctx ?? context.active())?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}

// ---- metrics ----------------------------------------------------------------
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency by route and status (RED: rate, errors, duration).",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const statusEvents = new Counter({
  name: "streamforge_job_status_events_total",
  help: "Job-status events consumed from catalog-status-q, by task, state and outcome.",
  labelNames: ["task", "state", "outcome"] as const,
  registers: [registry],
});

/** Queue/DLQ depth and video counts, refreshed on each scrape (see metrics wiring in app.ts). */
export const queueMessages = new Gauge({
  name: "streamforge_queue_messages",
  help: "Approximate messages per pipeline queue (dlq=true for dead-letter queues).",
  labelNames: ["queue", "dlq", "state"] as const,
  registers: [registry],
});

export const videosByStatus = new Gauge({
  name: "streamforge_videos",
  help: "Videos by status.",
  labelNames: ["status"] as const,
  registers: [registry],
});

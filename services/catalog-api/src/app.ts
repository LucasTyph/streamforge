import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Events, Storage } from "./aws.js";
import { sql as dsql } from "drizzle-orm";
import { adminRoutes } from "./admin.js";
import { videos } from "./db/schema.js";
import { createQueueReader } from "./queues.js";
import { fastifyOtel, httpDuration, queueMessages, registry, traceIds, videosByStatus } from "./telemetry.js";
import { SESSION_COOKIE, authRoutes } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { UploadError } from "./uploads.js";
import { videoRoutes } from "./videos.js";

export interface AppDeps {
  cfg: Config;
  db: Db;
  storage: Storage;
  events: Events;
}

export async function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}) {
  const { cfg, db } = deps;
  const app = Fastify({
    logger: { level: cfg.NODE_ENV === "test" ? "silent" : "info" },
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    bodyLimit: 1024 * 1024,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  // Tracing first: one span per request; every request log line carries its trace id.
  await app.register(fastifyOtel.plugin());
  app.addHook("onRequest", async (req) => {
    const ids = traceIds(req.opentelemetry().context);
    if (ids.trace_id) req.log = req.log.child(ids);
  });
  app.addHook("onResponse", async (req, reply) => {
    httpDuration
      .labels({ method: req.method, route: req.routeOptions.url ?? "unmatched", status_code: String(reply.statusCode) })
      .observe(reply.elapsedTime / 1000);
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: "Invalid request",
        details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof UploadError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "Internal server error" });
  });

  await app.register(cors, { origin: cfg.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: cfg.JWT_SECRET, cookie: { cookieName: SESSION_COOKIE, signed: false } });
  await app.register(swagger, {
    openapi: { info: { title: "StreamForge catalog-api", version: "0.1.0" } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // version = git SHA baked in by the release workflow ("dev" for local builds)
  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true, version: process.env.APP_VERSION ?? "dev" }));
  app.get("/readyz", { schema: { hide: true } }, async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      await deps.storage.ready();
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });

  const secureCookies = cfg.COOKIE_SECURE ? cfg.COOKIE_SECURE === "true" : cfg.NODE_ENV === "production";
  await app.register(authRoutes(db, secureCookies, cfg.ADMIN_EMAILS));
  const queues = createQueueReader(cfg.AWS_REGION, cfg.QUEUE_PREFIX);
  await app.register(adminRoutes({ db, queues, adminEmails: cfg.ADMIN_EMAILS }));

  // Prometheus scrape: refresh queue depths and video counts (bounded), then render.
  app.get("/metrics", { schema: { hide: true } }, async (req, reply) => {
    const refresh = (async () => {
      for (const q of await queues.all()) {
        for (const [dlq, d] of [["false", q.main], ["true", q.dlq]] as const) {
          queueMessages.labels({ queue: q.name, dlq, state: "visible" }).set(d.visible);
          queueMessages.labels({ queue: q.name, dlq, state: "in_flight" }).set(d.inFlight);
          queueMessages.labels({ queue: q.name, dlq, state: "delayed" }).set(d.delayed);
        }
      }
      const rows = await db.select({ status: videos.status, n: dsql<number>`count(*)::int` }).from(videos).groupBy(videos.status);
      videosByStatus.reset();
      for (const r of rows) videosByStatus.labels({ status: r.status }).set(r.n);
    })();
    await Promise.race([refresh, new Promise((r) => setTimeout(r, 3000))]).catch((err) => req.log.warn({ err }, "metrics refresh failed"));
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
  await app.register(videoRoutes({ db, storage: deps.storage, events: deps.events, cfg }));
  return app;
}

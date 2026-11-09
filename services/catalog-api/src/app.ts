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
import { adminRoutes } from "./admin.js";
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

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
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
  await app.register(adminRoutes({ db, region: cfg.AWS_REGION, queuePrefix: cfg.QUEUE_PREFIX, adminEmails: cfg.ADMIN_EMAILS }));
  await app.register(videoRoutes({ db, storage: deps.storage, events: deps.events, cfg }));
  return app;
}

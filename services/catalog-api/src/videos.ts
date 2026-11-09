import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Events, Storage } from "./aws.js";
import { requireUser } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { type Video, videos } from "./db/schema.js";
import {
  UploadError,
  assertPartNumbers,
  assertVideoContentType,
  normalizeCompletedParts,
  planUpload,
  rawKeyFor,
} from "./uploads.js";

const PRESIGN_TTL_S = 15 * 60;

const videoOut = z.object({
  id: z.string(),
  title: z.string(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  status: z.enum(["UPLOADING", "UPLOADED", "PROCESSING", "READY", "FAILED"]),
  failureReason: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const toOut = (v: Video): z.infer<typeof videoOut> => ({
  id: v.id,
  title: v.title,
  filename: v.filename,
  contentType: v.contentType,
  sizeBytes: v.sizeBytes,
  status: v.status,
  failureReason: v.failureReason,
  durationSeconds: v.durationSeconds,
  width: v.width,
  height: v.height,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

const idParams = z.object({ id: z.string().uuid() });

export interface VideoDeps {
  db: Db;
  storage: Storage;
  events: Events;
  cfg: Pick<Config, "MAX_UPLOAD_BYTES" | "UPLOAD_PART_BYTES" | "RAW_BUCKET">;
}

export const videoRoutes =
  ({ db, storage, events, cfg }: VideoDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook("preHandler", requireUser);

    const load = async (id: string, ownerId: string) => {
      const v = await db.query.videos.findFirst({ where: and(eq(videos.id, id), eq(videos.ownerId, ownerId)) });
      if (!v) throw new UploadError("Video not found", 404);
      return v;
    };
    const uploading = (v: Video) => {
      if (v.status !== "UPLOADING" || !v.uploadId) throw new UploadError(`Upload is not in progress (status ${v.status})`, 409);
      return v.uploadId;
    };

    app.post(
      "/videos",
      {
        schema: {
          tags: ["videos"],
          summary: "Create a video and start a multipart upload",
          body: z.object({
            filename: z.string().min(1).max(255),
            contentType: z.string().max(100),
            sizeBytes: z.number().int().positive(),
            title: z.string().min(1).max(200).optional(),
          }),
          response: {
            201: z.object({
              video: videoOut,
              upload: z.object({ uploadId: z.string(), partSize: z.number(), partCount: z.number() }),
            }),
          },
        },
      },
      async (req, reply) => {
        const { filename, contentType, sizeBytes } = req.body;
        assertVideoContentType(contentType);
        const plan = planUpload(sizeBytes, cfg.UPLOAD_PART_BYTES, cfg.MAX_UPLOAD_BYTES);
        const id = crypto.randomUUID();
        const rawKey = rawKeyFor(id);
        const uploadId = await storage.createMultipart(rawKey, contentType);
        const [v] = await db
          .insert(videos)
          .values({
            id,
            ownerId: req.user.sub,
            title: req.body.title ?? filename.replace(/\.[^.]+$/, ""),
            filename,
            contentType,
            sizeBytes,
            rawKey,
            uploadId,
          })
          .returning();
        req.log.info({ videoId: id, sizeBytes, parts: plan.partCount }, "upload started");
        return reply.code(201).send({ video: toOut(v!), upload: { uploadId, ...plan } });
      },
    );

    app.post(
      "/videos/:id/upload/parts",
      {
        schema: {
          tags: ["videos"],
          summary: "Presign upload URLs for the given part numbers",
          params: idParams,
          body: z.object({ partNumbers: z.array(z.number().int()).min(1).max(100) }),
          response: { 200: z.object({ urls: z.array(z.object({ partNumber: z.number(), url: z.string() })) }) },
        },
      },
      async (req) => {
        const v = await load(req.params.id, req.user.sub);
        const uploadId = uploading(v);
        const { partCount } = planUpload(v.sizeBytes, cfg.UPLOAD_PART_BYTES, cfg.MAX_UPLOAD_BYTES);
        assertPartNumbers(req.body.partNumbers, partCount);
        const urls = await Promise.all(
          req.body.partNumbers.map(async (partNumber) => ({
            partNumber,
            url: await storage.presignPart(v.rawKey, uploadId, partNumber, PRESIGN_TTL_S),
          })),
        );
        return { urls };
      },
    );

    app.post(
      "/videos/:id/upload/complete",
      {
        schema: {
          tags: ["videos"],
          summary: "Complete the multipart upload; publishes video-uploaded",
          params: idParams,
          body: z.object({
            parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).min(1).max(10_000),
          }),
          response: { 200: videoOut },
        },
      },
      async (req) => {
        const v = await load(req.params.id, req.user.sub);
        if (v.status !== "UPLOADING") return toOut(v); // idempotent retry
        const uploadId = uploading(v);
        const { partCount } = planUpload(v.sizeBytes, cfg.UPLOAD_PART_BYTES, cfg.MAX_UPLOAD_BYTES);
        const parts = normalizeCompletedParts(req.body.parts, partCount);

        try {
          await storage.completeMultipart(v.rawKey, uploadId, parts);
        } catch (err) {
          // A concurrent/retried complete may already have assembled the object.
          if ((await storage.objectSize(v.rawKey)) === undefined) throw err;
        }
        const size = await storage.objectSize(v.rawKey);
        if (size !== v.sizeBytes) {
          throw new UploadError(`Uploaded size ${size ?? 0} does not match declared size ${v.sizeBytes}`, 422);
        }

        // Publish before flipping the status: a crash in between leads to a retry and a
        // duplicate event (consumers are idempotent), never to a lost one.
        await events.videoUploaded({
          videoId: v.id,
          bucket: cfg.RAW_BUCKET,
          key: v.rawKey,
          sizeBytes: v.sizeBytes,
          contentType: v.contentType,
        });
        const [updated] = await db
          .update(videos)
          .set({ status: "UPLOADED", uploadId: null, updatedAt: new Date() })
          .where(and(eq(videos.id, v.id), eq(videos.status, "UPLOADING")))
          .returning();
        req.log.info({ videoId: v.id }, "upload completed");
        return toOut(updated ?? (await load(v.id, req.user.sub)));
      },
    );

    app.post(
      "/videos/:id/upload/abort",
      { schema: { tags: ["videos"], summary: "Abort an in-progress upload", params: idParams, response: { 200: videoOut } } },
      async (req) => {
        const v = await load(req.params.id, req.user.sub);
        await storage.abortMultipart(v.rawKey, uploading(v));
        const [updated] = await db
          .update(videos)
          .set({ status: "FAILED", failureReason: "Upload was cancelled", uploadId: null, updatedAt: new Date() })
          .where(eq(videos.id, v.id))
          .returning();
        return toOut(updated!);
      },
    );

    app.get(
      "/videos",
      { schema: { tags: ["videos"], summary: "List my videos", response: { 200: z.object({ items: z.array(videoOut) }) } } },
      async (req) => {
        const rows = await db.query.videos.findMany({
          where: eq(videos.ownerId, req.user.sub),
          orderBy: desc(videos.createdAt),
          limit: 100,
        });
        return { items: rows.map(toOut) };
      },
    );

    app.get(
      "/videos/:id",
      { schema: { tags: ["videos"], params: idParams, response: { 200: videoOut } } },
      async (req) => toOut(await load(req.params.id, req.user.sub)),
    );
  };

import { bigint, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const videoStatus = pgEnum("video_status", ["UPLOADING", "UPLOADED", "PROCESSING", "READY", "FAILED"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videos = pgTable(
  "videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: videoStatus("status").notNull().default("UPLOADING"),
    failureReason: text("failure_reason"),
    rawKey: text("raw_key").notNull(),
    uploadId: text("upload_id"),
    durationSeconds: real("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    hlsMasterKey: text("hls_master_key"),
    posterKey: text("poster_key"),
    thumbnailsVttKey: text("thumbnails_vtt_key"),
    /** Trace that carried this video through the pipeline (Tempo/Grafana link). */
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("videos_owner_created_idx").on(t.ownerId, t.createdAt)],
);

export const jobState = pgEnum("job_state", ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);

/** One row per (video, pipeline task). Updated only from job-status events. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    state: jobState("state").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("jobs_video_task_uq").on(t.videoId, t.task)],
);

export type User = typeof users.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Video = typeof videos.$inferSelect;

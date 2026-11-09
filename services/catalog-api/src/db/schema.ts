import { bigint, index, integer, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("videos_owner_created_idx").on(t.ownerId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Video = typeof videos.$inferSelect;

// applyJobStatus against the dev Postgres: ordering, duplicates, aggregation, failure.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "./db/index.js";
import { jobs, users, videos } from "./db/schema.js";
import { applyJobStatus, type JobStatusEvent } from "./jobs.js";

const run = process.env.INTEGRATION === "1";
const REQUIRED = ["probe", "transcode"];

describe.runIf(run)("applyJobStatus (Postgres)", () => {
  if (!run) return;
  const { db, sql } = createDb(process.env.DATABASE_URL!);
  let ownerId = "";
  const t0 = Date.parse("2026-11-09T12:00:00Z");
  const ev = (videoId: string, task: JobStatusEvent["task"], state: JobStatusEvent["state"], sec: number, extra = {}) =>
    ({ type: "job.status", videoId, task, state, attempt: 1, at: new Date(t0 + sec * 1000).toISOString(), ...extra }) as JobStatusEvent;
  const newVideo = async () => {
    const [v] = await db
      .insert(videos)
      .values({ ownerId, title: "t", filename: "t.mp4", contentType: "video/mp4", sizeBytes: 1, rawKey: "k", status: "UPLOADED" })
      .returning();
    return v!.id;
  };
  const video = async (id: string) => (await db.select().from(videos).where(eq(videos.id, id)))[0]!;

  beforeAll(async () => {
    await runMigrations(db);
    const [u] = await db.insert(users).values({ email: `jobs-${Date.now()}@example.test`, passwordHash: "x" }).returning();
    ownerId = u!.id;
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.id, ownerId));
    await sql.end();
  });

  it("walks a video to READY and records metadata + playback key", async () => {
    const id = await newVideo();
    await applyJobStatus(db, ev(id, "probe", "RUNNING", 1), REQUIRED);
    expect((await video(id)).status).toBe("PROCESSING");
    await applyJobStatus(db, ev(id, "probe", "SUCCEEDED", 2, { result: { durationSeconds: 30, width: 1280, height: 720 } }), REQUIRED);
    await applyJobStatus(db, ev(id, "transcode", "RUNNING", 3), REQUIRED);
    await applyJobStatus(db, ev(id, "transcode", "SUCCEEDED", 9, { result: { master: `${id}/hls/master.m3u8` } }), REQUIRED);
    const v = await video(id);
    expect(v).toMatchObject({ status: "READY", durationSeconds: 30, width: 1280, height: 720, hlsMasterKey: `${id}/hls/master.m3u8` });
  });

  it("ignores stale and duplicate events (at-least-once, unordered delivery)", async () => {
    const id = await newVideo();
    await applyJobStatus(db, ev(id, "probe", "SUCCEEDED", 5), REQUIRED);
    expect(await applyJobStatus(db, ev(id, "probe", "RUNNING", 4), REQUIRED)).toMatchObject({ outcome: "ignored-stale" });
    expect(await applyJobStatus(db, ev(id, "probe", "SUCCEEDED", 5), REQUIRED)).toMatchObject({ outcome: "ignored-terminal" });
    expect(await applyJobStatus(db, ev(id, "probe", "FAILED", 6), REQUIRED)).toMatchObject({ outcome: "ignored-terminal" });
    const rows = await db.select().from(jobs).where(eq(jobs.videoId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("SUCCEEDED");
  });

  it("marks the video FAILED with the worker's reason, and a redrive can recover it", async () => {
    const id = await newVideo();
    await applyJobStatus(db, ev(id, "probe", "FAILED", 1, { error: "The file is not a readable video", attempt: 3 }), REQUIRED);
    expect(await video(id)).toMatchObject({ status: "FAILED", failureReason: "The file is not a readable video" });
    await applyJobStatus(db, ev(id, "probe", "RUNNING", 60), REQUIRED);
    expect(await video(id)).toMatchObject({ status: "PROCESSING", failureReason: null });
  });

  it("serializes concurrent events for one video", async () => {
    const id = await newVideo();
    await applyJobStatus(db, ev(id, "probe", "SUCCEEDED", 1), REQUIRED);
    await Promise.all([
      applyJobStatus(db, ev(id, "transcode", "RUNNING", 2), REQUIRED),
      applyJobStatus(db, ev(id, "transcode", "SUCCEEDED", 3, { result: { master: "m" } }), REQUIRED),
    ]);
    // whichever order the transactions ran in, the newer SUCCEEDED wins
    expect((await video(id)).status).toBe("READY");
  });

  it("reports unknown videos", async () => {
    expect(await applyJobStatus(db, ev("00000000-0000-4000-8000-000000000000", "probe", "RUNNING", 1), REQUIRED)).toMatchObject({ outcome: "unknown-video" });
  });
});

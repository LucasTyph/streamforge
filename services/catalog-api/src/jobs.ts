// Job state machine: PENDING -> RUNNING -> SUCCEEDED | FAILED, driven by job-status
// events from the workers. Pure functions first (unit tested), then the DB apply step.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/index.js";
import { jobs, videos, type Video } from "./db/schema.js";

export type JobState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type VideoStatus = Video["status"];

export const jobStatusEvent = z.object({
  type: z.literal("job.status"),
  videoId: z.string().uuid(),
  task: z.enum(["probe", "transcode", "thumbnail"]),
  state: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]),
  attempt: z.number().int().nonnegative(),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  at: z.string().datetime({ offset: true }),
});
export type JobStatusEvent = z.infer<typeof jobStatusEvent>;

/**
 * Next state for a job given an incoming event, or null to ignore the event.
 * SUCCEEDED is terminal: redelivered/late events can't undo it. FAILED -> RUNNING is
 * allowed, because a DLQ redrive retries the job.
 */
export function nextJobState(current: JobState | undefined, incoming: JobStatusEvent["state"]): JobState | null {
  if (current === "SUCCEEDED") return null;
  return incoming;
}

/** Derives the video's status from its jobs. */
export function deriveVideoStatus(
  current: VideoStatus,
  jobStates: { task: string; state: JobState }[],
  requiredTasks: readonly string[],
): VideoStatus {
  if (current === "UPLOADING") return current; // pipeline can't run before the upload completes
  if (jobStates.some((j) => j.state === "FAILED")) return "FAILED";
  const done = new Set(jobStates.filter((j) => j.state === "SUCCEEDED").map((j) => j.task));
  if (requiredTasks.every((t) => done.has(t))) return "READY";
  if (jobStates.some((j) => j.state === "RUNNING" || j.state === "SUCCEEDED")) return "PROCESSING";
  return current;
}

export type ApplyOutcome = "applied" | "ignored-stale" | "ignored-terminal" | "unknown-video";

/**
 * Applies one event atomically. The video row is locked so concurrent events for the same
 * video (probe and transcode finishing together) serialize. Events older than the job's
 * last applied event are ignored (SQS doesn't guarantee order).
 */
export async function applyJobStatus(db: Db, e: JobStatusEvent, requiredTasks: readonly string[]): Promise<ApplyOutcome> {
  const at = new Date(e.at);
  return db.transaction(async (tx) => {
    const [video] = await tx.select().from(videos).where(eq(videos.id, e.videoId)).for("update");
    if (!video) return "unknown-video";

    const existing = await tx.query.jobs.findFirst({ where: and(eq(jobs.videoId, e.videoId), eq(jobs.task, e.task)) });
    if (existing?.lastEventAt && at < existing.lastEventAt) return "ignored-stale";
    const next = nextJobState(existing?.state, e.state);
    if (!next) return "ignored-terminal";

    const fields = {
      state: next,
      attempts: Math.max(existing?.attempts ?? 0, e.attempt),
      error: next === "FAILED" ? (e.error ?? "Unknown error") : null,
      result: e.result ?? existing?.result ?? null,
      lastEventAt: at,
      updatedAt: new Date(),
    };
    await tx
      .insert(jobs)
      .values({ videoId: e.videoId, task: e.task, ...fields })
      .onConflictDoUpdate({ target: [jobs.videoId, jobs.task], set: fields });

    const all = await tx
      .select({ task: jobs.task, state: jobs.state, error: jobs.error })
      .from(jobs)
      .where(eq(jobs.videoId, e.videoId));
    const status = deriveVideoStatus(video.status, all, requiredTasks);
    const patch: Partial<Video> = {
      status,
      updatedAt: new Date(),
      failureReason: status === "FAILED" ? (all.find((j) => j.state === "FAILED")?.error ?? "Processing failed") : null,
    };
    if (e.task === "probe" && next === "SUCCEEDED" && e.result) {
      const r = e.result as { durationSeconds?: number; width?: number; height?: number };
      Object.assign(patch, { durationSeconds: r.durationSeconds, width: r.width, height: r.height });
    }
    if (e.task === "transcode" && next === "SUCCEEDED" && typeof e.result?.master === "string") {
      patch.hlsMasterKey = e.result.master;
    }
    await tx.update(videos).set(patch).where(eq(videos.id, e.videoId));
    return "applied";
  });
}

// Marks jobs FAILED when their message shows up in a dead-letter queue.
//
// Workers report a final failure themselves, but a worker that is killed (OOM, node loss,
// chaos test) on a message's last allowed receive can't. SQS then moves the message to the
// DLQ and, without this watcher, the video would sit in PROCESSING forever. Found by
// `make chaos` (docs/results.md). After an operator redrives the queue, the worker's
// RUNNING event moves the job (and the video) forward again.
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db/index.js";
import { jobs } from "./db/schema.js";
import { applyJobStatus } from "./jobs.js";
import type { Notifier } from "./notify.js";
import type { QueueReader } from "./queues.js";

export const DEAD_LETTER_REASON = "Processing stopped after 3 delivery attempts; an operator can retry it from the Ops page";
const TASKS = ["probe", "transcode", "thumbnail"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DlqWatcherOptions {
  db: Db;
  queues: QueueReader;
  requiredTasks: readonly string[];
  notifier: Notifier;
  log: FastifyBaseLogger;
  intervalMs?: number;
}

/** One pass over the pipeline DLQs. Returns how many jobs were marked FAILED. */
export async function sweepDeadLetters(o: Omit<DlqWatcherOptions, "intervalMs">): Promise<number> {
  let marked = 0;
  for (const task of TASKS) {
    const QueueUrl = await o.queues.url(`${task}-dlq`);
    // Peek with visibility 0 so the messages are never hidden from the Ops page or a
    // redrive (a 5 s visibility here made a redrive move 0 messages). Stop when a batch
    // brings nothing new.
    const seen = new Set<string>();
    for (let batch = 0; batch < 5; batch++) {
      const out = await o.queues.sqs.send(
        new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 0, WaitTimeSeconds: 0 }),
      );
      const messages = (out.Messages ?? []).filter((m) => m.MessageId && !seen.has(m.MessageId));
      if (!messages.length) break;
      for (const m of messages) seen.add(m.MessageId!);
      for (const m of messages) {
        let videoId: unknown;
        try {
          videoId = JSON.parse(m.Body ?? "{}").videoId;
        } catch {
          continue; // not ours to interpret; it stays visible on the Ops page
        }
        if (typeof videoId !== "string" || !UUID.test(videoId)) continue;
        const job = await o.db.query.jobs.findFirst({ where: and(eq(jobs.videoId, videoId), eq(jobs.task, task)) });
        if (job?.state === "FAILED" || job?.state === "SUCCEEDED") continue; // already reported / finished elsewhere
        const res = await applyJobStatus(
          o.db,
          { type: "job.status", videoId, task, state: "FAILED", attempt: Math.max(job?.attempts ?? 0, 3), error: DEAD_LETTER_REASON, at: new Date().toISOString() },
          o.requiredTasks,
        );
        if (res.outcome === "applied") {
          marked++;
          o.log.warn({ videoId, task }, "job dead-lettered without a failure report; marked FAILED");
          await o.notifier.videoChanged(res.ownerId, videoId, res.status);
        }
      }
    }
  }
  return marked;
}

export function startDlqWatcher(o: DlqWatcherOptions) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepDeadLetters(o);
    } catch (err) {
      o.log.warn({ err }, "dead-letter sweep failed");
    } finally {
      running = false;
    }
  }, o.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

// Long-polls the catalog-status queue and applies job-status events to the database.
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db/index.js";
import { SpanKind, context } from "@opentelemetry/api";
import { applyJobStatus, jobStatusEvent } from "./jobs.js";
import { extractContext, statusEvents, traceIds, tracer } from "./telemetry.js";
import type { Notifier } from "./notify.js";

export interface StatusConsumerOptions {
  db: Db;
  queueUrl: string;
  region: string;
  requiredTasks: readonly string[];
  log: FastifyBaseLogger;
  notifier: Notifier;
}

export function startStatusConsumer(o: StatusConsumerOptions) {
  const sqs = new SQSClient({ region: o.region, requestHandler: { requestTimeout: 30_000, connectionTimeout: 3_000 } });
  const stop = new AbortController();

  const handle = async (body: string, attrs: Record<string, string>) => {
    const parsed = jobStatusEvent.safeParse(JSON.parse(body));
    if (!parsed.success) throw new Error(`invalid job-status event: ${parsed.error.message}`);
    const e = parsed.data;
    // Continue the video's trace (the worker that published the status started it).
    await tracer.startActiveSpan("catalog-status process", { kind: SpanKind.CONSUMER }, extractContext(attrs), async (span) => {
      try {
        span.setAttributes({ "streamforge.task": e.task, "streamforge.state": e.state, "streamforge.video_id": e.videoId });
        const res = await applyJobStatus(o.db, e, o.requiredTasks);
        statusEvents.labels({ task: e.task, state: e.state, outcome: res.outcome }).inc();
        o.log.info({ videoId: e.videoId, task: e.task, state: e.state, outcome: res.outcome, ...traceIds(context.active()) }, "job status");
        if (res.outcome === "applied") await o.notifier.videoChanged(res.ownerId, e.videoId, res.status);
      } finally {
        span.end();
      }
    });
  };

  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        const out = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: o.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, MessageAttributeNames: ["All"] }),
          { abortSignal: stop.signal },
        );
        for (const m of out.Messages ?? []) {
          try {
            const attrs = Object.fromEntries(
              Object.entries(m.MessageAttributes ?? {}).flatMap(([k, v]) => (v.StringValue ? [[k, v.StringValue]] : [])),
            );
            await handle(m.Body ?? "", attrs);
            await sqs.send(new DeleteMessageCommand({ QueueUrl: o.queueUrl, ReceiptHandle: m.ReceiptHandle }));
          } catch (err) {
            // Not deleted: retried after the visibility timeout, then moved to the DLQ.
            o.log.error({ err, messageId: m.MessageId }, "failed to apply job status");
          }
        }
      } catch (err) {
        if (stop.signal.aborted) break;
        o.log.warn({ err }, "status queue receive failed");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  return async () => {
    stop.abort();
    await loop;
  };
}

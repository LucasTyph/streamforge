// Long-polls the catalog-status queue and applies job-status events to the database.
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db/index.js";
import { applyJobStatus, jobStatusEvent } from "./jobs.js";
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

  const handle = async (body: string) => {
    const parsed = jobStatusEvent.safeParse(JSON.parse(body));
    if (!parsed.success) throw new Error(`invalid job-status event: ${parsed.error.message}`);
    const res = await applyJobStatus(o.db, parsed.data, o.requiredTasks);
    o.log.info({ videoId: parsed.data.videoId, task: parsed.data.task, state: parsed.data.state, outcome: res.outcome }, "job status");
    if (res.outcome === "applied") await o.notifier.videoChanged(res.ownerId, parsed.data.videoId, res.status);
  };

  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        const out = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: o.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }),
          { abortSignal: stop.signal },
        );
        for (const m of out.Messages ?? []) {
          try {
            await handle(m.Body ?? "");
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

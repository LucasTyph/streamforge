// Ops endpoints: queue depths, DLQ inspection and redrive, recent failed jobs.
import { DeleteMessageBatchCommand, type Message, ReceiveMessageCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { desc, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "./auth.js";
import type { Db } from "./db/index.js";
import { jobs, videos } from "./db/schema.js";
import { PIPELINE_QUEUES, type QueueName, type QueueReader } from "./queues.js";

export interface AdminDeps {
  db: Db;
  queues: QueueReader;
  adminEmails: readonly string[];
}

export const isAdmin = (email: string, adminEmails: readonly string[]) => adminEmails.includes(email.toLowerCase());

const depth = z.object({ visible: z.number(), inFlight: z.number(), delayed: z.number() });
const queueParams = z.object({ queue: z.enum(PIPELINE_QUEUES) });

export const adminRoutes =
  ({ db, queues, adminEmails }: AdminDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { sqs, url } = queues;
    const summarize = (m: Message) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(m.Body ?? "{}");
      } catch {
        /* not JSON: shown raw */
      }
      return {
        messageId: m.MessageId ?? "",
        videoId: typeof body.videoId === "string" ? body.videoId : null,
        type: typeof body.type === "string" ? body.type : null,
        receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0),
        sentAt: m.Attributes?.SentTimestamp ? new Date(Number(m.Attributes.SentTimestamp)).toISOString() : null,
        body: (m.Body ?? "").slice(0, 2000),
      };
    };

    app.addHook("preHandler", requireUser);
    app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isAdmin(req.user.email, adminEmails)) return reply.code(403).send({ error: "Admins only" });
    });

    app.get(
      "/admin/queues",
      {
        schema: {
          tags: ["admin"],
          summary: "Queue and DLQ depths",
          response: { 200: z.object({ queues: z.array(z.object({ name: z.string(), main: depth, dlq: depth })) }) },
        },
      },
      async () => ({ queues: await queues.all() }),
    );

    app.get(
      "/admin/dlq/:queue",
      {
        schema: {
          tags: ["admin"],
          summary: "Peek at up to 10 dead-lettered messages (they stay in the DLQ)",
          params: queueParams,
          response: {
            200: z.object({
              messages: z.array(
                z.object({
                  messageId: z.string(),
                  videoId: z.string().nullable(),
                  type: z.string().nullable(),
                  receiveCount: z.number(),
                  sentAt: z.string().nullable(),
                  body: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async (req) => {
        const out = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: await url(`${req.params.queue}-dlq`),
            MaxNumberOfMessages: 10,
            VisibilityTimeout: 0, // peek: immediately visible again
            WaitTimeSeconds: 0,
            MessageSystemAttributeNames: ["All"],
          }),
        );
        return { messages: (out.Messages ?? []).map(summarize) };
      },
    );

    app.post(
      "/admin/dlq/:queue/redrive",
      {
        schema: {
          tags: ["admin"],
          summary: "Move every message in the DLQ back to its source queue",
          params: queueParams,
          response: { 200: z.object({ moved: z.number() }) },
        },
      },
      async (req) => {
        const name: QueueName = req.params.queue;
        const [dlq, source] = await Promise.all([url(`${name}-dlq`), url(name)]);
        let moved = 0;
        // Bounded loop; at-least-once: a crash between send and delete duplicates a message,
        // which the idempotent pipeline absorbs (ADR-003).
        for (let round = 0; round < 50; round++) {
          const out = await sqs.send(
            new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, VisibilityTimeout: 60, MessageAttributeNames: ["All"] }),
          );
          const msgs = out.Messages ?? [];
          if (!msgs.length) break;
          const sent = await sqs.send(
            new SendMessageBatchCommand({
              QueueUrl: source,
              Entries: msgs.map((m, i) => ({ Id: String(i), MessageBody: m.Body!, MessageAttributes: m.MessageAttributes })),
            }),
          );
          const ok = new Set((sent.Successful ?? []).map((s) => Number(s.Id)));
          const toDelete = msgs.filter((_, i) => ok.has(i));
          if (toDelete.length) {
            await sqs.send(
              new DeleteMessageBatchCommand({
                QueueUrl: dlq,
                Entries: toDelete.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
              }),
            );
          }
          moved += toDelete.length;
        }
        req.log.info({ queue: name, moved }, "dlq redriven");
        return { moved };
      },
    );

    app.get(
      "/admin/jobs/failed",
      {
        schema: {
          tags: ["admin"],
          summary: "Most recent failed jobs",
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  videoId: z.string(),
                  title: z.string(),
                  task: z.string(),
                  attempts: z.number(),
                  error: z.string().nullable(),
                  updatedAt: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async () => {
        const rows = await db
          .select({ videoId: jobs.videoId, title: videos.title, task: jobs.task, attempts: jobs.attempts, error: jobs.error, updatedAt: jobs.updatedAt })
          .from(jobs)
          .innerJoin(videos, eq(videos.id, jobs.videoId))
          .where(eq(jobs.state, "FAILED"))
          .orderBy(desc(jobs.updatedAt))
          .limit(20);
        return { items: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
      },
    );
  };

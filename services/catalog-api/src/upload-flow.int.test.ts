// End-to-end presigned multipart upload against the local stack (make dev-infra + tf-local).
// Run: pnpm test:integration   (UPLOAD_TEST_MB=100 for the M1 acceptance check)
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createEvents, createStorage } from "./aws.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/index.js";

const run = process.env.INTEGRATION === "1";
const MB = 1024 * 1024;
const sizeBytes = Number(process.env.UPLOAD_TEST_MB ?? 12) * MB + 12345; // odd size: short last part

describe.runIf(run)("presigned multipart upload flow", () => {
  if (!run) return;
  const cfg = loadConfig({ ...process.env, NODE_ENV: "test" });
  const { db, sql } = createDb(cfg.DATABASE_URL);
  const sqs = new SQSClient({ region: cfg.AWS_REGION });
  const probeQueue = `${process.env.AWS_ENDPOINT_URL_SQS}/000000000000/streamforge-probe`;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = "";

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as "POST", url, payload: body as object, headers: { cookie } });
    return { status: res.statusCode, json: res.body ? res.json() : undefined, res };
  };

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({ cfg, db, storage: createStorage(cfg), events: createEvents(cfg) });
    const email = `it-${Date.now()}@example.test`;
    const r = await api("POST", "/auth/signup", { email, password: "integration-pw" });
    expect(r.status).toBe(201);
    cookie = String(r.res.headers["set-cookie"]).split(";")[0]!;
  });

  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  it("rejects unauthenticated requests", async () => {
    const r = await app.inject({ method: "GET", url: "/videos" });
    expect(r.statusCode).toBe(401);
  });

  it("uploads parts via presigned URLs, completes, and publishes video-uploaded", async () => {
    const created = await api("POST", "/videos", { filename: "clip.mp4", contentType: "video/mp4", sizeBytes });
    expect(created.status).toBe(201);
    const { video, upload } = created.json;
    expect(video.status).toBe("UPLOADING");

    const partNumbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
    const presigned = await api("POST", `/videos/${video.id}/upload/parts`, { partNumbers });
    expect(presigned.status).toBe(200);

    const data = Buffer.alloc(sizeBytes, 7);
    const t0 = performance.now();
    const parts = await Promise.all(
      presigned.json.urls.map(async ({ partNumber, url }: { partNumber: number; url: string }) => {
        const chunk = data.subarray((partNumber - 1) * upload.partSize, partNumber * upload.partSize);
        const res = await fetch(url, { method: "PUT", body: chunk, headers: { Origin: cfg.WEB_ORIGIN } });
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-expose-headers")).toMatch(/etag/i);
        return { partNumber, etag: res.headers.get("etag")! };
      }),
    );
    const uploadMs = performance.now() - t0;

    const done = await api("POST", `/videos/${video.id}/upload/complete`, { parts });
    expect(done.status).toBe(200);
    expect(done.json.status).toBe("UPLOADED");
    console.log(`uploaded ${(sizeBytes / MB).toFixed(1)} MB in ${upload.partCount} parts, ${uploadMs.toFixed(0)} ms`);

    // retrying complete is a no-op
    const again = await api("POST", `/videos/${video.id}/upload/complete`, { parts });
    expect(again.json.status).toBe("UPLOADED");

    const list = await api("GET", "/videos");
    expect(list.json.items.some((v: { id: string }) => v.id === video.id)).toBe(true);

    // event reached the probe queue through SNS -> SQS fan-out
    let found = false;
    for (let i = 0; i < 5 && !found; i++) {
      const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: probeQueue, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      for (const m of out.Messages ?? []) {
        if (JSON.parse(m.Body!).videoId === video.id) {
          found = true;
          await sqs.send(new DeleteMessageCommand({ QueueUrl: probeQueue, ReceiptHandle: m.ReceiptHandle! }));
        }
      }
    }
    expect(found).toBe(true);
  }, 120_000);

  it("rejects non-video uploads and wrong part sets", async () => {
    const bad = await api("POST", "/videos", { filename: "x.png", contentType: "image/png", sizeBytes: 10 });
    expect(bad.status).toBe(400);
    const { json } = await api("POST", "/videos", { filename: "a.mp4", contentType: "video/mp4", sizeBytes: 10 * MB });
    const r = await api("POST", `/videos/${json.video.id}/upload/complete`, { parts: [{ partNumber: 1, etag: '"x"' }] });
    expect(r.status).toBe(400);
    const aborted = await api("POST", `/videos/${json.video.id}/upload/abort`);
    expect(aborted.json.status).toBe("FAILED");
  });
});

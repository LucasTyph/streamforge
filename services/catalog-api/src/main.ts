import { startTracing } from "./telemetry.js";
const stopTracing = startTracing(); // before the app is built, so request spans export
import { buildApp } from "./app.js";
import { createEvents, createStorage } from "./aws.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/index.js";
import { startDlqWatcher } from "./dlq-watcher.js";
import { createNotifier } from "./notify.js";
import { createQueueReader } from "./queues.js";
import { startStatusConsumer } from "./status-consumer.js";

const cfg = loadConfig();
const { db, sql } = createDb(cfg.DATABASE_URL);
await runMigrations(db, sql);

const app = await buildApp({ cfg, db, storage: createStorage(cfg), events: createEvents(cfg) });
await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });
const notifier = await createNotifier(cfg.REDIS_URL, app.log);
const stopConsumer = startStatusConsumer({
  notifier,
  db,
  queueUrl: cfg.CATALOG_STATUS_QUEUE_URL,
  region: cfg.AWS_REGION,
  requiredTasks: cfg.REQUIRED_TASKS,
  log: app.log,
});

const stopDlqWatcher = startDlqWatcher({
  db,
  queues: createQueueReader(cfg.AWS_REGION, cfg.QUEUE_PREFIX),
  requiredTasks: cfg.REQUIRED_TASKS,
  notifier,
  log: app.log,
});

let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    app.log.info({ sig }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    stopDlqWatcher();
    await stopConsumer(); // finish the in-flight batch; undeleted messages are redelivered
    await app.close(); // stops accepting, drains in-flight requests
    await notifier.close();
    await stopTracing().catch(() => {});
    await sql.end({ timeout: 5 });
    clearTimeout(force);
    process.exit(0);
  });
}

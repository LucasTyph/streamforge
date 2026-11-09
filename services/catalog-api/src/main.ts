import { buildApp } from "./app.js";
import { createEvents, createStorage } from "./aws.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/index.js";

const cfg = loadConfig();
const { db, sql } = createDb(cfg.DATABASE_URL);
await runMigrations(db);

const app = await buildApp({ cfg, db, storage: createStorage(cfg), events: createEvents(cfg) });
await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });

let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    app.log.info({ sig }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    await app.close(); // stops accepting, drains in-flight requests
    await sql.end({ timeout: 5 });
    clearTimeout(force);
    process.exit(0);
  });
}

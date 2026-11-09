import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, connect_timeout: 5, idle_timeout: 30 });
  return { db: drizzle(sql, { schema }), sql };
}

/** Arbitrary constant: serializes migrations across API replicas and the seed Job. */
const MIGRATION_LOCK = 727_001;

export type Db = ReturnType<typeof createDb>["db"];

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db, sql: postgres.Sql) {
  // Session-level advisory lock on a dedicated connection; migrations run on the pool.
  const lock = await sql.reserve();
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(db, { migrationsFolder });
  } finally {
    await lock`select pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => {});
    lock.release();
  }
}

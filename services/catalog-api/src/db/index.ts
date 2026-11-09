import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, connect_timeout: 5, idle_timeout: 30 });
  return { db: drizzle(sql, { schema }), sql };
}

export type Db = ReturnType<typeof createDb>["db"];

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder });
}

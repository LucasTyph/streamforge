// Creates (or resets the password of) the demo user. Run: make seed
import { hashPassword } from "./auth.js";
import { createDb, runMigrations } from "./db/index.js";
import { users } from "./db/schema.js";

const email = (process.env.SEED_USER_EMAIL ?? "demo@streamforge.local").toLowerCase();
const password = process.env.SEED_USER_PASSWORD ?? "demo-password";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const { db, sql } = createDb(url);
await runMigrations(db, sql);
const passwordHash = await hashPassword(password);
await db.insert(users).values({ email, passwordHash }).onConflictDoUpdate({ target: users.email, set: { passwordHash } });
console.log(`seeded demo user ${email}`);
await sql.end();

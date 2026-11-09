import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "./db/index.js";
import { users } from "./db/schema.js";

export const SESSION_COOKIE = "sf_session";
const SESSION_TTL_S = 7 * 24 * 3600;

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations)
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => hash(pw, ARGON);
export const verifyPassword = (hashed: string, pw: string) => verify(hashed, pw).catch(() => false);

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Not signed in" });
  }
}

const credentials = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(200),
});
const userOut = z.object({ id: z.string(), email: z.string(), isAdmin: z.boolean() });
const errorOut = z.object({ error: z.string() });

export const authRoutes =
  (db: Db, secureCookies: boolean, adminEmails: readonly string[] = []): FastifyPluginAsyncZod =>
  async (app) => {
    const startSession = async (reply: FastifyReply, u: { id: string; email: string }) => {
      const token = await reply.jwtSign({ sub: u.id, email: u.email }, { expiresIn: SESSION_TTL_S });
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookies,
        path: "/",
        maxAge: SESSION_TTL_S,
      });
      return { id: u.id, email: u.email, isAdmin: adminEmails.includes(u.email) };
    };

    app.post(
      "/auth/signup",
      { schema: { tags: ["auth"], body: credentials, response: { 201: userOut, 409: errorOut } } },
      async (req, reply) => {
        const [u] = await db
          .insert(users)
          .values({ email: req.body.email, passwordHash: await hashPassword(req.body.password) })
          .onConflictDoNothing()
          .returning();
        if (!u) return reply.code(409).send({ error: "An account with this email already exists" });
        return reply.code(201).send(await startSession(reply, u));
      },
    );

    app.post(
      "/auth/login",
      { schema: { tags: ["auth"], body: credentials, response: { 200: userOut, 401: errorOut } } },
      async (req, reply) => {
        const u = await db.query.users.findFirst({ where: eq(users.email, req.body.email) });
        if (!u || !(await verifyPassword(u.passwordHash, req.body.password))) {
          return reply.code(401).send({ error: "Wrong email or password" });
        }
        return startSession(reply, u);
      },
    );

    app.post("/auth/logout", { schema: { tags: ["auth"] } }, async (_req, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get(
      "/auth/me",
      { schema: { tags: ["auth"], response: { 200: userOut } }, preHandler: requireUser },
      async (req) => ({ id: req.user.sub, email: req.user.email, isAdmin: adminEmails.includes(req.user.email) }),
    );
  };

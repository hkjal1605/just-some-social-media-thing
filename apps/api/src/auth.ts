// Auth (doc 11 §2): session cookie for the dashboard, Bearer ADMIN_API_TOKEN for bot/workers/CLI.
import { timingSafeEqual } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { env } from "@ve/config";
import { newId } from "@ve/core";
import { adminUsers, db, eq, lt, sessions } from "@ve/db";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

const SESSION_COOKIE = "ve_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 d (doc 10 §1)

export type AuthedEnv = {
  Variables: { admin: { id: string; username: string } | { id: "token"; username: "api-token" } };
};

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const sessionAuth: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return c.json({ error: { code: "unauthorized", message: "no session" } }, 401);
  const [row] = await db
    .select({
      id: sessions.id,
      expiresAt: sessions.expiresAt,
      adminUserId: sessions.adminUserId,
      username: adminUsers.username,
    })
    .from(sessions)
    .innerJoin(adminUsers, eq(adminUsers.id, sessions.adminUserId))
    .where(eq(sessions.id, sid))
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) {
    return c.json({ error: { code: "unauthorized", message: "session expired" } }, 401);
  }
  c.set("admin", { id: row.adminUserId, username: row.username });
  await next();
};

export const tokenAuth: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token || !constantTimeEqual(token, env.ADMIN_API_TOKEN)) {
    return c.json({ error: { code: "unauthorized", message: "bad token" } }, 401);
  }
  c.set("admin", { id: "token", username: "api-token" });
  await next();
};

/** Session OR bearer token — applied to everything except /auth/login + /healthz (doc 11 §2). */
export const eitherAuth: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  if (c.req.header("authorization")) return tokenAuth(c, next);
  return sessionAuth(c, next);
};

// login rate-limit: 5/min/client, in-memory bucket (doc 11 §2).
// Key on the real socket peer (getConnInfo) — never the client-supplied X-Forwarded-For, which an
// attacker can rotate to evade the limit. Behind a reverse proxy this collapses to a per-proxy
// bucket, which for a single-admin login is the intended brute-force throttle. Tests (app.request,
// no socket) fall back to a shared "local" key, so the limiter still engages.
const loginAttempts = new Map<string, number[]>();
function clientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "local";
  } catch {
    return "local";
  }
}
function rateLimited(key: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  // opportunistic prune so a flood of distinct peers can't grow the map without bound
  if (loginAttempts.size > 10_000) {
    for (const [k, ts] of loginAttempts) {
      if (ts.every((t) => t <= windowStart)) loginAttempts.delete(k);
    }
  }
  const hits = (loginAttempts.get(key) ?? []).filter((t) => t > windowStart);
  hits.push(now);
  loginAttempts.set(key, hits);
  return hits.length > 5;
}

export const authRoutes = new Hono<AuthedEnv>()
  .post("/login", zValidator("json", z.object({ password: z.string().min(1) })), async (c) => {
    if (rateLimited(clientKey(c))) {
      return c.json({ error: { code: "rate_limited", message: "try again in a minute" } }, 429);
    }
    const { password } = c.req.valid("json");
    const [admin] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.username, "admin"))
      .limit(1);
    if (!admin || !(await Bun.password.verify(password, admin.passwordHash))) {
      return c.json({ error: { code: "bad_credentials", message: "wrong password" } }, 401);
    }
    // opportunistic cleanup of expired sessions
    await db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .catch(() => {});
    const sid = `${newId()}${newId()}`.replaceAll("-", "");
    await db.insert(sessions).values({
      id: sid,
      adminUserId: admin.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: env.APP_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ ok: true, username: admin.username });
  })
  .post("/logout", async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid)
      await db
        .delete(sessions)
        .where(eq(sessions.id, sid))
        .catch(() => {});
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  })
  .get("/me", sessionAuth, (c) => {
    return c.json({ username: c.get("admin").username });
  });

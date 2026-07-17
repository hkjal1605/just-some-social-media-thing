// /healthz (doc 08 §10, doc 12 §5): db, boss (send-only), R2 HEAD, workers heartbeat.
import { env } from "@ve/config";
import { bossStarted, getSetting, sqlClient } from "@ve/db";
import { headBucket } from "@ve/storage";
import type { Context } from "hono";

const HEARTBEAT_STALE_MS = 5 * 60_000;

export async function healthz(c: Context): Promise<Response> {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    await sqlClient.unsafe("select 1");
    checks.db = "ok";
  } catch (err) {
    checks.db = `fail: ${String(err).slice(0, 120)}`;
    healthy = false;
  }

  checks.boss = bossStarted() ? "ok" : "not-started";
  if (!bossStarted()) healthy = false;

  checks.storage = (await headBucket()) ? "ok" : "unreachable";
  // storage failure degrades but does not 503 in development (MinIO may be down locally)
  if (checks.storage !== "ok" && env.APP_ENV === "production") healthy = false;

  try {
    const hb = await getSetting<string>("workers_heartbeat");
    if (!hb) {
      checks.workers = "never-started";
    } else if (Date.now() - new Date(hb).getTime() > HEARTBEAT_STALE_MS) {
      checks.workers = `stale since ${hb}`;
      healthy = false; // dead workers must trip the uptime ping (doc 12 §5)
    } else {
      checks.workers = "ok";
    }
  } catch {
    checks.workers = "unknown";
  }

  return c.json({ ok: healthy, env: env.APP_ENV, checks }, healthy ? 200 : 503);
}

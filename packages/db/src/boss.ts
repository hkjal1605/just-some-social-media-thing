// Shared pg-boss instance (doc 03 §3). Only apps/workers starts it in worker mode
// (supervision + schedules); apps/api starts send-only to enqueue.
import { env } from "@ve/config";
import { ALL_QUEUES, makeLogger, type QueueName } from "@ve/core";
import PgBoss from "pg-boss";

const log = makeLogger("pg-boss");

let instance: PgBoss | null = null;
let instanceMode: "worker" | "send" | null = null;

/**
 * pg-boss uses node-postgres (`pg`), which for `sslmode=require` encrypts AND verifies the cert
 * chain — managed Postgres (Timescale Cloud, Supabase, …) present a CA that isn't in the default
 * trust store, so it throws SELF_SIGNED_CERT_IN_CHAIN. Our Drizzle client (postgres.js) encrypts
 * WITHOUT verifying for the very same URL, so match it: TLS on, chain-verification off.
 *
 * Under Bun the URL's `sslmode=require` overrides an explicit `ssl` option and re-enables
 * verification, so we STRIP sslmode from the connection string and set `ssl` ourselves. A plain
 * local URL (no sslmode) connects in cleartext.
 */
function bossConnection(url: string): {
  connectionString: string;
  ssl: false | { rejectUnauthorized: false };
} {
  if (!/[?&]sslmode=(require|prefer|verify-ca|verify-full)/i.test(url)) {
    return { connectionString: url, ssl: false };
  }
  let connectionString = url;
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    connectionString = u.toString();
  } catch {
    connectionString = url.replace(/([?&])sslmode=[a-z-]+/gi, "$1").replace(/[?&]$/, "");
  }
  return { connectionString, ssl: { rejectUnauthorized: false } };
}

export async function startBoss(mode: "worker" | "send" = "worker"): Promise<PgBoss> {
  if (instance) {
    if (mode === "worker" && instanceMode === "send") {
      throw new Error("pg-boss already started send-only in this process");
    }
    return instance;
  }
  const { connectionString, ssl } = bossConnection(env.DATABASE_URL);
  const boss = new PgBoss({
    connectionString,
    schema: env.PGBOSS_SCHEMA,
    ssl,
    ...(mode === "send" ? { supervise: false } : {}),
  });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  await boss.start();
  instance = boss;
  instanceMode = mode;
  return boss;
}

/** api-side: enqueue-only start (doc 03 §3 "startSendOnly"). */
export const startSendOnly = (): Promise<PgBoss> => startBoss("send");

export function getBoss(): PgBoss {
  if (!instance) throw new Error("pg-boss not started — call startBoss()/startSendOnly() first");
  return instance;
}

export function bossStarted(): boolean {
  return instance !== null;
}

/** Max wall-clock a job may run before pg-boss treats it as abandoned and re-delivers it. Too low
 *  and a legitimately slow job runs a SECOND time concurrently (races the first). */
function expireFor(name: QueueName): number {
  if (name === "factory.render") return 1800; // ffmpeg render + ASD reframe
  // clip.* ingest/transcribe/analyze pull, Whisper, and the Gemini video wait on full-length videos —
  // the analyze must be allowed to run PAST GEMINI_FILE_TIMEOUT_MS (+ margin for up/download +
  // generate) without being re-delivered mid-flight, or two analyses race the promote/delete.
  if (name.startsWith("clip.")) return Math.ceil(env.GEMINI_FILE_TIMEOUT_MS / 1000) + 600;
  return 900;
}

/** Per-queue defaults (doc 08 §2): retryLimit 3, retryDelay 60s, backoff, expiry per expireFor(). */
function queueOptions(name: QueueName): PgBoss.Queue {
  return {
    name,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: expireFor(name),
  };
}

/** pg-boss v10 requires queues to exist before send/work — idempotent create for the whole registry. */
export async function ensureQueues(boss: PgBoss): Promise<number> {
  let n = 0;
  for (const q of ALL_QUEUES) {
    try {
      await boss.createQueue(q, queueOptions(q));
      n++;
    } catch (err) {
      // pg-boss create_queue is ON CONFLICT DO NOTHING, so an existing queue never throws here —
      // anything that lands in this catch is a genuine error (connection/permission). Surface it.
      log.warn({ queue: q, err }, "createQueue failed");
    }
  }
  return n;
}

export async function stopBoss(): Promise<void> {
  if (!instance) return;
  await instance.stop({ graceful: true, timeout: 30_000 });
  instance = null;
  instanceMode = null;
}

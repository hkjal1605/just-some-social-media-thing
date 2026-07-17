// apps/workers — the single pg-boss consumer process (doc 08 §1).
// Live engines: Radar (doc 04), Factory (doc 05), Distribution (doc 06),
// Learning (doc 07), plus the approvals bridge and alert.telegram consumer.
import { env } from "@ve/config";
import { ALL_QUEUES, makeLogger } from "@ve/core";
import { closeDb, ensureQueues, setSetting, startBoss, stopBoss } from "@ve/db";
import { registerAllWorkers, registerSchedules } from "./registrations";

const log = makeLogger("workers");

const boss = await startBoss("worker");
const created = await ensureQueues(boss);
log.info(
  { queues: ALL_QUEUES.length, ensured: created, schema: env.PGBOSS_SCHEMA },
  "queue registry ready",
);

await registerAllWorkers(boss);
await registerSchedules(boss);

// heartbeat every 60 s → /healthz flags staleness >5 min (doc 08 §10)
await setSetting("workers_heartbeat", new Date().toISOString());
const heartbeat = setInterval(() => {
  setSetting("workers_heartbeat", new Date().toISOString()).catch((err) =>
    log.warn({ err }, "heartbeat write failed"),
  );
}, 60_000);

log.info("workers ready — radar + factory + distribution + learning engines live");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "graceful shutdown: boss.stop({ graceful: true, timeout: 30s })");
  clearInterval(heartbeat);
  await stopBoss().catch((err) => log.error({ err }, "boss stop failed"));
  await closeDb().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

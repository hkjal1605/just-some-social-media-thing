// api-side job enqueue (doc 11): lazy send-only pg-boss + one-time queue ensure,
// so the API can enqueue even on a fresh database where workers never ran.
import type { QueueName } from "@ve/core";
import { bossStarted, ensureQueues, getBoss, startSendOnly } from "@ve/db";
import type PgBoss from "pg-boss";

let queuesEnsured = false;

export async function enqueue(
  name: QueueName,
  data: object,
  options?: PgBoss.SendOptions,
): Promise<string | null> {
  if (!bossStarted()) await startSendOnly();
  if (!queuesEnsured) {
    await ensureQueues(getBoss());
    queuesEnsured = true;
  }
  return getBoss().send(name, data, options ?? {});
}

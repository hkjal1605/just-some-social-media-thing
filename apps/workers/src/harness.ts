// Worker registration pattern (doc 08 §2): parse payload with the queue's zod schema,
// honor the kill-switch, alert on final retry failure. Never swallow errors.
import { concurrencyFor, makeLogger, Q, type QueueName } from "@ve/core";
import { getSetting } from "@ve/db";
import type PgBoss from "pg-boss";
import type { z } from "zod";

const log = makeLogger("workers");

/** How long a kill-switched job is deferred before it re-checks (doc 08 §2 "RetryLater"). */
const KILL_SWITCH_DEFER_SECONDS = 15 * 60;

/** Minimal enqueue surface — handlers take this so tests can stub it. */
export interface Enqueuer {
  send(name: string, data: object, options?: PgBoss.SendOptions): Promise<string | null>;
}

/** Kill-switch blocks publish.*, engage.reply, approval.request, factory.* —
 * radar + metrics keep running, eyes stay open (doc 08 §6). */
export function queueBlockedByKillSwitch(queue: string): boolean {
  return (
    queue.startsWith("publish.") ||
    queue === Q.engageReply ||
    queue === Q.approvalRequest ||
    queue.startsWith("factory.")
  );
}

export async function killSwitchBlocks(queue: string): Promise<boolean> {
  if (!queueBlockedByKillSwitch(queue)) return false;
  return (await getSetting<boolean>("kill_switch")) === true;
}

/** Fire-and-forget ops alert (doc 00 §7) — consumed by the alert.telegram worker. */
export async function enqueueAlert(boss: Enqueuer, text: string, key?: string): Promise<void> {
  try {
    await boss.send(Q.alertTelegram, { text: text.slice(0, 1000), ...(key ? { key } : {}) });
  } catch (err) {
    log.error({ err }, "failed to enqueue alert (alerting is best-effort)");
  }
}

export interface WorkerContext {
  jobId: string;
  queue: QueueName;
}

/**
 * Register a queue worker: zod-parsed payload, kill-switch gate, final-failure alert.
 *
 * Concurrency (doc 08 §1 "teamSize"): pg-boss v10 has no teamSize, so we register
 * `concurrency` independent single-job workers on the queue. Each polls with
 * FOR UPDATE SKIP LOCKED, so N workers == N concurrent jobs with per-job retry
 * isolation (a batch handler would fail/complete all its jobs atomically instead).
 */
export async function registerWorker<S extends z.ZodTypeAny>(
  boss: PgBoss,
  queue: QueueName,
  schema: S,
  fn: (data: z.infer<S>, ctx: WorkerContext) => Promise<void>,
  opts: { pollingIntervalSeconds?: number; concurrency?: number } = {},
): Promise<void> {
  const handler = async (jobs: PgBoss.JobWithMetadata<object>[]): Promise<void> => {
    for (const job of jobs) {
      const jlog = log.child({ queue, jobId: job.id });
      // entity id for alerts, read from the RAW payload so a schema-parse failure still labels it
      const raw = (job.data ?? {}) as {
        sourceId?: string;
        briefId?: string;
        postId?: string;
        categoryId?: string;
        id?: string;
      };
      const entityId = raw.sourceId ?? raw.briefId ?? raw.postId ?? raw.categoryId ?? raw.id ?? "-";
      try {
        const data = schema.parse(job.data ?? {});
        if (await killSwitchBlocks(queue)) {
          // Defer, don't throw: throwing burns the retry budget and dead-letters within minutes,
          // but a kill-switch is on for hours. Re-enqueue for later and complete this job so no
          // work is lost and it re-arms automatically once the switch clears (doc 08 §2, §6).
          jlog.warn(
            { deferSeconds: KILL_SWITCH_DEFER_SECONDS },
            "kill-switch active — deferring job",
          );
          await boss.send(queue, data as object, { startAfter: KILL_SWITCH_DEFER_SECONDS });
          continue;
        }
        await fn(data, { jobId: job.id, queue });
      } catch (err) {
        jlog.error({ err }, "job failed");
        // alert on the final attempt — covers handler errors AND malformed payloads (parse throws)
        if ((job.retryCount ?? 0) >= (job.retryLimit ?? 3)) {
          await enqueueAlert(
            boss,
            `🔥 ${queue} failed | ${entityId} | ${String(err).slice(0, 300)}`,
            `job-fail:${queue}:${entityId}`, // per-entity so distinct failures don't dedupe into one
          );
        }
        throw err;
      }
    }
  };

  const workers = Math.max(1, opts.concurrency ?? concurrencyFor(queue));
  for (let i = 0; i < workers; i++) {
    await boss.work<object>(
      queue,
      {
        batchSize: 1,
        includeMetadata: true,
        pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2,
      },
      handler,
    );
  }
}

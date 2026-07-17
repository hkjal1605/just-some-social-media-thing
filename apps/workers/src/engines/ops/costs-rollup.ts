// costs.rollup (doc 08 §7, daily 05:00 IST): the budget guard + the day's rollup, plus the
// two sibling maintenance steps the docs hang off this cron — baseline recompute (doc 04 §2)
// and the reddit raw-items TTL prune (doc 12 §6).
//
//   1. Sum month-to-date llm_usage + api_usage → settings.budget_state (per-service breakdown
//      the dashboard Costs page reads).
//   2. ≥80% of COST_BUDGET_MONTHLY_USD → TG warning, once per month.
//   3. ≥100% → flip the kill-switch (reason: budget) + alert, once per month.
//   4. Recompute every active category × platform velocity baseline.
//   5. Hard-delete reddit raw_items + snapshots older than the retention TTL.
import { env } from "@ve/config";
import {
  BUDGET_STATE_SETTING_KEY,
  type BudgetServiceLine,
  type BudgetState,
  BudgetStateSchema,
  decideBudget,
  makeLogger,
  PLATFORM,
  REDDIT_RAW_ITEM_RETENTION_DAYS,
} from "@ve/core";
import { categories, costsByServiceMonth, db, eq, getSetting, setSetting, sql } from "@ve/db";
import { type Enqueuer, enqueueAlert } from "../../harness";
import { recomputeBaseline } from "../radar/baseline";

const log = makeLogger("ops-costs-rollup");

/** UTC 'YYYY-MM' — matches costsByServiceMonth's `at at time zone 'UTC'` filter. */
export function utcMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface CostsRollupResult {
  month: string;
  monthUsd: number;
  budgetUsd: number;
  ratio: number;
  level: BudgetState["level"];
  warned: boolean;
  killed: boolean;
  baselinesRecomputed: number;
  prunedRedditItems: number;
}

/** Recompute the rolling velocity baseline for every active category × platform (doc 04 §2). */
export async function recomputeAllBaselines(): Promise<number> {
  const cats = await db.select().from(categories).where(eq(categories.active, true));
  let n = 0;
  for (const c of cats) {
    for (const platform of PLATFORM) {
      await recomputeBaseline(c.id, platform);
      n++;
    }
  }
  return n;
}

/** Hard-delete reddit raw_items past the retention TTL; snapshots + trend_members cascade (doc 12 §6). */
export async function pruneRedditRawItems(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - REDDIT_RAW_ITEM_RETENTION_DAYS * 86_400_000);
  const deleted = (await db.execute(sql`
    delete from raw_items
    where platform = 'reddit' and first_seen_at < ${cutoff.toISOString()}::timestamptz
    returning id
  `)) as unknown as { id: string }[];
  return deleted.length;
}

export async function costsRollupHandler(
  boss: Enqueuer,
  opts: { now?: Date; budgetUsd?: number } = {},
): Promise<CostsRollupResult> {
  const now = opts.now ?? new Date();
  const budgetUsd = opts.budgetUsd ?? env.COST_BUDGET_MONTHLY_USD;
  const month = utcMonth(now);

  // 1 · per-service rollup (single source: monthUsd is the sum of these lines)
  const { services } = await costsByServiceMonth(month);
  const byService: BudgetServiceLine[] = services.map((s) => ({
    service: s.service,
    kind: s.kind,
    costUsd: s.costUsd,
  }));
  const monthUsd = byService.reduce((sum, s) => sum + s.costUsd, 0);

  // 2/3 · budget decision (pure) — thresholds cross once per month
  const stored = await getSetting<unknown>(BUDGET_STATE_SETTING_KEY);
  const parsed = BudgetStateSchema.safeParse(stored);
  const prev = parsed.success ? parsed.data : null; // legacy {monthUsd:0} seed ⇒ treated as fresh
  const decision = decideBudget({
    prev,
    month,
    monthUsd,
    budgetUsd,
    byService,
    nowIso: now.toISOString(),
  });
  await setSetting(BUDGET_STATE_SETTING_KEY, decision.next);

  if (decision.warn) {
    await enqueueAlert(
      boss,
      `⚠️ Budget ${Math.round(decision.next.ratio * 100)}% used — $${monthUsd.toFixed(2)} / $${budgetUsd.toFixed(0)} MTD (${month})`,
      `budget-warn:${month}`,
    );
  }
  if (decision.kill) {
    await setSetting("kill_switch", true);
    await enqueueAlert(
      boss,
      `🛑 Budget 100% — $${monthUsd.toFixed(2)} / $${budgetUsd.toFixed(0)} (${month}). Kill-switch ON (reason: budget). Radar + metrics keep running.`,
      `budget-kill:${month}`,
    );
    log.warn({ month, monthUsd, budgetUsd }, "budget cap hit — kill-switch engaged");
  }

  // 4 · baseline recompute (doc 04 §2 sibling)
  const baselinesRecomputed = await recomputeAllBaselines();

  // 5 · reddit raw-items TTL prune (doc 12 §6)
  const prunedRedditItems = await pruneRedditRawItems(now);

  log.info(
    {
      month,
      monthUsd: Number(monthUsd.toFixed(2)),
      ratio: Number(decision.next.ratio.toFixed(3)),
      level: decision.next.level,
      baselinesRecomputed,
      prunedRedditItems,
    },
    "costs.rollup complete",
  );

  return {
    month,
    monthUsd,
    budgetUsd,
    ratio: decision.next.ratio,
    level: decision.next.level,
    warned: decision.warn,
    killed: decision.kill,
    baselinesRecomputed,
    prunedRedditItems,
  };
}

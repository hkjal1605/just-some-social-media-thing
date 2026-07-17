// Harness safety-rail types + pure logic (doc 08 §1/§7/§8): budget guard state,
// policy-diff output, per-queue worker concurrency, and retention/extract limits.
// Pure so the workers can unit-test the money math and the concurrency mapping.
import { z } from "zod";
import { BUDGET_KILL_RATIO, BUDGET_WARN_RATIO } from "./constants";

// ── Budget guard (doc 08 §7) — persisted to settings.budget_state ──────────

export const BUDGET_STATE_SETTING_KEY = "budget_state";

export const BudgetServiceLineSchema = z.object({
  service: z.string(),
  kind: z.enum(["llm", "api"]),
  costUsd: z.number(),
});
export type BudgetServiceLine = z.infer<typeof BudgetServiceLineSchema>;

export const BudgetStateSchema = z.object({
  month: z.string(), // 'YYYY-MM' (UTC) — the month these numbers cover
  monthUsd: z.number(), // month-to-date spend, llm_usage + api_usage
  budgetUsd: z.number(), // COST_BUDGET_MONTHLY_USD at compute time
  ratio: z.number(), // monthUsd / budgetUsd (0 when budget is 0)
  level: z.enum(["ok", "warn", "kill"]),
  warnedAt: z.string().nullable().default(null), // ISO — the 80% warning fired this month
  killedAt: z.string().nullable().default(null), // ISO — the 100% auto-kill fired this month
  byService: z.array(BudgetServiceLineSchema).default([]),
  updatedAt: z.string(),
});
export type BudgetState = z.infer<typeof BudgetStateSchema>;

export interface BudgetDecision {
  next: BudgetState;
  /** fire the 80% warning alert now (once per month) */
  warn: boolean;
  /** flip the kill-switch now (once per month, reason=budget) */
  kill: boolean;
}

/**
 * Pure budget decision (doc 08 §7). Thresholds cross once per month: `warnedAt`/`killedAt`
 * markers carry within a month and reset when the month rolls over. MTD spend is monotone,
 * so a marker set once stays set — this is what makes the alert fire exactly once.
 */
export function decideBudget(input: {
  prev: BudgetState | null;
  month: string;
  monthUsd: number;
  budgetUsd: number;
  byService: BudgetServiceLine[];
  nowIso: string;
}): BudgetDecision {
  const { prev, month, monthUsd, budgetUsd, byService, nowIso } = input;
  const sameMonth = prev?.month === month;
  const prevWarnedAt = sameMonth ? (prev?.warnedAt ?? null) : null;
  const prevKilledAt = sameMonth ? (prev?.killedAt ?? null) : null;

  const ratio = budgetUsd > 0 ? monthUsd / budgetUsd : 0;
  const warn = ratio >= BUDGET_WARN_RATIO && !prevWarnedAt;
  const kill = ratio >= BUDGET_KILL_RATIO && !prevKilledAt;

  const warnedAt = ratio >= BUDGET_WARN_RATIO ? (prevWarnedAt ?? nowIso) : prevWarnedAt;
  const killedAt = ratio >= BUDGET_KILL_RATIO ? (prevKilledAt ?? nowIso) : prevKilledAt;
  const level: BudgetState["level"] =
    ratio >= BUDGET_KILL_RATIO ? "kill" : ratio >= BUDGET_WARN_RATIO ? "warn" : "ok";

  return {
    next: {
      month,
      monthUsd,
      budgetUsd,
      ratio,
      level,
      warnedAt,
      killedAt,
      byService,
      updatedAt: nowIso,
    },
    warn,
    kill,
  };
}

// ── Policy watch (doc 08 §8) — policy-differ agent output ───────────────────

/** Old/new page extracts handed to the differ are capped at this length each (doc 08 §8). */
export const POLICY_EXTRACT_MAX_CHARS = 8000;

export const PolicyDiffSchema = z.object({
  hasMaterialChange: z.boolean(), // false ⇒ cosmetic/no real change (skip the alert)
  summary: z.string().max(600), // stored to policy_pages.last_diff_summary
  impact: z.string().max(400), // how it affects our publishing/monetization
});
export type PolicyDiff = z.infer<typeof PolicyDiffSchema>;

/** Reddit raw_items + snapshots are hard-deleted past this age (doc 12 §6 deletion-propagation TTL). */
export const REDDIT_RAW_ITEM_RETENTION_DAYS = 60;

// ── Per-queue worker concurrency (doc 08 §1 "teamSize") ─────────────────────
// pg-boss v10 dropped teamSize; we register N independent single-job workers per
// queue instead. FOR UPDATE SKIP LOCKED keeps them from grabbing the same job, so
// N pollers == N concurrent jobs with per-job retry isolation.

export const QUEUE_CONCURRENCY_DEFAULT = 3;

export function concurrencyFor(queue: string): number {
  if (queue === "factory.render") return 1; // one ffmpeg at a time — CPU guard (doc 08 §1)
  if (queue === "alert.telegram") return 1; // serial keeps the ≤1/hour alert dedupe race-free
  if (queue.startsWith("scout.")) return 4;
  if (queue === "metrics.snapshot") return 4;
  if (queue.startsWith("publish.")) return 2;
  return QUEUE_CONCURRENCY_DEFAULT; // llm agents + light jobs (doc 08 §1)
}

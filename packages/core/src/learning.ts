// Learning-loop domain schemas + constants (doc 07). Contracts between
// metrics.snapshot → learn.attribute → playbook.update → weekly digest.
import { z } from "zod";
import { PLATFORM } from "./enums";

// ── metrics.snapshot cadence (doc 07 §1) ─────────────────────────────
// SNAPSHOT_OFFSET_HOURS ([3, 24], enqueued by publish.execute) lives in constants.ts.
/** Daily sweep snapshots posts published within this window. */
export const SNAPSHOT_DAILY_MAX_AGE_DAYS = 30;
/** After 30 days: weekly until this age, then stop. */
export const SNAPSHOT_WEEKLY_MAX_AGE_DAYS = 90;
/** Skip a scheduled snapshot if one this fresh already exists (dedupe, doc 08 §11). */
export const SNAPSHOT_DEDUPE_HOURS = 2;
/** A views drop larger than this vs the prior snapshot is flagged (not dropped) (doc 07 §1). */
export const SNAPSHOT_ANOMALY_DROP_RATIO = 0.05;
/** Missing analytics (404 soon after publish): retry silently this many cycles then alert. */
export const SNAPSHOT_MISSING_RETRY_MAX = 3;

// ── Attribution (doc 07 §2) ──────────────────────────────────────────
/** Posts need at least this many days of data to enter the attribution window. */
export const ATTRIBUTION_MIN_AGE_DAYS = 7;
/** Attribution looks back this many weeks. */
export const ATTRIBUTION_WINDOW_WEEKS = 8;
/** Feature buckets with fewer than this many posts are marked `insufficient`. */
export const ATTRIBUTION_MIN_BUCKET_N = 5;
/** A (category, format) below the category median for this many weeks lands on the kill list. */
export const KILL_LIST_WEEKS_UNDER_MEDIAN = 3;

/** Feature vector assembled per post (doc 07 §2). Stored in the report artifact, not a table. */
export interface PostFeatureVector {
  postId: string;
  categorySlug: string;
  platform: string;
  formatSlug: string;
  hookVariantChosen: string | null;
  hookTextLength: number | null;
  estDurationSec: number | null;
  actualDurationSec: number | null;
  sceneCount: number | null;
  emotions: string[];
  formatArchetype: string | null;
  publishHourLocal: number | null;
  publishDow: number | null; // 0-6, IST
  timeFromTrendDetectionToPublishMin: number | null;
  aiDisclosure: boolean;
  trendLlmScore: number | null;
  trendVelocityScore: number | null;
  // outcomes
  views24h: number | null;
  views7d: number | null;
  engagementRate7d: number | null;
  avgViewDurationSec: number | null; // tiktok only
}

/** performance-analyst structured output (doc 07 §2, verbatim shape). */
export const AttributionReportSchema = z.object({
  headline: z.string(),
  wins: z.array(
    z.object({
      finding: z.string(),
      evidence: z.string(),
      confidence: z.enum(["strong", "tentative"]),
    }),
  ),
  losses: z.array(z.object({ finding: z.string(), evidence: z.string() })),
  playbookEdits: z.array(
    z.object({
      categorySlug: z.string(),
      section: z.string(),
      edit: z.string(),
      rationale: z.string(),
    }),
  ),
  killList: z.array(
    z.object({ categorySlug: z.string(), formatSlug: z.string(), reason: z.string() }),
  ), // 3 weeks below category median
  experiments: z
    .array(z.object({ hypothesis: z.string(), change: z.string(), metric: z.string() }))
    .max(3),
});
export type AttributionReport = z.infer<typeof AttributionReportSchema>;

/** playbook-editor structured output (doc 07 §3): the full rewritten markdown. */
export const PlaybookRewriteSchema = z.object({
  markdown: z.string().min(1),
  changeSummary: z.string().max(500),
});
export type PlaybookRewrite = z.infer<typeof PlaybookRewriteSchema>;

/** The fixed playbook sections every version carries (doc 07 §3). */
export const PLAYBOOK_SECTIONS = [
  "Voice",
  "Hooks that work",
  "Formats",
  "Timing",
  "Hashtags/keywords",
  "Kill list",
  "Experiments running",
] as const;

/** Max words the rewritten playbook may contain (doc 07 §3). */
export const PLAYBOOK_MAX_WORDS = 1500;
/** Unapproved playbook drafts older than this alert (doc 07 §3). */
export const PLAYBOOK_DRAFT_STALE_DAYS = 7;

/** Seed markdown for a brand-new category playbook (all sections present). */
export function emptyPlaybookMarkdown(categorySlug: string): string {
  return [
    `# Voice`,
    `Original, concrete, platform-native takes for ${categorySlug}. No restating sources.`,
    ``,
    `# Hooks that work`,
    `_No data yet — the learning loop fills this from real performance._`,
    ``,
    `# Formats`,
    `_No data yet._`,
    ``,
    `# Timing`,
    `_Use the default posting windows until data accrues._`,
    ``,
    `# Hashtags/keywords`,
    `_No data yet._`,
    ``,
    `# Kill list`,
    `_None._`,
    ``,
    `# Experiments running`,
    `_None._`,
  ].join("\n");
}

// ── Kill list (doc 07 §3) — mechanical enforcement in the editor ─────
export const KillListSchema = z.record(
  z.string(), // categorySlug
  z.record(
    z.string(), // formatSlug
    z.object({ reason: z.string(), addedAt: z.string() }),
  ),
);
export type KillList = z.infer<typeof KillListSchema>;
/** settings key holding the kill list the editor-in-chief reads (doc 08 §5 registry). */
export const KILL_LIST_SETTING_KEY = "kill_list";

// ── Threshold tracker (doc 07 §5) ────────────────────────────────────
export const ThresholdProgressSchema = z.object({
  tiktok: z
    .object({ followers: z.number().nullable(), views30d: z.number().nullable() })
    .partial()
    .optional(),
  youtube: z
    .object({
      subs: z.number().nullable(),
      shortsViews90d: z.number().nullable(),
      watchHours12mo: z.number().nullable(),
    })
    .partial()
    .optional(),
  x: z
    .object({
      verifiedFollowers: z.number().nullable(),
      impressions3mo: z.number().nullable(),
    })
    .partial()
    .optional(),
  updatedAt: z.string().optional(),
});
export type ThresholdProgress = z.infer<typeof ThresholdProgressSchema>;
export const THRESHOLD_PROGRESS_SETTING_KEY = "threshold_progress";

/** Monetization gate constants (research §; rendered as progress bars on the dashboard). */
export const MONETIZATION_GATES = {
  tiktok: { followers: 10_000, views30d: 100_000 },
  youtube: { subsShorts: 500, shortsViews90d: 3_000_000, subsLong: 1_000, viewsLong: 10_000_000 },
  x: { impressions3mo: 5_000_000, verifiedFollowers: 500 },
} as const;

/** Platforms whose owned analytics we can auto-fill into threshold_progress. */
export const THRESHOLD_AUTOFILL_PLATFORMS = PLATFORM;

// Radar domain schemas + tuning constants (doc 04). These are the contracts between
// radar.score → radar.cluster → factory.brief; prompts in @ve/llm import them too.
import { z } from "zod";
import { FORMAT_ARCHETYPE, LONGEVITY, PLATFORM, RIGHTS_CLASS } from "./enums";
import { FORMAT_SLUGS } from "./formats";

// ── Layer-B rubric output (doc 04 §2, verbatim shape) ────────────────
export const RubricResultSchema = z.object({
  whyViral: z.string().max(280),
  emotions: z.array(z.string()).max(3), // 'awe','outrage','humor','curiosity','tribal','fomo'
  formatArchetype: z.enum(FORMAT_ARCHETYPE),
  transferability: z.object({
    tiktok: z.number().min(0).max(100),
    youtube: z.number().min(0).max(100),
    x: z.number().min(0).max(100),
    reddit: z.number().min(0).max(100),
  }),
  longevity: z.enum(LONGEVITY),
  rightsClass: z.enum(RIGHTS_CLASS),
  rightsNote: z.string().max(200), // what the third-party material is, if any
  llmScore: z.number().min(0).max(100), // overall "should we act"
});
export type RubricResult = z.infer<typeof RubricResultSchema>;

// ── Trend headline/summary combiner (doc 04 §3.3) ────────────────────
export const TrendHeadlineSchema = z.object({
  headline: z.string().min(1).max(140),
  summary: z.string().min(1).max(600),
});
export type TrendHeadline = z.infer<typeof TrendHeadlineSchema>;

// ── Editor-in-chief output (doc 04 §4) ───────────────────────────────
// LLM-tolerant: the model routinely writes a reason/angle a little over the limit when the source
// trend is rich — TRUNCATE rather than reject (a 210-char reason must not discard the whole batch of
// good decisions). Kept input==output (transform is string→string) so runStructured's `z.ZodType<T>`
// still infers the output type. Enums stay strict; invalid platforms are filtered in code
// (resolveTargetPlatforms). Cast keeps the enum output type through the transform.
const truncated = (max: number) => z.string().transform((s) => s.slice(0, max));
// Discriminated on `act`: a "skip" needs only a reason (so the model may omit formatSlug /
// targetPlatforms / angle without failing validation), while a "brief" carries the full spec.
// formatSlug is the full enum here; the editor code rejects clip-only formats (clip-vertical),
// so one bad choice degrades to a skip instead of failing the whole batch (doc 04 §4).
const EditorSkip = z.object({
  trendId: z.string(),
  act: z.literal("skip"),
  reason: truncated(200),
});
const EditorBrief = z.object({
  trendId: z.string(),
  act: z.literal("brief"),
  reason: truncated(200),
  formatSlug: z.enum(FORMAT_SLUGS),
  targetPlatforms: z.array(z.enum(PLATFORM)),
  angle: truncated(300), // the original take — NOT a restatement of the source
});
export const EditorDecisionSchema = z.object({
  decisions: z.array(z.discriminatedUnion("act", [EditorSkip, EditorBrief])),
});
export type EditorDecision = z.infer<typeof EditorDecisionSchema>;

// ── Scored item carried from radar.score to radar.cluster ────────────
export const ScoredItemSchema = z.object({
  rawItemId: z.string().uuid(),
  velocityScore: z.number().nullable(), // z-score vs category baseline; null when <2 snapshots
  // absent for members of live trends: they only refresh the velocity rollup (doc 04 §3.4)
  rubric: RubricResultSchema.optional(),
});
export type ScoredItem = z.infer<typeof ScoredItemSchema>;

// ── Tuning constants (doc 04) ─────────────────────────────────────────
/** Scout tick cadence (doc 08 §3). */
export const SCOUT_TICK_CRON = "*/15 * * * *";
/** Default per-platform scout intervals in minutes (doc 04 §1). */
export const SCOUT_INTERVALS_MIN = { reddit: 30, youtube: 60, x: 60, tiktok: 360 } as const;
/** Items older than this with no existing row are ignored (stale backfill guard, doc 04 §1). */
export const STALE_ITEM_MAX_AGE_DAYS = 7;
/** YouTube tracked-video stats refresh window (doc 04 §1). */
export const YT_STATS_REFRESH_HOURS = 72;
/** Layer-A gate: below this velocity AND older than the cutoff → no LLM spend (doc 04 §2). */
export const VELOCITY_MIN_FOR_LLM = 1.0;
export const ITEM_AGE_LLM_CUTOFF_HOURS = 24;
/** Rolling baseline window + freshness (doc 04 §2). */
export const BASELINE_WINDOW_DAYS = 14;
export const BASELINE_MAX_AGE_HOURS = 24;
/** Clustering (doc 04 §3). */
export const SIMILARITY_ATTACH_THRESHOLD = 0.82;
export const TREND_CANDIDATE_WINDOW_HOURS = 72;
export const EMBED_TEXT_MAX_CHARS = 2000;
/** Trend expiry (doc 04 §3.5). */
export const TREND_EXPIRE_FLASH_HOURS = 48;
export const TREND_EXPIRE_DEFAULT_DAYS = 7;
/** Editor-in-chief (doc 04 §4). */
export const EDITOR_MIN_LLM_SCORE = 70;
/** Amber trends may only ship commentary-class formats (doc 04 §4, enforced in code). */
export const AMBER_ALLOWED_FORMATS = ["x-thread", "faceless-explainer-60s"] as const;

/** worst-of rollup: red beats amber beats green (doc 04 §3.4). */
const RIGHTS_RANK = { green: 0, amber: 1, red: 2 } as const;
export function worstRights(
  a: keyof typeof RIGHTS_RANK,
  b: keyof typeof RIGHTS_RANK,
): keyof typeof RIGHTS_RANK {
  return RIGHTS_RANK[a] >= RIGHTS_RANK[b] ? a : b;
}

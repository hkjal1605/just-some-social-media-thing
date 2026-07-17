// Distribution domain schemas + rails (doc 06). Contracts between approval →
// publish.plan → publish.execute → publish.verify → engage.*.
import { z } from "zod";
import type { Platform } from "./enums";
import type { IstWeekday } from "./time";

// ── Ayrshare platform naming (doc 06 §2) ─────────────────────────────
// We store the platform as our canonical enum; Ayrshare calls X "twitter".
export const AYRSHARE_PLATFORM: Record<Platform, "tiktok" | "youtube" | "twitter" | "reddit"> = {
  tiktok: "tiktok",
  youtube: "youtube",
  x: "twitter",
  reddit: "reddit",
};
export function toAyrsharePlatform(p: Platform): "tiktok" | "youtube" | "twitter" | "reddit" {
  return AYRSHARE_PLATFORM[p];
}

// ── Engagement agent (doc 06 §6) ─────────────────────────────────────
export const COMMENT_KIND = ["question", "praise", "criticism", "spam", "other"] as const;
export type CommentKind = (typeof COMMENT_KIND)[number];

/** Gemini-batch classification of a new comment (doc 06 §6). */
export const CommentClassificationSchema = z.object({
  kind: z.enum(COMMENT_KIND),
  needsHuman: z.boolean(),
  draftReply: z.string().max(500).optional(),
});
export type CommentClassification = z.infer<typeof CommentClassificationSchema>;

/** Auto-reply is only ever sent for these kinds, and only when the category opts in (doc 06 §6). */
export const ENGAGE_AUTO_REPLY_KINDS: readonly CommentKind[] = ["praise", "question"];
/** Never more than this many automatic replies per post (doc 06 §6). */
export const ENGAGE_AUTO_REPLY_CAP = 10;

// ── Scheduler window matching (doc 06 §4) ────────────────────────────
export interface PostingWindow {
  days: string[]; // ['*'] or IST weekday abbreviations
  start: string; // 'HH:MM' IST
  end: string; // 'HH:MM' IST
  flag?: string | undefined; // A/B flag gating this window (e.g. tiktok_weekend_am)
  bestDay?: string | undefined;
}

/** Is this window active on the given IST weekday? '*' matches every day. */
export function windowActiveOnDay(window: PostingWindow, weekday: IstWeekday): boolean {
  return window.days.includes("*") || window.days.includes(weekday);
}

// ── Publish retry policy (doc 06 §5) ─────────────────────────────────
/** Retryable publish failures re-enqueue once at +20 min, up to this retryCount. */
export const PUBLISH_RETRY_MAX = 2;
export const PUBLISH_RETRY_DELAY_MINUTES = 20;
/** publish.verify runs this long after a successful execute (doc 06 §5). */
export const PUBLISH_VERIFY_DELAY_MINUTES = 10;
/** Fast-path (flash trends): schedule at now + this many minutes (doc 06 §4). */
export const FAST_PATH_DELAY_MINUTES = 10;
/** Warm-up mode forces every platform cap to this until warmup_until (doc 06 §7). */
export const WARMUP_DAILY_CAP = 1;
/** How many days ahead the scheduler will search for an open slot. */
export const SCHEDULE_HORIZON_DAYS = 7;

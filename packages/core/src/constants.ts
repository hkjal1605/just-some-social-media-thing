// Cross-engine constants (doc 03 §2).

/** Default per-platform posts/day caps (research §05; seeded onto categories). */
export const CADENCE_CAPS_DEFAULT = { tiktok: 2, youtube: 1, x: 5, reddit: 1 } as const;

/** Approvals expire this many hours after creation (doc 09 §1). */
export const APPROVAL_TTL_HOURS = 24;

/** approval.remind nudges a pending approval once when this little time is left (doc 09 §1: >20h of 24h). */
export const APPROVAL_REMIND_WINDOW_HOURS = 4;

/** An expired approval renews once if its trend is still hot at ≥ this llmScore (doc 09 §1). */
export const APPROVAL_RENEW_MIN_LLM_SCORE = 80;

/** Engagement agent works posts younger than this (doc 06 §6). */
export const ENGAGEMENT_WINDOW_HOURS = 3;

/** metrics.snapshot offsets after publish, in hours (doc 07 §1); then daily 06:00 IST. */
export const SNAPSHOT_OFFSET_HOURS = [3, 24] as const;

/** X API unit prices for api_usage cost accounting (research §07). */
export const X_UNIT_PRICES_USD = {
  readPerPost: 0.005,
  writePerPost: 0.015,
  urlPostWrite: 0.2, // a write containing a URL costs $0.20 flat
  ownReadPerResource: 0.001,
} as const;

/** Budget guard thresholds against COST_BUDGET_MONTHLY_USD (doc 08 §7). */
export const BUDGET_WARN_RATIO = 0.8;
export const BUDGET_KILL_RATIO = 1.0;

/** Editor-in-chief cap (doc 04 §4). */
export const MAX_BRIEFS_PER_HOUR_PER_CATEGORY = 2;

/** Scheduler rails (doc 06 §4/§7). */
export const MIN_SAME_PLATFORM_GAP_HOURS = 3;
export const MIN_SAME_TREND_CROSS_PLATFORM_GAP_MINUTES = 30;
export const SLOT_JITTER_MINUTES = 12;

/** Default X monthly read budget cap in USD (doc 04 §1, settings-overridable). */
export const X_MONTHLY_READ_CAP_USD_DEFAULT = 80;

/** YouTube Data API quota (units/day) + guard floor (doc 03 §6). */
export const YOUTUBE_QUOTA_DAILY = 10_000;
export const YOUTUBE_QUOTA_FLOOR = 500;

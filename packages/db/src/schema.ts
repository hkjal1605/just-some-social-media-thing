// Full schema per doc 02 §2. Conventions (doc 02 §1):
// - PKs: uuid (UUIDv7 generated app-side via @ve/core newId()), never serial.
// - Enums are text + zod app-side (no PG enums). JSONB columns have zod schemas in @ve/core.
// - Money numeric(12,6) USD; platform counts bigint.
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── Editorial config ─────────────────────────────────────────────
export const categories = pgTable("categories", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(), // 'ai-tech', 'football', 'f1', 'politics', 'music'
  name: text("name").notNull(),
  mode: text("mode").notNull(), // CATEGORY_MODE
  autoApproveFormats: jsonb("auto_approve_formats").notNull().default([]), // string[] format slugs earned auto-approval
  cadenceCaps: jsonb("cadence_caps").notNull(), // { tiktok: 2, youtube: 1, x: 5, reddit: 1 } posts/day
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    platform: text("platform").notNull(), // PLATFORM
    kind: text("kind").notNull(), // SOURCE_KIND
    value: text("value").notNull(), // 'r/artificial', channelId, query string, hashtag
    scoutIntervalMin: integer("scout_interval_min").notNull().default(60),
    active: boolean("active").notNull().default(true),
    lastScoutedAt: timestamp("last_scouted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sources_uniq").on(t.platform, t.kind, t.value, t.categoryId)],
);

// ── Radar ────────────────────────────────────────────────────────
export const rawItems = pgTable(
  "raw_items",
  {
    id: uuid("id").primaryKey(),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(), // platform-native id
    sourceId: uuid("source_id").references(() => sources.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    url: text("url").notNull(),
    author: text("author"),
    title: text("title"), // or first line of text
    text: text("text"), // caption/selftext, truncated 8k chars
    mediaType: text("media_type"), // 'video' | 'image' | 'text' | 'link'
    thumbnailUrl: text("thumbnail_url"),
    durationSec: integer("duration_sec"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    embedding: jsonb("embedding"), // number[] 768-d (doc 02 §4 pgvector note)
    trendId: uuid("trend_id").references(() => trends.id),
  },
  (t) => [
    uniqueIndex("raw_items_platform_ext").on(t.platform, t.externalId),
    index("raw_items_category_seen").on(t.categoryId, t.firstSeenAt),
    index("raw_items_trend").on(t.trendId),
  ],
);

export const itemSnapshots = pgTable(
  "item_snapshots",
  {
    id: uuid("id").primaryKey(),
    rawItemId: uuid("raw_item_id")
      .notNull()
      .references(() => rawItems.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    views: bigint("views", { mode: "number" }),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    score: integer("score"), // reddit score / x bookmark etc, platform-specific
  },
  (t) => [index("item_snapshots_item_time").on(t.rawItemId, t.capturedAt)],
);

export const trends = pgTable(
  "trends",
  {
    id: uuid("id").primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    status: text("status").notNull().default("active"), // TREND_STATUS
    headline: text("headline").notNull(), // LLM one-liner
    summary: text("summary").notNull(),
    formatArchetype: text("format_archetype"), // FORMAT_ARCHETYPE
    emotions: jsonb("emotions").notNull().default([]), // string[]
    rightsClass: text("rights_class").notNull(), // RIGHTS_CLASS
    rightsNote: text("rights_note"),
    velocityScore: numeric("velocity_score", { precision: 8, scale: 3 }), // z-score
    llmScore: integer("llm_score"), // 0-100 rubric
    transferability: jsonb("transferability"), // { tiktok: 0-100, youtube:…, x:…, reddit:… }
    centroid: jsonb("centroid"), // number[] 768-d mean of member embeddings (doc 04 §3)
    longevity: text("longevity"), // 'flash' | 'days' | 'evergreen'
    peakEstimateAt: timestamp("peak_estimate_at", { withTimezone: true }),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trends_cat_status_score").on(t.categoryId, t.status, t.llmScore)],
);

export const trendMembers = pgTable(
  "trend_members",
  {
    trendId: uuid("trend_id")
      .notNull()
      .references(() => trends.id, { onDelete: "cascade" }),
    rawItemId: uuid("raw_item_id")
      .notNull()
      .references(() => rawItems.id, { onDelete: "cascade" }),
    similarity: numeric("similarity", { precision: 5, scale: 4 }),
  },
  (t) => [primaryKey({ columns: [t.trendId, t.rawItemId] })],
);

// ── Factory ──────────────────────────────────────────────────────
export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey(),
    trendId: uuid("trend_id").references(() => trends.id), // null for campaign/longform briefs
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    originKind: text("origin_kind").notNull().default("trend"), // BRIEF_ORIGIN
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    longFormId: uuid("long_form_id").references(() => longForms.id),
    status: text("status").notNull().default("draft"), // BRIEF_STATUS
    angle: text("angle").notNull(), // editorial angle, 1-2 sentences
    formatSlug: text("format_slug").notNull(), // FORMATS key
    targetPlatforms: jsonb("target_platforms").notNull(), // PLATFORM[]
    playbookVersionId: uuid("playbook_version_id").references(() => playbookVersions.id),
    blockedReason: text("blocked_reason"),
    studioOnly: boolean("studio_only").notNull().default(false), // clip-studio: render-only, never publish
    captionPreset: text("caption_preset"), // viral caption preset for this clip's render
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("briefs_status").on(t.status),
    index("briefs_category_created").on(t.categoryId, t.createdAt),
  ],
);

export const scripts = pgTable(
  "scripts",
  {
    id: uuid("id").primaryKey(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    hookVariants: jsonb("hook_variants").notNull(), // [{ id:'a', text }, …] max 3
    chosenHook: text("chosen_hook"), // variant id after approval/edit
    body: text("body").notNull(), // narration script with [SCENE n] markers
    sceneCount: integer("scene_count").notNull(),
    estDurationSec: integer("est_duration_sec").notNull(),
    perPlatformCaptions: jsonb("per_platform_captions").notNull(), // PerPlatformCaptions
    sceneVisuals: jsonb("scene_visuals").notNull().default([]), // SceneVisual[] (doc 05 §1/§3)
    similarityReport: jsonb("similarity_report"), // { maxCosine, maxNgramOverlap, vsRawItemId, pass }
    aiDisclosure: boolean("ai_disclosure").notNull().default(false), // AI visuals/voice-of-persona used
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("scripts_brief_version").on(t.briefId, t.version)],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // ASSET_KIND
    r2Key: text("r2_key").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }),
    durationSec: numeric("duration_sec", { precision: 8, scale: 2 }),
    meta: jsonb("meta").notNull().default({}), // { sceneIndex?, pexelsId?, license?, voiceId?, model? }
    licenseRef: text("license_ref"), // 'pexels:12345' | 'own-recording' | 'campaign:<id>' | 'ai-gen:<model>'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assets_brief").on(t.briefId)],
);

export const renders = pgTable(
  "renders",
  {
    id: uuid("id").primaryKey(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    scriptId: uuid("script_id")
      .notNull()
      .references(() => scripts.id),
    platform: text("platform").notNull(), // target platform variant
    status: text("status").notNull().default("pending"), // RENDER_STATUS
    r2Key: text("r2_key"),
    thumbR2Key: text("thumb_r2_key"),
    // best-moment cover offset (ms into the clip) → handed to Buffer as thumbnailOffset (TikTok cover)
    thumbOffsetMs: integer("thumb_offset_ms"),
    width: integer("width"),
    height: integer("height"),
    durationSec: numeric("duration_sec", { precision: 8, scale: 2 }),
    bytes: bigint("bytes", { mode: "number" }), // for TG ≤50MB preview check (doc 09 §2)
    ffmpegLog: text("ffmpeg_log"), // tail 4k chars on failure
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("renders_brief_platform").on(t.briefId, t.platform)],
);

export const complianceChecks = pgTable("compliance_checks", {
  id: uuid("id").primaryKey(),
  briefId: uuid("brief_id")
    .notNull()
    .references(() => briefs.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(), // 'pre_render' | 'pre_publish'
  pass: boolean("pass").notNull(),
  results: jsonb("results").notNull(), // ComplianceChecksResults
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Approvals ────────────────────────────────────────────────────
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // APPROVAL_STATUS
    tgMessageId: bigint("tg_message_id", { mode: "number" }), // message in approval chat
    decidedByTgUserId: bigint("decided_by_tg_user_id", { mode: "number" }),
    decidedVia: text("decided_via"), // 'telegram' | 'dashboard' | 'auto'
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    editInstructions: text("edit_instructions"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // now()+24h
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("approvals_status").on(t.status)],
);

export const approvalEvents = pgTable("approval_events", {
  id: uuid("id").primaryKey(),
  approvalId: uuid("approval_id")
    .notNull()
    .references(() => approvals.id, { onDelete: "cascade" }),
  event: text("event").notNull(), // APPROVAL_EVENT
  actor: text("actor"), // tg user id / 'dashboard' / 'system'
  detail: jsonb("detail").notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Distribution ─────────────────────────────────────────────────
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id),
    renderId: uuid("render_id").references(() => renders.id), // null for text-only X/reddit posts
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    platform: text("platform").notNull(),
    status: text("status").notNull().default("draft"), // POST_STATUS
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ayrsharePostId: text("ayrshare_post_id"),
    externalId: text("external_id"), // platform-native post/video id
    permalink: text("permalink"),
    captionUsed: jsonb("caption_used"), // final metadata actually sent
    failReason: text("fail_reason"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("posts_status_sched").on(t.status, t.scheduledFor),
    index("posts_platform_published").on(t.platform, t.publishedAt),
    uniqueIndex("posts_render_platform").on(t.renderId, t.platform),
  ],
);

export const postSnapshots = pgTable(
  "post_snapshots",
  {
    id: uuid("id").primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    views: bigint("views", { mode: "number" }),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    watchTimeSec: bigint("watch_time_sec", { mode: "number" }),
    avgViewDurationSec: numeric("avg_view_duration_sec", { precision: 8, scale: 2 }),
    raw: jsonb("raw").notNull().default({}), // full analytics payload for later re-analysis
  },
  (t) => [index("post_snapshots_post_time").on(t.postId, t.capturedAt)],
);

export const engagements = pgTable(
  "engagements",
  {
    id: uuid("id").primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    externalCommentId: text("external_comment_id").notNull(),
    author: text("author"),
    text: text("text"),
    repliedText: text("replied_text"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    needsHuman: boolean("needs_human").notNull().default(false),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("engagements_post_comment").on(t.postId, t.externalCommentId)],
);

// ── Clipping inputs ──────────────────────────────────────────────
export const longForms = pgTable("long_forms", {
  id: uuid("id").primaryKey(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id),
  title: text("title").notNull(),
  r2Key: text("r2_key").notNull(), // uploaded source video
  durationSec: integer("duration_sec"),
  transcriptR2Key: text("transcript_r2_key"), // whisper json
  status: text("status").notNull().default("uploaded"), // LONG_FORM_STATUS
  sourceUrl: text("source_url"), // clip-studio: the pasted R2/public URL to ingest from
  genre: text("genre"), // detected/overridden genre → analysis + genre-adaptive render
  clipOptions: jsonb("clip_options"), // studio job: { platforms, topN, captionPreset, maxLen, minScore }
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clipCandidates = pgTable("clip_candidates", {
  id: uuid("id").primaryKey(),
  longFormId: uuid("long_form_id").references(() => longForms.id, { onDelete: "cascade" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  startSec: numeric("start_sec", { precision: 9, scale: 2 }).notNull(),
  endSec: numeric("end_sec", { precision: 9, scale: 2 }).notNull(),
  hookScore: integer("hook_score").notNull(), // 0-100
  selfContainedScore: integer("self_contained_score").notNull(),
  emotionScore: integer("emotion_score").notNull(),
  transcriptSlice: text("transcript_slice"),
  scriptData: jsonb("script_data"), // ClipScriptData: merged Gemini call's hooks + per-platform captions
  briefId: uuid("brief_id").references(() => briefs.id), // set when promoted to a brief
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(), // 'Whop: <brand> <month>'
  marketplace: text("marketplace").notNull().default("whop"),
  categoryId: uuid("category_id").references(() => categories.id),
  ratePer1k: numeric("rate_per_1k", { precision: 8, scale: 4 }),
  budgetUsd: numeric("budget_usd", { precision: 12, scale: 2 }),
  rulesUrl: text("rules_url"),
  rulesNote: text("rules_note"), // manual paste of campaign requirements
  sourceFootageNote: text("source_footage_note"), // where sponsor footage lives
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaignClips = pgTable("campaign_clips", {
  id: uuid("id").primaryKey(),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  postId: uuid("post_id")
    .notNull()
    .references(() => posts.id),
  submittedUrl: text("submitted_url"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  payoutUsd: numeric("payout_usd", { precision: 12, scale: 2 }),
  payoutAt: timestamp("payout_at", { withTimezone: true }),
});

// ── Learning / ops ───────────────────────────────────────────────
export const playbookVersions = pgTable(
  "playbook_versions",
  {
    id: uuid("id").primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    version: integer("version").notNull(),
    markdown: text("markdown").notNull(),
    changeSummary: text("change_summary"),
    createdBy: text("created_by").notNull().default("system"), // 'system' | 'human'
    approvedAt: timestamp("approved_at", { withTimezone: true }), // human reviews weekly
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("playbooks_cat_version").on(t.categoryId, t.version)],
);

export const policyPages = pgTable("policy_pages", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull().unique(),
  lastHash: text("last_hash"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
  lastDiffSummary: text("last_diff_summary"),
});

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    agent: text("agent").notNull(), // 'scriptwriter' | 'analyst' | …
    queue: text("queue"),
    entityKind: text("entity_kind"),
    entityId: uuid("entity_id"),
    status: text("status").notNull(), // 'ok' | 'error' | 'validation_retry'
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_runs_agent_time").on(t.agent, t.startedAt)],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(), // 'openrouter'|'gemini'|'openai'|'elevenlabs'|…
    model: text("model").notNull(),
    purpose: text("purpose").notNull(), // agent name or 'tts'|'transcribe'|'embed'|'video_understand'
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    units: numeric("units", { precision: 12, scale: 4 }), // minutes for tts/transcribe/video
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_usage_time").on(t.at)],
);

export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").primaryKey(),
    service: text("service").notNull(), // 'x_api'|'apify'|'ayrshare'|'youtube'|'reddit'|'pexels'|'ensemble'
    endpoint: text("endpoint").notNull(),
    units: numeric("units", { precision: 12, scale: 4 }).notNull(), // posts read, results, calls
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_usage_time").on(t.at)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(), // 'kill_switch','posting_windows','budget_state', …
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull().unique(), // v1: single row 'admin'
  passwordHash: text("password_hash").notNull(), // argon2id via Bun.password
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // random 32-byte token
  adminUserId: uuid("admin_user_id")
    .notNull()
    .references(() => adminUsers.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

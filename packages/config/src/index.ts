// @ve/config — the only module allowed to read process.env (doc 03 §1).
// Everything else imports `env` from here; a biome rule enforces it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Bun auto-loads .env only from the CWD, but monorepo scripts run with --cwd <pkg> —
// so load the repo-root .env explicitly. Values already in the real environment win.
function loadRootDotenv(): void {
  const path = join(import.meta.dir, "..", "..", "..", ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (!m || m[1] === undefined || process.env[m[1]] !== undefined) continue;
    // Unquote FIRST, then strip inline comments only from bare values — otherwise a value like
    // "abc #def" would lose everything after the '#' before we notice it was quoted.
    let v = (m[2] ?? "").trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.replace(/\s+#.*$/, "").trim();
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    process.env[m[1]] = v;
  }
}
loadRootDotenv();

const boolString = z.preprocess((v) => v === true || v === "true" || v === "1", z.boolean());

export const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_BASE_URL: z.string().url(),
  API_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),
  DISPLAY_TZ: z.string().default("Asia/Kolkata"),

  DATABASE_URL: z.string().url(),
  PGBOSS_SCHEMA: z.string().default("pgboss"),

  R2_ENDPOINT: z.string().url(),
  R2_ACCOUNT_ID: z.string().default("local"),
  R2_ACCESS_KEY_ID: z.string(),
  R2_SECRET_ACCESS_KEY: z.string(),
  R2_BUCKET: z.string(),
  // Public bucket base (r2.dev / custom domain) for LLM-fetchable media — see storage.publicUrl().
  // Empty (MinIO dev) → callers fall back to a presigned URL.
  R2_PUBLIC_BASE_URL: z.string().default(""),

  // OpenRouter is the SINGLE door for every AI model — one key, cheapest-capable model per job.
  OPENROUTER_API_KEY: z.string(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  // Text agents are tiered per agent by @ve/llm modelForAgent(): the capable model for
  // creative/strategic/analytical work, the flash model for high-volume mechanical work.
  OPENROUTER_MODEL: z.string().default("deepseek/deepseek-v4-pro"), // capable tier
  OPENROUTER_MODEL_FLASH: z.string().default("deepseek/deepseek-v4-flash"), // cheap tier
  OPENROUTER_MODEL_TRANSCRIBE: z.string().default("openai/whisper-large-v3-turbo"), // STT + timestamps
  OPENROUTER_MODEL_EMBED: z.string().default("openai/text-embedding-3-small"), // similarity/clustering
  OPENROUTER_EMBED_DIMS: z.coerce.number().default(768),
  OPENROUTER_MODEL_IMAGE: z.string().default("google/gemini-2.5-flash-image"), // ai-image scenes
  // Video + TTS use Gemini natively (same key). Video: OpenRouter's chat API has no video content
  // type (rejects video_url), so clip analysis uploads the source to Gemini's Files API. TTS:
  // OpenRouter has no verbatim-TTS model.
  GEMINI_API_KEY: z.string(),
  GEMINI_MODEL_VIDEO: z.string().default("gemini-3.5-flash"), // clip moment analysis (video understanding)
  // How long to wait for Gemini to finish PROCESSING an uploaded video before giving up. Long videos
  // take minutes; the old fixed 180s was too short and failed clip.analyze on full-length sources.
  // NOTE: the clip.* pg-boss queue expiry is derived from this (boss.ts) so a slow analyze isn't
  // re-delivered concurrently — keep them consistent.
  GEMINI_FILE_TIMEOUT_MS: z.coerce.number().default(1_800_000), // 30 min
  GEMINI_MODEL_TTS: z.string().default("gemini-3.1-flash-tts-preview"),
  GEMINI_TTS_VOICE: z.string().default("Kore"),

  // Active-speaker reframe (services/asd, Light-ASD): studio clips crop-and-follow the talker.
  // REFRAME_ENABLED gates the slow ASD pass; empty DIR/PYTHON ⇒ the worker derives the default
  // path (services/asd/.venv). Any failure falls back to a letterboxed blur-pad, never blocks.
  REFRAME_ENABLED: boolString.default(true),
  ASD_SERVICE_DIR: z.string().default(""),
  ASD_PYTHON: z.string().default(""),
  ASD_TIMEOUT_MS: z.coerce.number().default(360_000),

  // Clip Studio source ingest via yt-dlp — a pasted YouTube (or any supported site / page) URL is
  // resolved to a real video stream. Direct video-file URLs skip yt-dlp and download straight.
  YTDLP_PATH: z.string().default("yt-dlp"),
  YTDLP_MAX_HEIGHT: z.coerce.number().default(1080), // cap the pulled resolution (bandwidth/cost)
  YTDLP_TIMEOUT_MS: z.coerce.number().default(600_000),

  // Clip cover/thumbnail selection: replace the naive frame@1s with a best-MOMENT pick (a CV shortlist
  // from services/asd/cover.py + a Gemini re-rank for the most expressive frame) and a designed thumb
  // (face-crop + contrast/saturation + an optional ≤3-word curiosity hook). Reuses the ASD Python venv;
  // degrades gracefully to a midpoint frame if unavailable. Hook-card baking is per-job (clipOptions).
  COVER_SELECTION_ENABLED: boolString.default(true),
  COVER_TEXT_HOOK: boolString.default(true), // burn the Gemini ≤3-word hook onto the designed thumb
  COVER_TIMEOUT_MS: z.coerce.number().default(120_000), // cover.py budget (frame decode + scoring)

  // Direct social posting (Clip Studio "Post" buttons) goes through Buffer (buffer.com) — ONE
  // 3rd-party integrator for YouTube Shorts / TikTok / X. Connect each account once in Buffer's UI,
  // mint a token at publish.buffer.com/settings/api. Buffer pulls the clip from its public/presigned
  // R2 URL (no byte upload). Empty token ⇒ the Post buttons are disabled; which platforms are
  // postable is auto-detected from the channels connected in the Buffer account.
  BUFFER_ACCESS_TOKEN: z.string().default(""),
  BUFFER_ORGANIZATION_ID: z.string().default(""), // optional — auto-discovered from the token if empty
  // Privacy applied to YouTube uploads via Buffer's YouTube metadata.
  YOUTUBE_PRIVACY: z.enum(["public", "unlisted", "private"]).default("public"),

  REDDIT_CLIENT_ID: z.string().default(""),
  REDDIT_CLIENT_SECRET: z.string().default(""),
  REDDIT_USER_AGENT: z.string().default("web:viral-engine:v0.1"),
  YOUTUBE_API_KEY: z.string().default(""),
  X_BEARER_TOKEN: z.string().default(""),
  APIFY_TOKEN: z.string().default(""),
  ENSEMBLE_TOKEN: z.string().default(""),

  AYRSHARE_API_KEY: z.string().default(""),
  AYRSHARE_PROFILE_KEY: z.string().default(""),
  PEXELS_API_KEY: z.string().default(""),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_APPROVAL_CHAT_ID: z.coerce.number().default(0),
  TELEGRAM_ALERT_CHAT_ID: z.coerce.number().default(0),
  TELEGRAM_ADMIN_USER_IDS: z.string().default(""), // csv → parsed into tgAdminIds below

  SESSION_SECRET: z.string().min(32),
  DASHBOARD_ADMIN_PASSWORD: z.string().min(8),
  ADMIN_API_TOKEN: z.string().min(24),

  COST_BUDGET_MONTHLY_USD: z.coerce.number().default(150),
  // NOTE: doc 03 wrote z.coerce.boolean(), but Boolean("false") === true — boolString fixes that.
  KILL_SWITCH_DEFAULT: boolString.default(false),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment. Fix .env (see .env.example):\n${lines}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const tgAdminIds: number[] = env.TELEGRAM_ADMIN_USER_IDS.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n));

/** Feature flags for optional integrations — empty credential = disabled, connector falls back to fixtures. */
export const integrations = {
  reddit: env.REDDIT_CLIENT_ID !== "" && env.REDDIT_CLIENT_SECRET !== "",
  youtube: env.YOUTUBE_API_KEY !== "",
  x: env.X_BEARER_TOKEN !== "",
  ayrshare: env.AYRSHARE_API_KEY !== "",
  apify: env.APIFY_TOKEN !== "",
  ensemble: env.ENSEMBLE_TOKEN !== "",
  pexels: env.PEXELS_API_KEY !== "",
  telegram: env.TELEGRAM_BOT_TOKEN !== "",
  // Clip Studio direct posting via Buffer — "connected" once the access token is set. WHICH platforms
  // are actually postable is discovered at runtime from the Buffer account's channels (connectors).
  buffer: env.BUFFER_ACCESS_TOKEN !== "",
} as const;

export type IntegrationFlag = keyof typeof integrations;

// Factory domain schemas + rails (doc 05). Contracts between factory.script →
// factory.compliance → asset jobs → factory.render; prompts in @ve/llm import them.
import { z } from "zod";
import { PerPlatformCaptionsSchema } from "./jsonSchemas";

// ── Scriptwriter output (doc 05 §1, verbatim shape) ──────────────────
export const SceneVisualSchema = z.object({
  scene: z.number().int().min(1),
  // stock-search phrase | 'screen-demo' | 'ai-image: <desc>'
  want: z.string().min(1),
});
export type SceneVisual = z.infer<typeof SceneVisualSchema>;

export const HookVariantsSchema = z
  .array(z.object({ id: z.enum(["a", "b", "c"]), text: z.string().max(120) }))
  .length(3);

export const ScriptOutSchema = z.object({
  hookVariants: HookVariantsSchema,
  body: z.string().min(1), // narration with [SCENE n] markers; x-thread: tweets separated by ---
  sceneCount: z.number().int().min(1).max(12),
  sceneVisuals: z.array(SceneVisualSchema),
  estDurationSec: z.number().min(1),
  perPlatformCaptions: PerPlatformCaptionsSchema, // hashtags ≤5 tiktok; YT title ≤90
  aiDisclosure: z.boolean(), // true if any ai-image visual or persona voice
});
export type ScriptOut = z.infer<typeof ScriptOutSchema>;

/** jsonb schema for scripts.scene_visuals (doc 02 §1 convention). */
export const ScriptsSceneVisualsSchema = z.array(SceneVisualSchema);

// ── Clip analyzer output (doc 05 §5) ─────────────────────────────────
// One Gemini call over the whole video merges moment-finding AND scriptwriting: each moment carries
// its scores + verbatim transcriptSlice AND its ready-to-post creative (hookVariants + captions), so
// no separate scriptwriter call runs for clips. Whisper still owns the word-level caption timing.
export const ClipMomentsSchema = z.object({
  // true ⇒ the SOURCE video already has hardcoded/burned-in subtitles → skip our karaoke captions.
  // optional (not .default) so the schema stays input==output for analyzeVideo's z.ZodType<T>.
  hasBurnedCaptions: z.boolean().optional(),
  moments: z
    .array(
      z.object({
        startSec: z.number().min(0),
        endSec: z.number().min(0), // 20–90s windows enforced in code
        hookScore: z.number().min(0).max(100),
        selfContainedScore: z.number().min(0).max(100),
        emotionScore: z.number().min(0).max(100),
        transcriptSlice: z.string().max(500),
        suggestedHookText: z.string().max(120),
        hookVariants: HookVariantsSchema, // 3 on-screen hook texts (a/b/c) — was the scriptwriter's job
        perPlatformCaptions: PerPlatformCaptionsSchema, // tiktok/youtube/… captions + hashtags
      }),
    )
    .max(10),
});
export type ClipMoments = z.infer<typeof ClipMomentsSchema>;

/** jsonb stored on clip_candidates: the merged Gemini call's scriptwriting output for the moment. */
export const ClipScriptDataSchema = z.object({
  hookVariants: HookVariantsSchema,
  perPlatformCaptions: PerPlatformCaptionsSchema,
});
export type ClipScriptData = z.infer<typeof ClipScriptDataSchema>;

// ── Similarity guard thresholds (doc 05 §1 — code, not prompt) ───────
export const SIMILARITY_COSINE_MAX = 0.86;
export const SIMILARITY_NGRAM_MAX = 0.25;
export const SIMILARITY_SHINGLE_SIZE = 3; // trigram shingles

// ── Rights: allowed licenseRef shapes (doc 05 §2) ────────────────────
export const ALLOWED_LICENSE_PREFIXES = ["pexels:", "ai-gen:", "campaign:"] as const;
export const ALLOWED_LICENSE_EXACT = ["own-recording"] as const;

export function licenseRefAllowed(ref: string | null | undefined): boolean {
  if (!ref) return false;
  if ((ALLOWED_LICENSE_EXACT as readonly string[]).includes(ref)) return true;
  return ALLOWED_LICENSE_PREFIXES.some((p) => ref.startsWith(p) && ref.length > p.length);
}

// ── Platform-policy caption lint (doc 05 §2 pre_publish) ─────────────
/** Banned-claim keywords: medical/financial guarantees. Case-insensitive substring match. */
export const BANNED_CLAIM_PATTERNS: readonly RegExp[] = [
  /guaranteed (returns|profit|income|weight loss)/i,
  /cures? (cancer|diabetes|depression|anxiety)/i,
  /medical(ly)? proven/i,
  /risk[- ]free invest/i,
  /double your money/i,
  /get rich quick/i,
  /lose \d+ (kg|kilos|pounds|lbs) in/i,
  /100% (safe|effective|guaranteed)/i,
];

/** Politics on TikTok: no call-to-vote phrasing (doc 05 §2). */
export const POLITICS_TIKTOK_PATTERNS: readonly RegExp[] = [
  /go vote/i,
  /vote for/i,
  /register to vote/i,
  /get out (and|the) vote/i,
];

export const CAPTION_LIMITS = {
  tiktokHashtagsMax: 5,
  youtubeTagsMax: 20,
  youtubeTitleMax: 90,
  xTextMax: 280,
} as const;

// ── Asset fan-out (doc 05 §3) ────────────────────────────────────────
/** settings counter key: brief_assets_done:<briefId> (doc 08 §5 registry). */
export const briefAssetsDoneKey = (briefId: string): string => `brief_assets_done:${briefId}`;
/** Number of asset jobs that must finish before render (tts + visuals + captions). */
export const ASSET_JOBS_PER_BRIEF = 3;

/** Clip candidate window bounds (doc 05 §5). */
export const CLIP_MIN_SEC = 15; // allow punchy comedy/racing one-liners (research: 15-30s sweet spot)
export const CLIP_MAX_SEC = 90;

/** Shape of the whisper transcript JSON persisted to R2 (clip captions read it back). */
export interface WhisperResultLike {
  text: string;
  durationSec: number;
  segments: { start: number; end: number; text: string }[];
  words: { start: number; end: number; word: string }[];
}

/** Render duration sanity: within format range ±10% (doc 05 §4). */
export const RENDER_DURATION_TOLERANCE = 0.1;
/** TikTok Creator Rewards floor — the tiktok variant must exceed this (doc 05 §4). */
export const TIKTOK_MIN_DURATION_SEC = 61;

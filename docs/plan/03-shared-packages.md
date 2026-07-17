# 03 · Shared packages — contracts

Each package's public surface, exactly as other code imports it. Implementation details may vary; **signatures and behaviors here are the contract.**

## 1. `@ve/config`

```ts
// packages/config/src/index.ts
import { z } from 'zod';
const EnvSchema = z.object({
  APP_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_BASE_URL: z.string().url(),
  API_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DISPLAY_TZ: z.string().default('Asia/Kolkata'),
  DATABASE_URL: z.string().url(),
  PGBOSS_SCHEMA: z.string().default('pgboss'),
  R2_ENDPOINT: z.string().url(),
  R2_ACCESS_KEY_ID: z.string(), R2_SECRET_ACCESS_KEY: z.string(), R2_BUCKET: z.string(),
  ANTHROPIC_API_KEY: z.string(),
  ANTHROPIC_MODEL_EDITORIAL: z.string().default('claude-sonnet-5'),
  GEMINI_API_KEY: z.string(),
  GEMINI_MODEL_VIDEO: z.string().default('gemini-2.5-flash'),
  GEMINI_MODEL_EMBED: z.string().default('gemini-embedding-001'),
  GROQ_API_KEY: z.string(),
  ELEVENLABS_API_KEY: z.string().default(''), ELEVENLABS_VOICE_ID: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  REDDIT_CLIENT_ID: z.string(), REDDIT_CLIENT_SECRET: z.string(), REDDIT_USER_AGENT: z.string(),
  YOUTUBE_API_KEY: z.string(),
  X_BEARER_TOKEN: z.string().default(''),
  APIFY_TOKEN: z.string().default(''), ENSEMBLE_TOKEN: z.string().default(''),
  AYRSHARE_API_KEY: z.string().default(''), AYRSHARE_PROFILE_KEY: z.string().default(''),
  PEXELS_API_KEY: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string(), TELEGRAM_APPROVAL_CHAT_ID: z.coerce.number(),
  TELEGRAM_ALERT_CHAT_ID: z.coerce.number(), TELEGRAM_ADMIN_USER_IDS: z.string(), // csv → parsed getter
  SESSION_SECRET: z.string().min(32), DASHBOARD_ADMIN_PASSWORD: z.string().min(8),
  ADMIN_API_TOKEN: z.string().min(24),
  COST_BUDGET_MONTHLY_USD: z.coerce.number().default(150),
  KILL_SWITCH_DEFAULT: z.coerce.boolean().default(false),
});
export const env = EnvSchema.parse(process.env);        // throws with readable message at boot
export const tgAdminIds: number[] = env.TELEGRAM_ADMIN_USER_IDS.split(',').filter(Boolean).map(Number);
export const integrations = {                            // feature flags
  x: env.X_BEARER_TOKEN !== '', ayrshare: env.AYRSHARE_API_KEY !== '',
  elevenlabs: env.ELEVENLABS_API_KEY !== '', openaiTts: env.OPENAI_API_KEY !== '',
  apify: env.APIFY_TOKEN !== '', ensemble: env.ENSEMBLE_TOKEN !== '', pexels: env.PEXELS_API_KEY !== '',
};
```

Apps import `env` only from here; **no `process.env` reads anywhere else** (biome rule: restrict `process.env`).

## 2. `@ve/core`

- `enums.ts` — arrays + zod enums + TS types for everything in 00 §5.2.
- `ids.ts` — `newId(): string` (uuidv7).
- `stateMachines.ts` — transition maps (02 §5).
- `logger.ts` — configured pino instance factory `makeLogger(app: string)`.
- `time.ts` — `nowUtc()`, `toDisplay(dt)` (DISPLAY_TZ, `en-IN` format), `istHourToUtc(h)`.
- `queues.ts` — **queue name constants + payload zod schemas.** Every `boss.send`/`boss.work` uses these:

```ts
export const Q = {
  scoutReddit: 'scout.reddit', /* … all names from 00 §5.1 … */
} as const;
export const ScoutPayload = z.object({ sourceId: z.string().uuid() });
export const RadarScorePayload = z.object({ categoryId: z.string().uuid(), rawItemIds: z.array(z.string().uuid()) });
export const FactoryScriptPayload = z.object({ briefId: z.string().uuid() });
export const PublishExecutePayload = z.object({ postId: z.string().uuid() });
// … one schema per queue; workers parse payloads with these before acting.
```

- `formats.ts` — the format registry:

```ts
export const FORMATS = {
  'faceless-explainer-60s': { platforms: ['tiktok','youtube'], durationSec: [61, 90], render: 'slideshow-vo' },
  'demo-screencast':        { platforms: ['tiktok','youtube','x'], durationSec: [45, 120], render: 'screencast-vo' },
  'x-thread':               { platforms: ['x'], durationSec: null, render: 'text-only' },
  'clip-vertical':          { platforms: ['tiktok','youtube','x'], durationSec: [20, 90], render: 'clip-captions' },
  'reddit-discussion':      { platforms: ['reddit'], durationSec: null, render: 'text-only' },
} as const;
```

- `constants.ts` — cadence caps default, approval TTL (24 h), engagement window (3 h), snapshot schedule offsets, X read/write unit prices (for `api_usage` cost calc), budget thresholds (0.8 warn / 1.0 kill).

## 3. `@ve/db`

Exports: `db` (drizzle instance over postgres.js, `max: 10`), `schema` (all tables), `transitions` helpers (02 §5), `queries/*` (02 §7), `withTx(fn)`. Also `boss.ts`: a lazily-started shared **pg-boss** instance (`new PgBoss({ connectionString, schema: env.PGBOSS_SCHEMA })`) — imported by api (to enqueue) and workers (to work). Only `apps/workers` calls `boss.start()` with registrations; api uses `boss.send()` after `boss.startSendOnly()`.

## 4. `@ve/storage`

```ts
export function r2Key(...): string;                       // key builders per 00 §5.5
export async function putObject(key, body: Uint8Array | ReadableStream, mime): Promise<{ key, bytes }>;
export async function putFile(key, localPath, mime): Promise<{ key, bytes }>;   // streams from disk (renders)
export async function getObjectStream(key): Promise<ReadableStream>;
export async function presignGet(key, ttlSec = 3600): Promise<string>;
export async function deletePrefix(prefix): Promise<void>;                       // brief cleanup
```

S3 client config: `region: 'auto'`, `endpoint: env.R2_ENDPOINT`, `forcePathStyle: env.APP_ENV !== 'production'`. Large uploads (>100 MB long-forms) use multipart via `@aws-sdk/lib-storage` `Upload`.

## 5. `@ve/llm`

The **only** door to model providers. Everything is metered.

```ts
// Structured agent call (Claude): tools loop + zod-validated final output, retries on invalid output (max 2)
export async function runStructured<T>(opts: {
  agent: string;                        // for agent_runs + llm_usage
  system: string; user: string;
  schema: z.ZodType<T>;
  model?: string;                       // default env.ANTHROPIC_MODEL_EDITORIAL
  maxTokens?: number;
  entity?: { kind: string; id: string };
}): Promise<T>;

// Gemini: video understanding — uploads file (or presigned URL) and asks with a schema
export async function analyzeVideo<T>(opts: { agent: string; r2Key: string; prompt: string; schema: z.ZodType<T>; fps?: 'default'|'low' }): Promise<T>;

// Gemini: cheap batch text scoring (many small rubric calls in one request set)
export async function scoreBatch<T>(opts: { agent: string; items: {id: string; text: string}[]; rubricPrompt: string; schema: z.ZodType<T> }): Promise<Map<string, T>>;

export async function embed(texts: string[]): Promise<number[][]>;               // 768-d, task_type SEMANTIC_SIMILARITY
export async function transcribe(opts: { r2Key: string }): Promise<WhisperResult>; // Groq; returns segments with timestamps
export async function tts(opts: { text: string; provider?: 'elevenlabs'|'openai' }): Promise<{ audio: Uint8Array; durationSec: number }>;
```

Behaviors: cost computed from a static price table in `prices.ts` (update alongside provider changes; `policy.watch` also monitors pricing pages), written to `llm_usage`; every call also writes `agent_runs`. On provider 429/5xx: exponential backoff 3 attempts, then throw. `runStructured` uses Anthropic tool-use with a single `submit_result` tool whose input schema is the zod schema converted via `zod-to-json-schema`.

`prompts/` directory: one file per agent prompt (drafted in engine docs); prompts are code-reviewed artifacts, versioned in git, and interpolate the current playbook markdown where noted.

## 6. `@ve/connectors`

All connectors return **normalized** items and log `api_usage`. Common type:

```ts
export interface NormalizedItem {
  platform: Platform; externalId: string; url: string;
  author?: string; title?: string; text?: string;
  mediaType?: 'video'|'image'|'text'|'link'; thumbnailUrl?: string; durationSec?: number;
  publishedAt?: Date;
  metrics: { views?: number; likes?: number; comments?: number; shares?: number; score?: number };
}
```

| Module | Functions | Notes |
|---|---|---|
| `reddit.ts` | `fetchSubredditHot(name, limit)`, `fetchRising(name)`, `fetchComments(postId)` | App-only OAuth (client-credentials), token cached 50 min; honor `X-Ratelimit-*` headers; UA from env |
| `youtube.ts` | `fetchMostPopular(regionCode, videoCategoryId?)`, `fetchChannelUploads(channelId, sinceISO)`, `fetchVideoStats(ids[])`, `searchOnce(q)` (quota-guarded) | Quota ledger in `settings.youtube_quota` — decrement per call cost (search=100, others=1); refuse when <500 left, alert |
| `x.ts` | `searchRecent(query, sinceId?, maxResults)`, `getOwnPostsMetrics(ids[])`, `postText(text)` (optional direct write) | Log $0.005/post read + $0.015/write into `api_usage`; hard monthly read cap from settings |
| `tiktokData.ts` | `fetchHashtagTop(tag, limit)`, `fetchCreatorRecent(handle)` | Behind `TikTokDataProvider` interface with `apify` impl (call actor, poll run, fetch dataset) and optional `ensemble` impl; provider chosen by env; failures → try secondary if configured |
| `ayrshare.ts` | `createPost(p: AyrsharePost)`, `deletePost(id)`, `getPostAnalytics(id)`, `getHistory()`, `getComments(id)`, `replyComment(id, text)` | See doc 06 §2 for payload shape; all calls include `Profile-Key`; retries idempotent GETs only |
| `pexels.ts` | `searchVideos(query, orientation)`, `searchPhotos(query)` | Store `licenseRef: 'pexels:<id>'` on assets |

Every connector has a **fixture mode**: when `APP_ENV==='test'` or the integration flag is off, return recorded JSON from `packages/connectors/fixtures/` — keeps the whole pipeline runnable without any credentials.

## 7. `@ve/telegram`

Exports `buildBot()` (grammY `Bot` with all handlers — full code in doc 09), `sendApprovalCard(approvalId)`, `updateApprovalCard(approvalId)`, `sendAlert(text)`, `sendDigest(md)`. The bot instance is **only run** (long-polling) by `apps/bot`; `apps/workers` import the send-only helpers (they use raw Bot API via `bot.api` without polling).

## 8. `@ve/media`

FFmpeg is invoked via `Bun.spawn` with explicit args (never shell-interpolated strings).

```ts
export async function probe(localPath): Promise<{ durationSec, width, height, hasAudio }>;
export async function downloadToTmp(r2Key): Promise<string>;                    // tmp file, caller cleans
export function buildAss(opts: { segments: CaptionSegment[]; style: CaptionStyle }): string; // karaoke-style ASS
export async function renderSlideshowVo(opts: {                                  // format: slideshow-vo
  images: string[]; audioPath: string; assPath: string; out: string;
  size: {w:number,h:number}; kenBurns: boolean;
}): Promise<void>;
export async function renderScreencastVo(opts: { videoPath; audioPath?; assPath; out; size }): Promise<void>;
export async function renderClip(opts: {                                         // format: clip-captions
  sourcePath: string; startSec: number; endSec: number; out: string;
  size: {w,h}; cropMode: 'center'|'blur-pad'; assPath?: string;
}): Promise<void>;
export async function thumbnail(videoPath, atSec, out): Promise<void>;
```

Implementation notes: 1080×1920 for vertical, 1920×1080 for X 16:9; H.264 High, `-crf 21`, AAC 192k, `-movflags +faststart`; captions burned with `subtitles=file.ass:fontsdir=packages/media/fonts` (bundle two OFL fonts, e.g. Inter + Bricolage Grotesque); `renderClip` blur-pad mode = scale-to-fit over blurred bg for 16:9→9:16; all renders capped with `-t` guard and a 10-min process timeout. Temp dir `tmp/render/{renderId}/`, always cleaned in `finally`.

# 05 · Engine 2 — Factory (original content production)

Purpose: turn a brief into platform-native, rights-clean, approval-ready renders for ≤ $1/video. Also owns the clipping pipeline (own long-form + licensed campaign footage).

## 1. Scriptwriter (`factory.script`)

Input: `briefId`. Loads brief + trend (headline/summary/why-viral/emotions — **not** member source texts), playbook markdown, format spec from `FORMATS`.

`runStructured` (Claude, agent `scriptwriter`), output:

```ts
const ScriptOut = z.object({
  hookVariants: z.array(z.object({ id: z.enum(['a','b','c']), text: z.string().max(120) })).length(3),
  body: z.string(),                       // narration with [SCENE 1]… markers; x-thread: tweets separated by ---
  sceneCount: z.number().min(1).max(12),
  sceneVisuals: z.array(z.object({ scene: z.number(), want: z.string() })),  // stock-search phrase or 'screen-demo' or 'ai-image: <desc>'
  estDurationSec: z.number(),
  perPlatformCaptions: PerPlatformCaptionsSchema,   // 02 schema; hashtags ≤5 tiktok, ≤3 shorts; YT title ≤90 chars
  aiDisclosure: z.boolean(),              // true if any sceneVisuals uses ai-image or voice presents as a person
});
```

Prompt rules (in `prompts/scriptwriter.ts`, non-negotiable lines): write from the **angle**, never summarize "a viral post"; no phrases from source material; spoken-word register; hook must state a concrete claim/curiosity in ≤2.5 s; end with a loop or a question (platform-tuned); for `estDurationSec` target format's range — for TikTok Rewards the render must exceed 61 s; thread format: 5–8 tweets, first tweet is the hook, no links in tweet 1.

**Similarity guard (code, not prompt):** embed `body`; compare vs embeddings of the trend's member items; compute trigram-shingle overlap vs stored member texts. Fail if cosine > 0.86 or n-gram overlap > 0.25 → one automatic rewrite with feedback appended; second fail → brief `blocked` (`blocked_reason='similarity'`) + TG alert. Store `similarityReport` on the script either way.

Then: insert `scripts` v1 → brief `scripted` → enqueue `factory.compliance` (stage `pre_render`).

## 2. Compliance gate (`factory.compliance`) — blocking, twice

Checks (all recorded in `compliance_checks.results`):

| check | pre_render | pre_publish | Logic |
|---|---|---|---|
| `rights` | ✓ | ✓ | Every asset has `licenseRef` in allowed set (`pexels:*`, `own-recording`, `campaign:<active id>`, `ai-gen:*`); brief's trend rightsClass ≠ red; amber ⇒ format is commentary-class |
| `similarity` | ✓ | — | `scripts.similarityReport.pass === true` |
| `music` | ✓ | ✓ | No asset kind `tts_audio` with meta `{music:true}`; zero third-party audio, full stop (v1 has no music beds; adding licensed beds is a v2 decision) |
| `ai_disclosure` | — | ✓ | If script `aiDisclosure` → post payload sets platform AI flags (06 §2) |
| `category_rules` | ✓ | ✓ | category mode `radar_only` ⇒ hard fail; `human_gated` ⇒ approval may never be auto |
| `platform_policy` | — | ✓ | caption lint: banned-claim keyword list (medical/financial guarantees), politics ⇒ no call-to-vote phrasing on TikTok, hashtag counts, title lengths |

Any fail → brief `blocked` + alert (with failing check detail). Pass at `pre_render` → enqueue asset jobs; pass at `pre_publish` → enqueue `approval.request`.

## 3. Asset production

Fan-out from post-compliance orchestrator step (in the same worker file):

- **`factory.tts`** — narration (hook variant `a` by default; the approved/edited hook re-generates only the hook segment later if changed). `@ve/llm.tts()` → `assets(kind='tts_audio')`, store `durationSec` (probe). Provider: elevenlabs if configured else openai; both stored in meta.
- **`factory.visuals`** — per `sceneVisuals`: `stock-search` → Pexels top vertical result (video preferred, else photo) downloaded → re-uploaded to R2 (`licenseRef pexels:<id>`); `screen-demo` → look up matching upload in `assets` with kind `source_video` + meta `{demo:true}` (human uploads demos via dashboard; if missing → brief `blocked` with reason `needs-demo`, TG ping — this is the designed human touchpoint for the AI category); `ai-image` → Gemini image gen (`ai-gen:gemini`), sets `aiDisclosure` true if not already.
- **`factory.captions`** — transcribe the TTS audio (Groq) for word timestamps → `buildAss` karaoke captions → `assets(kind='captions_ass')`.

All three complete (pg-boss: orchestrator enqueues the three with a shared `groupKey=briefId` and `factory.render` is enqueued by whichever finishes last — implement as a counter in `settings` key `brief_assets_done:<briefId>` under `withTx`, or simpler: `factory.render` job with `startAfter: 2min` retrying until assets exist; choose the counter approach, it's deterministic).

## 4. Render (`factory.render`)

Per target platform variant (from brief.targetPlatforms ∩ format's platforms):

| formatSlug | Renderer (`@ve/media`) | Output |
|---|---|---|
| `faceless-explainer-60s` | `renderSlideshowVo` (Ken Burns over scene visuals, VO, burned captions) | 1080×1920 mp4 |
| `demo-screencast` | `renderScreencastVo` (demo video scaled/cropped, VO ducked over demo audio, captions) | 1080×1920 (tiktok/yt), 1920×1080 (x) |
| `clip-vertical` | `renderClip` (cut + crop/blur-pad + captions) | 1080×1920 |
| `x-thread` / `reddit-discussion` | no render — text only | — |

Flow per render: download assets to tmp → render → probe (duration sanity: within format range ±10%; tiktok variant ≥ 61 s or fail) → `thumbnail` at 1 s → upload both to R2 → `renders.done`. Failures keep `ffmpegLog` tail. When all platform renders done → run `factory.compliance(stage='pre_publish')` → `approval.request`. Also create `posts` rows (status `draft`) per platform now, linking render (or null for text formats), with `captionUsed=null` until publish.

## 5. Clipping pipeline (own long-form + licensed campaigns)

**Ingest:** dashboard upload (doc 10) for `long_forms` (own videos) or campaign source files (`campaigns` + files to `campaigns/{id}/source/`). Both paths enqueue `clip.transcribe`.

- **`clip.transcribe`** — Groq whisper on audio track (extract with ffmpeg `-vn -ac 1 -ar 16000`) → transcript JSON to R2 → status `transcribed` → enqueue `clip.analyze`.
- **`clip.analyze`** — `analyzeVideo` (Gemini, `fps:'low'` for >20 min sources) with the transcript inlined. Prompt: find 5–10 self-contained moments with a strong hook potential; return:

```ts
const ClipMoments = z.object({ moments: z.array(z.object({
  startSec: z.number(), endSec: z.number(),        // 20–90s
  hookScore: z.number(), selfContainedScore: z.number(), emotionScore: z.number(),
  transcriptSlice: z.string().max(500), suggestedHookText: z.string().max(120),
})).max(10) });
```

  → insert `clip_candidates`, status `analyzed`.
- **Promotion:** dashboard lists candidates with scores; selecting "make clip" (or Editor-in-chief auto-promotes top-2 for campaigns) creates a `brief` (`originKind='longform_clip'|'campaign_clip'`, format `clip-vertical`) whose Scriptwriter call only writes captions/hook overlay + per-platform metadata (body = transcriptSlice, similarity guard **skipped** — we own/are licensed for this content; rights check uses `licenseRef 'own-recording'` or `campaign:<id>`).
- **`clip.cut`** — invoked as this brief's render step (same `factory.render` queue, renderer `renderClip`).

**Campaign tracking:** when a campaign-origin post publishes, insert `campaign_clips` row; the human pastes submission status/payout in dashboard (Whop submission stays manual in v1); `campaign_clips.payoutUsd` feeds the Costs/Revenue page.

## 6. Cost accounting

Every step's spend → `llm_usage` (tts minutes, transcribe minutes, video-understand minutes, tokens) via `@ve/llm`; render CPU is free-tier (own VPS). Target checked in tests: full faceless short ≤ $1.00 logged cost with fixture prices.

## 7. Acceptance criteria (Phase 2 gate)

- From a seeded fake trend, `factory.*` produces: script (passing similarity guard), 3 assets, a ≥61 s 1080×1920 mp4 with burned karaoke captions, thumbnail, `posts` drafts — fully offline (fixture connectors, real ffmpeg).
- A script engineered to plagiarize its source gets `blocked` with `similarity` fail.
- A brief in `music` category is impossible to create (editor never sees it; direct API attempt 422s).

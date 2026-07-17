# 04 · Engine 1 — Radar (trend detection)

Purpose: know what's going viral per category, why, and how fast — hours before peak — and hand the Factory rights-safe briefs. Runs 24/7. Everything here is read-only against the outside world.

## 1. Scouts (`scout.reddit|youtube|x|tiktok`)

**Trigger:** `apps/workers` registers a pg-boss **cron per platform** (`*/15 * * * *` tick). The tick handler selects `sources` where `active AND now() - last_scouted_at > scout_interval_min` and enqueues one `scout.<platform>` job per due source (`singletonKey: sourceId` to prevent overlap). Default intervals: reddit 30 min, youtube 60 min, x 60 min, tiktok 360 min (cost-driven; all editable per source in dashboard Settings).

**Per-platform behavior** (connectors from doc 03 §6):

- **Reddit:** `hot` (limit 50) + `rising` (limit 25) for the subreddit. Skip stickied/mod posts.
- **YouTube:** `yt_chart` sources → `mostPopular` for region (50); `yt_channel` → new uploads since last scout + stats refresh for any tracked video <72 h old. Respect the quota ledger (doc 03 §6) — search.list is not used by scouts at all.
- **X:** `searchRecent` with the source query + `since_id` from source-scoped cursor (store in `settings` key `x_cursor:<sourceId>`). Cap `max_results` to keep monthly reads ≤ budget: the tick handler checks month-to-date X spend from `api_usage` and skips X scouts when over `settings.x_monthly_read_cap_usd` (default $80) → TG alert once/day.
- **TikTok:** provider `fetchHashtagTop(tag, 30)` / `fetchCreatorRecent`. Runs 2–4×/day only.

**Normalization + persistence (same code path for all):**

1. Map to `NormalizedItem` → upsert `raw_items` on `(platform, external_id)` (update `title/text/thumbnail` if changed; keep `first_seen_at`).
2. Insert `item_snapshots` row with current metrics (every scout pass ⇒ time series).
3. Filter out items older than 7 days that have no existing row (stale backfill guard).
4. On completion enqueue `radar.score` with the batch of touched `rawItemIds` for that category (`singletonKey: categoryId+quarterHour` merges bursts).
5. Update `sources.last_scouted_at`; log counts.

**Failure:** connector throws → pg-boss retry (3× backoff 1/5/15 min) → dead-letter → `alert.telegram`.

## 2. Scoring (`radar.score`)

Two layers, cheap-first:

**Layer A — statistical (no LLM, every batch):**
- For each raw_item with ≥2 snapshots: `viewsPerHour`, `accel` (2nd derivative over last 3 snapshots), `engagementRate = (likes+comments+shares)/views`.
- Category baseline: rolling 14-day mean/σ of `viewsPerHour` per platform per category (materialized in `settings` key `baseline:<categoryId>:<platform>`, recomputed daily by `costs.rollup`'s sibling step). `velocityScore = (viewsPerHour − mean)/σ`.
- Items with `velocityScore < 1.0` and age > 24 h stop here (no LLM spend). Items already in a `briefed` trend stop here.

**Layer B — LLM rubric (only survivors, batched via `scoreBatch`, Gemini Flash):**

Input per item: title/text (≤600 chars), platform, metrics summary, category. Rubric prompt (in `@ve/llm/prompts/radar-rubric.ts`) returns per item:

```ts
const RubricResult = z.object({
  whyViral: z.string().max(280),
  emotions: z.array(z.string()).max(3),           // 'awe','outrage','humor','curiosity','tribal','fomo'
  formatArchetype: z.enum(['explainer','hot-take','demo','listicle','reaction','news','meme']),
  transferability: z.object({ tiktok: z.number(), youtube: z.number(), x: z.number(), reddit: z.number() }), // 0-100
  longevity: z.enum(['flash','days','evergreen']),
  rightsClass: z.enum(['green','amber','red']),
  rightsNote: z.string().max(200),                // what the third-party material is, if any
  llmScore: z.number().min(0).max(100),           // overall "should we act"
});
```

Rights rubric rules (verbatim in prompt): footage/music owned by leagues, studios, labels, broadcasters, or another creator at the item's core → `red`. A quotable statement/screenshot/statistic where commentary is the value → `amber`. A news event, idea, technique, product, or format executable from scratch → `green`. Category `music` → always `red` (radar-only). When unsure → `red` (bias to safe).

## 3. Clustering (`radar.cluster`)

Goal: one **trend** row per underlying story/meme across platforms.

1. Embed `title + text` (768-d) for newly scored items missing `embedding`.
2. Candidate set: active trends in the category updated <72 h ago (compare against each trend's centroid = mean of member embeddings, cached on the trend row in `settings`-free JSONB — add `centroid` jsonb to `trends` via migration when implementing).
3. Cosine ≥ 0.82 → attach (`trend_members`), update centroid incrementally; else create a new trend seeded with the item's rubric fields (headline/summary via one short LLM call combining top items).
4. Trend fields roll up: `llmScore = max(memberScores)`, `velocityScore = max`, `rightsClass = worst(member classes)` (red beats amber beats green), `transferability = element-wise max`.
5. Expiry: cron inside `radar.cluster` tick — trends with no snapshot growth for 48 h (`flash`) / 7 d (others) → `expired`. `red` trends → `suppressed` immediately after creation (kept for intelligence display).

## 4. Editor-in-chief (`factory.brief`, hourly) — the Radar→Factory handoff

Although it creates Factory rows, the decision logic is documented here because it consumes Radar output.

1. Load active playbook per category + today's remaining cadence budget (posts planned/published today per platform vs `categories.cadence_caps`).
2. Candidate trends: `status='active'`, `rightsClass in ('green','amber')`, `llmScore ≥ 70`, not already briefed.
3. `runStructured` (Claude, agent `editor-in-chief`) with: candidate list (headline, summary, scores, transferability, longevity), playbook markdown, remaining slots, recent posts (avoid topic repetition — last 7 days' brief angles). Output:

```ts
const EditorDecision = z.object({
  decisions: z.array(z.object({
    trendId: z.string(),
    act: z.enum(['brief','skip']),
    reason: z.string().max(200),
    formatSlug: z.enum(Object.keys(FORMATS) as [string, ...string[]]),
    targetPlatforms: z.array(z.enum(PLATFORM)),
    angle: z.string().max(300),                    // the original take — NOT a restatement of the source
  })),
});
```

4. For each `brief` decision: insert `briefs` (status `draft`, link playbook version), set trend `briefed`, enqueue `factory.script`. Amber trends force `targetPlatforms` to formats with commentary (`x-thread`, `faceless-explainer-60s` with quoted-fact framing) — enforced in code, not just prompt.
5. Caps: max briefs/hour = 2 per category (constant), and never exceed remaining daily cadence.

## 5. Digest (`radar.digest`, 08:00 & 20:00 IST)

Compose markdown: top 10 trends per active category (headline, score, velocity, rights chip, links to top member URLs), briefs created since last digest, pending approvals count, yesterday's post performance one-liner. Send via `sendDigest` to the approval chat. Also store to `settings.last_digest_at`.

## 6. Data contracts with other engines

- Factory reads: `trends`, `briefs.angle/formatSlug/targetPlatforms`, trend member items (top 3 URLs + transcript-less summaries only — **never source transcripts**; the Scriptwriter must not see source wording beyond the ≤600-char stored text, which the similarity guard checks against).
- Learning writes back: `playbook_versions` which the Editor-in-chief reads next cycle.
- Dashboard reads: `topTrends` query (02 §7), trend detail (members + snapshot series).

## 7. Acceptance criteria (Phase 1 gate)

- With only Reddit+YouTube credentialed, the system produces scored, clustered trends for `ai-tech` and a twice-daily TG digest, spending $0 on X/TikTok.
- Kill a scout's network (unplug wifi) → jobs retry, dead-letter alert fires, system recovers on reconnect without duplicate raw_items.
- `music` category trends all end `suppressed`; no brief is ever created from them.

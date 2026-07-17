# 06 · Engine 3 — Distribution (scheduling, publishing, engagement)

Purpose: get approved renders live on each platform at the right time, through audited rails, without tripping spam/cadence limits — then work the first hours of engagement.

## 1. Post lifecycle recap

`draft → awaiting_approval → approved → scheduled → publishing → published | failed` (map in 02 §5). Approval flips are owned by doc 09; this doc owns `approved → published`.

## 2. Ayrshare integration (`@ve/connectors/ayrshare.ts`)

- Base `https://api.ayrshare.com/api`, headers `Authorization: Bearer ${AYRSHARE_API_KEY}`, `Profile-Key: ${AYRSHARE_PROFILE_KEY}`.
- **`createPost`** payload (single platform per call — we fan out ourselves for per-platform metadata):

```ts
interface AyrsharePost {
  post: string;                       // caption / text body
  platforms: ['tiktok'|'youtube'|'twitter'|'reddit'];
  mediaUrls?: string[];               // presigned R2 GET (24h TTL)
  scheduleDate?: string;              // ISO; we usually publish immediately at slot time instead
  tikTokOptions?: { autoAddMusic?: false; disableComments?: false; privacyLevel?: 'PUBLIC_TO_EVERYONE'; isAiGenerated?: boolean };
  youTubeOptions?: { title: string; visibility: 'public'; shorts: true; tags?: string[]; madeForKids: false; containsSyntheticMedia?: boolean };
  redditOptions?: { subreddit: string; title: string };
  // twitter: thread via `post` with "\n\n---\n\n" splits? NO — use twitterOptions.thread
  twitterOptions?: { thread?: string[]; };
}
```

  ⚠️ Field names above follow Ayrshare docs as of research date — **verify against current docs at implementation time** and adjust in one place (this module). AI flags: `isAiGenerated` (TikTok) / `containsSyntheticMedia` (YouTube) are set from script `aiDisclosure` (compliance check `ai_disclosure` enforces).
- Response: store `id` → `posts.ayrsharePostId`; `postIds[].postUrl`/`id` when returned → `permalink`/`externalId` (else `publish.verify` fills them from `/history`).
- Errors: 4xx → mark `failed` with `failReason` (no retry — payload bug); 5xx/timeout → pg-boss retry ×3; media-download errors from Ayrshare → regenerate presign (48 h) and retry once.
- `getPostAnalytics(id)` → normalized `{views, likes, comments, shares, watchTimeSec?, avgViewDurationSec?, raw}` for `metrics.snapshot`. `getComments`/`replyComment` back `engage.*` for tiktok/youtube (reddit engagement uses reddit connector directly; X comments read via X API costs — engagement agent on X is reply-to-mentions only from own-account data at $0.001/read).

## 3. Metadata finalization

At approval time the chosen hook may differ from variant `a` (edit flow). `publish.plan` (not the scriptwriter) re-runs a tiny `runStructured` call (`agent: metadata-finalizer`) ONLY if `editInstructions` touched captions; otherwise use `scripts.perPlatformCaptions` as-is. Final payload snapshot → `posts.captionUsed` (audit trail).

## 4. Scheduler (`publish.plan`, daily 00:30 IST + on-approval fast-path)

1. Inputs: approved posts lacking `scheduledFor`; `settings.posting_windows`; category cadence caps; already-scheduled posts.
2. Default windows (IST, from research §08 — Buffer/Sprout 2026 baselines; overridable in Settings):
   - tiktok: 19:00–23:00 daily; also Sat/Sun 09:00–11:00 (A/B flag `tiktok_weekend_am`)
   - youtube (Shorts): 16:00–18:00, best day Fri
   - x: 09:00–12:00 Tue–Thu, plus 1 evening slot 20:00–21:30
   - reddit: subreddit-local mornings — v1 constant 16:30–19:30 IST (≈ 06:00–09:00 ET)
3. Algorithm: for each platform, fill next-day slots (respecting caps, ≥3 h gap between same-platform posts, ±12 min jitter) ordered by trend `peakEstimateAt` then brief age. `flash` longevity trends get the **fast-path**: on approval, if today's cap not exhausted, schedule at `now + 10 min`.
4. Write `scheduledFor`, transition `approved → scheduled`, enqueue `publish.execute` with `startAfter: scheduledFor`.

## 5. Publish (`publish.execute` → `publish.verify`)

`publish.execute(postId)`:
1. Guards: kill-switch off; post still `scheduled`; approval still `approved|auto_approved`; compliance `pre_publish` pass exists; category still active. Any guard fail → revert to `approved` (or `draft`) with alert.
2. Transition `scheduled → publishing` (this is the idempotency lock — pg-boss `singletonKey: postId`).
3. Presign media, call Ayrshare (or `x.postText` for a text-only X post if we ever bypass — default: everything via Ayrshare).
4. Success → `published`, `publishedAt=now`, store ids; enqueue `publish.verify` (+10 min), `engage.scan` schedule note, `metrics.snapshot` at +3 h and +24 h (pg-boss `startAfter`).
5. Failure → `failed`; retryable failures re-enqueue `publish.execute` once at +20 min (`retryCount` guard ≤2), else alert.

`publish.verify(postId)`: fetch `/history` for ayrsharePostId; confirm live + fill `permalink`/`externalId`; if Ayrshare reports platform rejection → `failed` + alert with platform error verbatim (these are the policy-feedback signals worth reading).

## 6. Engagement agent (`engage.scan` every 20 min for posts <3 h old; `engage.reply` gated)

- `engage.scan`: pull comments (Ayrshare `getComments` for tiktok/youtube; reddit connector for reddit; X: own-mentions timeline). Upsert `engagements`. Classify each new comment cheaply (Gemini batch): `{kind: 'question'|'praise'|'criticism'|'spam'|'other', needsHuman: boolean, draftReply?: string}`. Questions with confident answers + praise get `draftReply`.
- `engage.reply`: sends drafts **only if** `settings.engage_auto_reply=true` for the category AND comment kind ∈ {praise, simple-question} — else surfaces in dashboard + TG thread for manual copy. Never reply to criticism/controversy automatically. Cap 10 auto-replies/post. Log `repliedText/At`.
- X reply weighting rationale in research §08 — replies drive ranking; the human should personally reply on X in hour one when possible (digest reminds).

## 7. Cadence & anti-spam rails (hard, in code)

- Per-platform daily caps from `categories.cadence_caps` — `publish.plan` cannot exceed; `publish.execute` re-checks at fire time.
- Min gaps: same platform ≥3 h; same trend across platforms — stagger ≥30 min (TikTok first by default, per playbook).
- Account warm-up mode: `settings.warmup_until` (date per platform) → caps forced to 1/day until then.
- No engagement buying, no follow/unfollow automation, no cross-post watermarks (`renders` are always platform-clean) — these are invariants, not settings.

## 8. Acceptance criteria (Phase 3 gate)

- Approved fixture post publishes to a **mock Ayrshare server** (tests spin a Hono stub) at its slot ±jitter, transitions land `published`, verify fills permalink.
- Kill-switch flipped mid-flight: `publish.execute` refuses, post returns to `approved`, alert sent.
- Cadence: attempt to schedule 3 tiktok posts same category/day with cap 2 → third lands next day.
- With real credentials (manual smoke): one end-to-end short reaches TikTok as `PUBLIC_TO_EVERYONE` with AI flag set when applicable.

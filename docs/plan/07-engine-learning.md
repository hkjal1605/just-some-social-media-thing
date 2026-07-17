# 07 · Engine 4 — Learning loop (metrics → attribution → playbooks)

Purpose: close the loop — measure every post, learn which features drive performance, and rewrite the per-category playbooks that the Editor-in-chief, Scriptwriter, and Scheduler read.

## 1. Metrics collection (`metrics.snapshot`)

Schedule per post: **+3 h**, **+24 h** after publish (enqueued by `publish.execute` with `startAfter`), then the **daily 06:00 IST cron** snapshots every post published in the last 30 days (after 30 days: weekly until 90 days, then stop).

Per platform source:
- tiktok/youtube/reddit → Ayrshare `getPostAnalytics` (normalized in doc 06 §2).
- x → `getOwnPostsMetrics` (owned reads, $0.001/post — log to `api_usage`).

Write `post_snapshots` with the full raw payload preserved (`raw` jsonb) — future re-analysis is free, re-fetching isn't. Derived convenience fields updated on the fly: none on `posts` (always compute from snapshots; avoids drift).

Quality guards: snapshot values must be monotonically non-decreasing for views (platform corrections happen — if a value drops >5%, keep it but flag `raw._anomaly=true`); missing analytics (Ayrshare 404 soon after publish) → retry next cycle silently ×3 then alert.

## 2. Attribution (`learn.attribute`, Mondays 07:00 IST)

Input window: posts with ≥7 days of data, last 8 weeks, per category.

**Feature vector per post** (assembled in SQL + code, stored in the report artifact, not a table):
`platform, formatSlug, hookVariantChosen, hookTextLength, estDurationSec, actualDurationSec, sceneCount, emotions[], formatArchetype, publishHourLocal, publishDow, timeFromTrendDetectionToPublishMin, categorySlug, aiDisclosure, trendLlmScore, trendVelocityScore` → outcomes: `views@24h, views@7d, engagementRate@7d, (tiktok) avgViewDurationSec`.

**Analysis (deterministic + LLM narrative):**
1. Code computes: medians by feature bucket, top/bottom decile posts, Spearman correlations for numeric features, and week-over-week deltas. Small-n honesty: buckets with n<5 are marked `insufficient`.
2. `runStructured` (Claude, agent `performance-analyst`) receives the computed tables (never raw guesswork) and returns:

```ts
const AttributionReport = z.object({
  headline: z.string(),
  wins: z.array(z.object({ finding: z.string(), evidence: z.string(), confidence: z.enum(['strong','tentative']) })),
  losses: z.array(z.object({ finding: z.string(), evidence: z.string() })),
  playbookEdits: z.array(z.object({ categorySlug: z.string(), section: z.string(), edit: z.string(), rationale: z.string() })),
  killList: z.array(z.object({ categorySlug: z.string(), formatSlug: z.string(), reason: z.string() })),  // 3 weeks below category median
  experiments: z.array(z.object({ hypothesis: z.string(), change: z.string(), metric: z.string() })).max(3),
});
```

Report markdown stored to R2 (`reports/attribution/{date}.md`) + linked in weekly digest.

## 3. Playbook update (`playbook.update`, right after attribute)

- Playbook = per-category markdown with fixed sections: `# Voice`, `# Hooks that work`, `# Formats`, `# Timing`, `# Hashtags/keywords`, `# Kill list`, `# Experiments running`.
- Job applies `playbookEdits`/`killList`/`experiments` to the latest version via `runStructured` (agent `playbook-editor`; input = current markdown + edits; output = full new markdown, ≤ 1,500 words) → insert `playbook_versions` (version+1, `createdBy:'system'`, `approvedAt: null`).
- **Human review:** dashboard Playbooks page diffs latest vs previous; approve sets `approvedAt`. The Editor-in-chief uses the latest **approved** version; unapproved drafts >7 days old alert.
- Kill list enforcement is mechanical: Editor-in-chief candidate filter excludes killed `(category, format)` pairs; auto-approve flags (doc 09 §5) are revoked for killed formats.

## 4. Weekly digest (`learn.attribute` tail step)

TG message: headline, 3 wins, 3 losses, spend vs budget (MTD from `costs.rollup`), revenue entered (campaign payouts + any platform payouts recorded manually in Settings), threshold progress per platform (followers/subs entered manually monthly in Settings — v1 doesn't scrape own follower counts except what Ayrshare analytics returns), links: dashboard, playbook diffs awaiting approval.

## 5. Threshold tracker

`settings.threshold_progress` jsonb — `{ tiktok: {followers, views30d}, youtube: {subs, shortsViews90d, watchHours12mo}, x: {verifiedFollowers, impressions3mo}, updatedAt }`. Updated: automatically where Ayrshare analytics exposes it, else manual monthly entry via dashboard Settings. Dashboard Overview renders progress bars toward the monetization gates (constants from research: 10k/100k TikTok; 500/3k-hrs & 1k/10M YT tiers; X 5M/500).

## 6. Acceptance criteria (Phase 4 gate)

- After seeding 60 fixture posts with synthetic snapshot curves, `learn.attribute` produces a report whose deterministic tables match hand-computed values; playbook v2 draft appears with a visible diff in dashboard; approving it makes the next `factory.brief` run read v2 (assert via agent_runs input hash or log).
- A format 3 weeks under median lands on the kill list and stops being chosen.

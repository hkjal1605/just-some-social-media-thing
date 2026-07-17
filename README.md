# Viral Engine

24/7 AI-agent system: detects viral trends per category across Reddit, X, TikTok and YouTube, produces **original** platform-native content with LLMs, publishes on schedule after Telegram/dashboard approval, and learns from its own analytics. Monorepo: Bun + Hono + TypeScript + Postgres + R2.

- **Why this design (and why not verbatim reposting):** [`INITIAL_RESEARCH.md`](INITIAL_RESEARCH.md) — adversarially verified feasibility study, 12 Jul 2026.
- **Implementation plan (start here to build):** [`docs/plan/00-overview.md`](docs/plan/00-overview.md) — canonical registry + index of all 13 plan docs.
- **Build order:** [`docs/plan/13-build-order-and-testing.md`](docs/plan/13-build-order-and-testing.md) — Phase 0 → 5 with acceptance gates.

Hard rules baked into the plans: no third-party footage/music ever ships; TikTok/YouTube publish via Ayrshare (audited apps); politics is human-gated forever; music is radar-only; every post passes the compliance gate and an approval until a format earns auto-approve.

## Status

**Implemented — docs 00–07 end to end** (Phase 0 skeleton, all shared-package contracts, Engine 1 · Radar, Engine 2 · Factory, Engine 3 · Distribution, Engine 4 · Learning):

- Monorepo tooling (doc 01): Bun workspaces, Biome, `tsc -b` graph, docker-compose (PG16 + MinIO), `.env.example`, CI.
- Database (doc 02): full 27-table Drizzle schema (+ `trends.centroid`, doc 04 §3), committed migrations, state-machine transition helpers (`FOR UPDATE`, invalid transitions throw), doc §7 queries, idempotent seed (5 categories · 15 ai-tech sources · 12 policy pages · admin user).
- Shared packages (doc 03): `@ve/config` `@ve/core` `@ve/db` `@ve/storage` `@ve/llm` `@ve/connectors` `@ve/telegram` `@ve/media` — every contract function, fixture mode for all connectors, metering to `llm_usage`/`api_usage`/`agent_runs`, karaoke-ASS + FFmpeg render pipeline with bundled OFL fonts.
- **Engine 1 · Radar (doc 04)**: scout cron tick (per-platform, singleton per source, X read-cap gate with once/day alert) → normalize/upsert/snapshots → two-layer scoring (velocity z-scores vs settings-materialized baselines + Gemini rubric with the verbatim rights rules; music force-red in code) → embedding clustering (attach ≥0.82 to live centroids, batch-internal, headline agent, red → suppressed, worst-of rights rollups) → Editor-in-chief (llmScore ≥ 70, 2 briefs/hr cap, cadence budget, amber → commentary formats in code, enqueues `factory.script`) → twice-daily digest. Harness: `registerWorker` (payload zod + kill-switch gate + final-retry alerts), `alert.telegram` consumer with 1 h dedupe, 7 IST cron schedules.
- **Engine 2 · Factory (doc 05)**: Scriptwriter (sees the trend's idea, never source texts) + the code-level similarity guard (embedding cosine ≤0.86 + trigram containment ≤0.25, one automatic rewrite, then brief `blocked` + alert) → blocking compliance gate at pre_render and pre_publish (rights/licenseRef allowlist, similarity, music-zero-tolerance, AI-disclosure consistency, category rules, caption lint) → asset fan-out (ElevenLabs/OpenAI TTS, Pexels stock video-preferred, Gemini `ai-image` scenes, Groq-timed karaoke captions; deterministic 3-job settings counter; missing screen-demo → `needs-demo` block) → per-platform FFmpeg renders (slideshow/screencast/clip, duration sanity ±10% with the 61s TikTok floor, thumbnails, posts drafts) → `approval.request`. Clipping pipeline: transcribe (audio extract → whisper JSON in R2) → analyze (20–90s self-contained moments) → promote to `clip-vertical` brief (guard skipped, transcript slice as body) → cut with transcript-sliced captions.
- **Approvals bridge (doc 09 §1 worker)**: consumes the factory's `approval.request`; **auto-approve fast-path** for `full_auto_candidate` categories whose format earned it (posts → approved, enqueues `publish.plan` fast-path) vs **human-gated parking** (pending `approvals` row + posts → awaiting_approval + events + alert). `human_gated`/`radar_only` can never auto-approve (code guard). The Telegram/dashboard decision surface is doc 09.
- **Engine 3 · Distribution (doc 06)**: scheduler (`publish.plan`: per-(category,platform) lanes, cadence caps, ≥3 h same-lane gaps, ±12 min deterministic jitter, flash fast-path, warm-up cap, cross-brief ≥30 min stagger, IST posting-window grid) → `publish.execute` (guards: kill-switch/approval/compliance/active → revert-to-approved + alert; `scheduled→publishing` lock; per-platform Ayrshare payload with `isAiGenerated`/`containsSyntheticMedia` flags; 4xx → fail-no-retry, 5xx/network → retry-once-at-+20m) → `publish.verify` (permalink/externalId from `/history`, platform-rejection → fail) → engagement (`engage.scan` upserts + Gemini-batch `comment-classifier`, `engage.reply` gated auto-reply, cap 10/post, criticism always human). The Ayrshare connector has a base-URL test seam so the mock-server test drives the **real** connector.
- **Engine 4 · Learning (doc 07)**: `metrics.snapshot` (+3 h/+24 h then daily-30 d / weekly-90 d sweep, monotonic-views guard with `_anomaly` flag, missing-analytics ×3-then-alert) → `learn.attribute` (per-post feature vectors; **deterministic** tables — bucket medians, Spearman correlations, top/bottom deciles, week-over-week deltas — handed to the `performance-analyst` agent; report md + json to R2) → `playbook.update` (`playbook-editor` agent → unapproved per-category draft; **mechanical kill list** in `settings.kill_list` that the Editor-in-chief reads and excludes; auto-approve revoked for killed formats) → weekly TG digest (spend vs budget, revenue, monetization-threshold progress) + threshold tracker.
- API: session+token auth; trends inventory; `POST /briefs` (music/radar-only → 422, red → 422, amber → commentary-only), `GET /briefs/:id` lineage; `POST /longforms` (+presigned PUT) / `ingest` / detail; `POST /clip-candidates/:id/promote` — all live-curled.
- Apps: `api`, `workers` (radar + factory + distribution + learning engines live; 22 cron/queue workers, 11 IST schedules), `bot` (idles without token), `dashboard` shell.

Try it offline (no credentials needed): `bun run scripts/radar-demo.ts && bun run scripts/factory-demo.ts` produce a real ≥61s 1080×1920 captioned mp4 in MinIO; then `bun run scripts/distribution-demo.ts` drives approve → schedule (flash fast-path) → publish to an in-memory Ayrshare → verify → snapshot → attribution → kill list → playbook draft (auto-approve revoked) — the whole of docs 06–07, no network.

**Next:** remaining harness (doc 08: budget guard, policy watch, costs rollup, ops endpoints), approvals/Telegram e2e surface (doc 09: grammY bot + `/decide` API + edit/reject/expiry flows), dashboard pages (doc 10), full API (doc 11), deploy (doc 12).

## Dev quickstart (doc 01 §7)

Prereqs: Bun ≥ 1.2 · Docker (or native Postgres 16+) · FFmpeg ≥ 6 **with libass** (`ffmpeg -filters | grep subtitles`; on macOS Homebrew ≥ 6 that's `brew install ffmpeg-full` — the slim `ffmpeg` formula lacks libass).

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres + minio
cp .env.example .env                             # fill what you have; optional keys stay empty
bun install
bun run db:migrate && bun run db:seed
bun run dev            # api :3000 · dashboard :5173 (proxies /api) · workers · bot
```

Without Docker: any Postgres 16+ with role `ve`/`ve` and databases `viral_engine` + `viral_engine_test` works. Storage falls back cleanly in dev (healthz reports it); tests use an in-memory storage stub.

Checks: `bun run lint` · `bun run typecheck` · `bun test` · `bun run db:check` · `bun run build:dashboard` (CI runs all five).

## Layout

```
apps/        api · workers · bot · dashboard
packages/    config · core · db · storage · llm · connectors · telegram · media
docs/plan/   the 14 plan documents (00 = canonical registry)
```

Package scope is `@ve/*`; apps import packages with `workspace:*`; no app imports another app; `@ve/core` depends on nothing internal. Doc 00 §5's registry (queue names, enums, key conventions) is the single source of truth — if code and a doc disagree, doc 00 wins.

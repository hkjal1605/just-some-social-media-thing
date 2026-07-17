# 10 · Dashboard (apps/dashboard)

Single-admin SPA: see everything (trends, posts, stats, approvals, costs), control the few knobs that matter. Vite + React 19 + TanStack Router/Query + Tailwind v4 + Recharts. Served in prod by `apps/api` from `apps/dashboard/dist`; in dev on :5173 with `/api` proxy.

## 1. Auth

- `/login` — password field → `POST /api/v1/auth/login` → httpOnly session cookie (30 d). All other routes redirect to `/login` on 401 (TanStack Query global error handler).
- No multi-user, no roles in v1 (`admin_users` supports more later).

## 2. Shell

Left sidebar: **Overview · Trends · Posts · Approvals · Calendar · Clips · Playbooks · Costs · Settings** + kill-switch indicator (red banner across the top when ON, click → Settings). Header: category filter (global, persisted in URL search params), date-range picker where applicable. Polling: TanStack Query `refetchInterval` 30 s (approvals 15 s). Times display in `DISPLAY_TZ`; tooltips show UTC.

## 3. Pages

### 3.1 Overview
- KPI tiles (from `GET /dashboard/kpis`): Posts published 7d · Views 7d (sum latest snapshots) · Pending approvals · Spend MTD vs budget (progress) · Top post 7d (thumbnail + views, links to detail).
- Charts: **Views over time by platform** (daily sum of snapshot deltas, line, last 30 d); **Posts by status** (stacked bar per day); **Spend by service** (MTD, bar).
- Monetization threshold progress bars (doc 07 §5): TikTok followers/views-30d, YT subs + Shorts-views-90d + watch-hours, X impressions-3mo/verified followers — each vs its gate constant, with "manual update" affordance when data is manually entered.
- Ops widget: workers heartbeat, DLQ count, oldest pending approval, last cron runs (from `GET /ops/summary`).

### 3.2 Trends
- Table (from `GET /trends?category=&status=`): headline · category chip · rights chip (green/amber/red) · llmScore · velocity sparkline (item_snapshots aggregate) · platforms seen on (icons) · age · status.
- Row click → drawer: summary, whyViral, emotions, transferability bars, member items (thumbnail, platform, link, latest metrics), snapshot chart, and actions: **Create brief** (manual override → `POST /briefs` with format/platform pickers), **Suppress**.
- `suppressed` (red) trends visible under a filter — the intelligence is shown even though publishing is blocked.

### 3.3 Posts
- Filterable table (`GET /posts?platform=&status=&category=&q=`): thumbnail · platform icon · category · title/hook (truncated) · status chip · scheduled/published time · latest views/likes/comments/shares (tabular-nums) · campaign badge if campaign-origin.
- Detail page `posts/:id`: render player (presigned), permalink out, full caption per platform as sent (`captionUsed`), status timeline (from events/timestamps), **metrics chart** (views/likes/comments over snapshots — the core "did it work" view), engagement list (comments + our replies, needsHuman flagged rows actionable: reply box → `POST /engagements/:id/reply`), source trend link, script + brief lineage, cost breakdown for this brief (`agent_runs`/`llm_usage` filtered).
- Actions: retry failed (`POST /posts/:id/retry`), delete/unschedule.

### 3.4 Approvals — parity spec in doc 09 §4.

### 3.5 Calendar
- Week grid by platform rows: scheduled + published posts as chips at their slot times; drag to reslot (`PATCH /posts/:id {scheduledFor}` — validates caps/gaps server-side); shows remaining daily cap per platform/category.

### 3.6 Clips
- Long-forms: upload (multipart → `POST /longforms` returns presigned PUT; client uploads direct to R2; then `POST /longforms/:id/ingest`), list with status; detail: candidate moments table (scores, transcript slice, preview via `renderClip` on-demand? v1: no preview render — show transcript + timestamps) with **Promote to brief** buttons.
- Campaigns: CRUD (`/campaigns`), fields from 02 schema; per-campaign clip list (posts, views latest, submittedUrl paste field, payout entry) — revenue rolls to Costs page.

### 3.7 Playbooks
- Per category: current approved version rendered; **pending draft diff** view (old/new markdown side-by-side with changed-line highlighting — plain LCS diff util, no heavy dep); Approve button (`POST /playbooks/:id/approve`); version history list.

### 3.8 Costs
- MTD spend by service (llm_usage + api_usage grouped), daily trend line, per-agent table (agent_runs aggregates: calls, tokens, cost, p95 duration), revenue section (campaign payouts + manual platform-payout entries via Settings) → simple P&L line: revenue − spend.

### 3.9 Settings
- Categories: mode, cadence caps, auto-approve formats (chips with revoke), active toggle.
- Sources: CRUD per category/platform (kind/value/interval/active), "scout now" button (`POST /sources/:id/scout`).
- Posting windows editor (per platform, IST ranges) → `settings.posting_windows`.
- Integrations status panel (read-only from env flags + last success per connector).
- Threshold progress manual entry (doc 07 §5).
- Toggles: kill-switch (with reason display), engage_auto_reply per category, `tiktok_weekend_am` A/B flag, X monthly read cap USD, budget.
- Danger zone: none in v1 (no destructive ops from UI beyond post delete).

## 4. Frontend conventions

- Data layer: one `api.ts` fetch wrapper (credentials include, JSON, throws typed `ApiError`); TanStack Query keys `['posts', filters]` etc.; zod-parse responses with schemas imported from `@ve/core` (shared types — the dashboard depends on `@ve/core` only, never `@ve/db`).
- Components: shadcn-style hand-rolled primitives (Button, Card, Table, Dialog, Badge, Tabs) — no heavy UI kit; charts via Recharts with a tiny wrapper enforcing: single hue for single-series, status colors only for status, direct labels for ≤4 series, `tabular-nums` ticks.
- Status chips color map matches `POST_STATUS`/`RIGHTS_CLASS` semantics (green published/good, amber pending/warn, red failed/critical, gray draft).
- Empty states everywhere ("No trends yet — scouts run every 30 min").
- No SSR, no auth-gated code-splitting complexity; keep bundle < 500 KB gz.

## 5. Acceptance criteria

- With seeded fixture data and no external creds: every page renders with data; approvals decide; calendar reslots respect caps (server 422 surfaces as toast); playbook diff approves; kill-switch toggles and the banner reflects within 30 s.
- Lighthouse (desktop) ≥ 90 performance on Overview with 1k posts seeded.

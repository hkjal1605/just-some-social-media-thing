# 08 · Harness — queue, cron, agent runner, safety rails

The substrate every engine runs on. Lives in `apps/workers` + `@ve/db/boss.ts` + `@ve/llm`. Patterns deliberately borrowed from the Hermes harness (cron-native jobs, self-improving skill files ⇒ our playbooks, chat gateway ⇒ our TG bot) and from this research's doc §06.

## 1. Process model

- **`apps/api`** — HTTP only. Enqueues jobs (send-only pg-boss). Never runs jobs.
- **`apps/workers`** — single Bun process: `boss.start()`, registers **all** queue workers + cron schedules. CPU-heavy renders capped by `teamSize` so they can't starve the rest (render `teamSize: 1`, scouts 4, llm-agents 3, publish 2, metrics 4).
- **`apps/bot`** — grammY long-polling + send helpers. No pg-boss workers (it enqueues via API calls with `ADMIN_API_TOKEN` — keeps bot decoupled from DB writes except through the API, one write path).

Graceful shutdown: SIGTERM → `boss.stop({ graceful: true, timeout: 30s })`, in-flight render allowed to finish or die (job retries).

## 2. Worker registration pattern (`apps/workers/src/index.ts`)

```ts
import { Q, ScoutPayload /*…*/ } from '@ve/core/queues';
const worker = <T>(queue: string, schema: z.ZodType<T>, opts: WorkOptions, fn: (data: T, job: Job) => Promise<void>) =>
  boss.work(queue, opts, async ([job]) => {
    const log = makeLogger('workers').child({ queue, jobId: job.id });
    const data = schema.parse(job.data);
    if (await killSwitchBlocks(queue)) { log.warn('kill-switch: requeued'); throw new RetryLater(15 * 60); }
    try { await fn(data, job); }
    catch (e) { log.error({ err: e }); if (job.retryCount >= (opts.retryLimit ?? 3) - 1) await enqueueAlert(queue, job, e); throw e; }
  });
```

Defaults: `retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900` (renders: 1800). Dead-lettered jobs (pg-boss `__dlq`) surfaced on dashboard Ops widget.

## 3. Cron table (registered via `boss.schedule(queue, cron, data, { tz: 'Asia/Kolkata' })`)

| Cron (IST) | Queue |
|---|---|
| `*/15 * * * *` | scout tick (enqueues due `scout.*`) |
| `7,37 * * * *` | `radar.cluster` maintenance tick (expiry) |
| `0 * * * *` | `factory.brief` |
| `30 * * * *` | `approval.remind` |
| `0 8,20 * * *` | `radar.digest` |
| `30 0 * * *` | `publish.plan` |
| `*/20 * * * *` | `engage.scan` tick (posts <3 h) |
| `0 6 * * *` | `metrics.snapshot` daily sweep |
| `0 5 * * *` | `costs.rollup` (+ baseline recompute) |
| `0 7 * * 1` | `learn.attribute` → `playbook.update` |
| `0 9 1 * *` | `policy.watch` |

## 4. Agent runner

`@ve/llm.runStructured` is the agent primitive (doc 03 §5): system prompt + user content + zod output schema via a forced tool call; invalid output → re-prompt with the zod error (≤2 retries) → throw. Every call records `agent_runs` + `llm_usage`. **No open-ended tool loops in v1** — each agent is a single structured call with code-assembled context. (If an agent later needs tools — e.g., a research agent — extend `runStructured` with a tool registry; do not hand-roll loops per agent.)

Agents inventory (prompt files in `@ve/llm/prompts/`): `radar-rubric`, `trend-headline`, `editor-in-chief`, `scriptwriter`, `metadata-finalizer`, `clip-analyzer` (video), `comment-classifier`, `performance-analyst`, `playbook-editor`, `policy-differ`.

## 5. Settings & flags (DB `settings`, cached)

`getSetting(key)` with 30 s in-process TTL cache; `setSetting` via API only. Keys registry: `kill_switch, posting_windows, x_monthly_read_cap_usd, engage_auto_reply, warmup_until, budget_state, integrations_status, threshold_progress, baseline:*, x_cursor:*, youtube_quota, brief_assets_done:*, last_digest_at`.

## 6. Kill-switch

`killSwitchBlocks(queue)` → true when `kill_switch=true` AND queue ∈ {`publish.*`, `engage.reply`, `approval.request`, `factory.*`}. Radar + metrics keep running (eyes stay open). Toggles: dashboard Settings, TG `/kill` + `/resume` (admin-only), automatic at 100% budget (below).

## 7. Budget guard (`costs.rollup`, daily)

Sum month-to-date `llm_usage.costUsd + api_usage.costUsd` → `settings.budget_state`. ≥80% of `COST_BUDGET_MONTHLY_USD` → TG warning (once per threshold crossing). ≥100% → set kill-switch with reason `budget` + alert. Also writes the daily per-service rollup consumed by dashboard Costs.

## 8. Policy watch (`policy.watch`, monthly)

For each `policy_pages` row: fetch (plain GET, UA browser-ish; ScrapingBee-style fallback NOT included — if fetch blocked, mark `fetch_blocked` and include in report), strip HTML → text, sha256. Hash changed → `runStructured` (agent `policy-differ`, input old/new text extracts ≤8k chars each) → `lastDiffSummary` + TG alert: "⚠️ {name} changed: {summary}". The 12 seeded URLs are in doc 02 §6. This is the system watching the rules that govern it.

## 9. Ops alerts (`alert.telegram`)

`enqueueAlert()` used by every final-failure path; worker posts to `TELEGRAM_ALERT_CHAT_ID` with dedupe (same alert key ≤1/hour, `settings`-backed). Alert format: `🔥 {queue} failed | {entityKind}:{entityId} | {error.head(300)} | dashboard link`.

## 10. Job observability

- `agent_runs` covers LLM steps. For non-LLM jobs, pg-boss's own `job` tables + a thin `jobs_recent` view (id, name, state, retrycount, started/completed) exposed at `/api/v1/ops/jobs`.
- Dashboard Ops widget: DLQ count, oldest pending approval age, queue depths, last cron firings (from `boss.getSchedules()` + last job per cron queue).
- `/healthz` (api): checks db, boss (send-only), R2 HEAD bucket. Workers heartbeat: `settings.workers_heartbeat=now()` every 60 s; api healthz flags stale >5 min.

## 11. Idempotency ledger (recap of every mutation-with-retry)

| Job | Guard |
|---|---|
| scouts | upsert `(platform, external_id)`; `singletonKey: sourceId` |
| radar.score/cluster | pure recompute; `singletonKey: categoryId+bucket` |
| factory.script | skip if script v(N) exists for brief status |
| factory.tts/visuals/captions | skip if asset kind exists for brief |
| factory.render | skip if render (brief, platform) `done`; re-render replaces row |
| approval.request | skip if approval exists non-expired |
| publish.execute | status lock `scheduled→publishing` + `singletonKey: postId` |
| metrics.snapshot | natural dedupe by capturedAt granularity (skip if snapshot <2 h old exists for the scheduled kinds) |

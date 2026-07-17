# 11 · API (apps/api) — Hono on Bun

One Hono app: REST for dashboard + bot, static dashboard serving in prod, health. No business logic here — routes validate (zod), call `@ve/db` queries/transitions or enqueue jobs, return JSON. Anything long-running is a queue job.

## 1. Bootstrap

```ts
const app = new Hono()
  .use('*', requestId(), pinoLogger(), cors({ origin: env.APP_ENV==='development' ? 'http://localhost:5173' : env.APP_BASE_URL, credentials: true }))
  .route('/api/v1', apiV1)
  .get('/healthz', healthz)
  .use('*', serveStatic({ root: './apps/dashboard/dist' }))       // prod SPA + fallback to index.html
Bun.serve({ port: env.API_PORT, fetch: app.fetch });
boss.startSendOnly();
```

## 2. Auth middleware

- `sessionAuth`: cookie `ve_session` → `sessions` lookup (expiry checked) → `c.set('admin', …)`.
- `tokenAuth`: `Authorization: Bearer ADMIN_API_TOKEN` (constant-time compare) — used by bot + any CLI.
- `auth = either(sessionAuth, tokenAuth)` on everything except `/auth/login`, `/healthz`.
- Login rate-limit: 5/min/IP (in-memory bucket). `POST /auth/login {password}` → verify against `admin_users.password_hash` (Bun.password.verify) → create session. `POST /auth/logout`.

## 3. Route inventory (all under `/api/v1`, JSON, zod-validated)

| Method + path | Purpose / notes |
|---|---|
| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` | session |
| `GET /dashboard/kpis` | 02 §7 `dashboardKpis` |
| `GET /trends` `?category&status&limit&cursor` | list w/ member aggregates |
| `GET /trends/:id` | detail + members + snapshot series |
| `POST /trends/:id/suppress` | manual suppress |
| `POST /briefs` `{trendId, formatSlug, targetPlatforms, angle?}` | manual brief (angle optional → editor agent fills) |
| `GET /briefs/:id` | lineage view (script versions, assets, renders, compliance, approval, posts) |
| `GET /approvals` `?status` · `GET /approvals/:id` · `GET /approvals/:id/card` | doc 09 §3 |
| `POST /approvals/:id/decide` | the transactional decision (doc 09) |
| `POST /approvals/:id/tg-message` | store card message id |
| `GET /posts` filters + cursor pagination · `GET /posts/:id` | lists use `postsWithLatestMetrics` |
| `GET /posts/:id/metrics` | snapshot series |
| `PATCH /posts/:id` `{scheduledFor}` | reslot — validates caps/gaps, 422 on violation |
| `POST /posts/:id/retry` | failed → scheduled (+enqueue) |
| `DELETE /posts/:id` | draft/scheduled only → deleted |
| `GET /engagements?needsHuman=1` · `POST /engagements/:id/reply {text}` | manual replies (enqueues `engage.reply` single) |
| `POST /longforms` `{title, categoryId, bytes, mime}` → `{id, presignedPut}` | client uploads straight to R2 |
| `POST /longforms/:id/ingest` | after upload → enqueue `clip.transcribe` |
| `GET /longforms` / `GET /longforms/:id` | + clip candidates |
| `POST /clip-candidates/:id/promote` `{targetPlatforms}` | → brief (originKind longform/campaign) |
| `GET/POST/PATCH /campaigns` · `POST /campaign-clips/:id` `{submittedUrl?, payoutUsd?}` | clipping revenue tracking |
| `GET /playbooks?category` · `GET /playbooks/:id/diff` · `POST /playbooks/:id/approve` | doc 07 §3 |
| `GET /costs?month` | rollups by service + per-agent table + revenue |
| `GET/POST/PATCH/DELETE /categories` · `/sources` (+ `POST /sources/:id/scout`) | settings CRUD (scout → enqueue) |
| `GET /settings` · `PUT /settings/:key` | whitelisted keys only (posting_windows, engage_auto_reply, x_monthly_read_cap_usd, threshold_progress, warmup_until, budget) |
| `PUT /settings/kill-switch` `{on, reason?}` | also fires TG alert |
| `GET /ops/summary` | heartbeat, DLQ count, queue depths, last crons, pendingApprovals, spendMtd, killSwitch, postsToday |
| `GET /ops/jobs?state=failed` | recent pg-boss jobs (read-only) |
| `GET /assets/presign?key=` | presigned GET for dashboard previews (validates key prefix ∈ known namespaces) |

Conventions: cursor pagination `{items, nextCursor}`; errors `{error: {code, message}}` with proper status; every mutating route writes an `approval_events`-style audit where applicable and logs `{route, admin, entityId}`.

## 4. Webhooks (optional/v2)

- `POST /api/v1/tg/webhook` — grammY `webhookCallback` behind `X-Telegram-Bot-Api-Secret-Token` check (doc 09 §2 note). Disabled while long-polling runs.
- Ayrshare webhooks: not relied on in v1 (polling covers). If enabled later: `POST /api/v1/ayrshare/webhook` for post-status transitions, HMAC-verified per their docs.

## 5. SSE (v2 note)

Dashboard uses polling in v1. If it ever feels laggy: `GET /api/v1/events` (Hono `streamSSE`) emitting `approval.created|decided`, `post.published`, `killswitch.changed` from a Postgres `LISTEN/NOTIFY` bridge. Do not build in v1.

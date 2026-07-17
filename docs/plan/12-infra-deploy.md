# 12 · Infra & deployment

Philosophy: one VPS, three Bun processes, managed Postgres optional, R2 for bytes. No Kubernetes, no autoscaling — pg-boss `teamSize` is the concurrency knob. Total infra ≤ ~$45/mo (research budget line).

## 1. Environments

| Env | DB | Storage | Processes | Secrets |
|---|---|---|---|---|
| development | docker Postgres | MinIO | `bun run dev` (4 procs) | `.env` |
| test (CI) | CI Postgres service | in-memory storage stub | test runner | `.env.test` (fixture keys) |
| production | VPS Postgres (same box, tuned) or managed PG16 | R2 | systemd: `ve-api`, `ve-workers`, `ve-bot` | `/etc/viral-engine/.env` (root:ve 640) |

## 2. Production VPS (Hetzner CX32 / DO 4GB+ class; needs ffmpeg CPU headroom)

Provisioning checklist (script `infra/provision.sh`, idempotent):
1. Debian 12; create user `ve`; UFW allow 22/80/443; unattended-upgrades on.
2. Install: bun, ffmpeg (with libass — check `ffmpeg -version` & `subtitles` filter), postgresql-16 (local option: `shared_buffers=512MB`, `max_connections=60`), caddy.
3. Clone repo to `/opt/viral-engine`; `bun install --frozen-lockfile`; `bun run build:dashboard`; `bun run db:migrate && bun run db:seed`.
4. **Caddy** reverse proxy: `app.<domain> → localhost:3000` (automatic TLS). APP_BASE_URL = that URL.
5. **systemd units** (`infra/systemd/*.service`): each unit `User=ve`, `EnvironmentFile=/etc/viral-engine/.env`, `ExecStart=/home/ve/.bun/bin/bun /opt/viral-engine/apps/<app>/src/index.ts`, `Restart=always`, `RestartSec=5`, `MemoryMax=2G` (workers), journald logging. Enable `ve-api ve-workers ve-bot`.
6. Deploy script (`infra/deploy.sh`): `git pull → bun install --frozen-lockfile → bun run typecheck → bun run build:dashboard → bun run db:migrate → systemctl restart ve-api ve-workers ve-bot` — run manually or via GitHub Actions SSH step on main. Migrations are backwards-compatible-first (expand/contract) so restart order doesn't matter.

## 3. R2 production setup (one-time, human)

Cloudflare dashboard → R2 → create bucket `viral-engine` (location auto) → API token (Object Read & Write, bucket-scoped) → env vars. No public bucket access; **everything via presigned URLs** (TG preview 1 h, Ayrshare media 24 h). Lifecycle rule: delete `tmp/` prefix after 1 d; keep renders 180 d (configurable later; storage is cheap, re-renders aren't reproducible bit-exact).

## 4. Backups & retention

- Postgres: nightly `pg_dump -Fc` to R2 `backups/pg/{date}.dump` (cron on VPS, 30-day retention via lifecycle rule); test restore quarterly (runbook in repo).
- R2: no second copy in v1 (renders reproducible-ish; source long-forms are the exception → also kept locally by the human).
- `.env`: encrypted copy in password manager, not in repo.

## 5. Monitoring & alerting (matches doc 08)

- `/healthz` polled by a free uptime service (Hetrix/UptimeRobot) → email/TG on down.
- Workers heartbeat staleness (>5 min) surfaces on `/healthz` (503 with reason) — so the same uptime ping catches dead workers.
- In-app: `alert.telegram` for job dead-letters, budget thresholds, policy diffs, publish failures.
- Disk watch: cron `df` check ≥85% → TG alert (renders tmp cleanup bug guard).
- Log access: `journalctl -u ve-workers -f` — pino JSON; `infra/logs.sh` wraps with jq pretty filter.

## 6. Security posture

- Only ports 80/443/22 open; API auth per doc 11; ADMIN_API_TOKEN ≥ 32 random bytes; session cookie `Secure HttpOnly SameSite=Lax`.
- Bot: admin-id allowlist + approval-chat-id check (doc 09); bot token revocable at BotFather without code change.
- R2 keys bucket-scoped; DB local-only (no public listener) or managed-PG with IP allowlist.
- Dependency hygiene: `bun update` monthly, lockfile committed; Biome/CI must pass to deploy.
- No user PII stored beyond platform-public comment text; raw_items honor Reddit deletion propagation (doc 03 connector note → a weekly `raw-items-prune` step inside `costs.rollup`: re-check reddit items >30 d old? v1 simplification: hard-delete reddit raw_items + snapshots older than 60 d — satisfies the 48 h deletion-propagation guidance by aggressive TTL; revisit if reddit data needed longer).

## 7. Cost expectations (from research; tracked live on Costs page)

Fixed: VPS ~$15–30 · domain ~$1 · R2 ~$1–3 (≤100 GB) · Ayrshare $149 · TikTok data $50–100 · X reads ≤$80 cap. Variable: LLM+TTS+render ≈ $0.25–0.90/short. Budget guard: `COST_BUDGET_MONTHLY_USD` (default 150 excludes Ayrshare-class fixed subscriptions — set to LLM+API spend only; document the chosen semantics in Settings UI copy).

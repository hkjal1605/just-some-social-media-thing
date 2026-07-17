# 01 · Monorepo, tooling, local dev

Registry and conventions: [00-overview](00-overview.md). This doc gets a fresh clone to a running dev environment.

## 1. Prerequisites (developer machine / VPS)

- **Bun ≥ 1.2.x** (`curl -fsSL https://bun.sh/install | bash`)
- **Docker + docker compose** (Postgres + MinIO in dev)
- **FFmpeg ≥ 6 built with libass** (`brew install ffmpeg` / `apt install ffmpeg`) — verify: `ffmpeg -filters | grep subtitles`
- **ffprobe** (ships with ffmpeg)

## 2. Root files

### `package.json` (root)

```json
{
  "name": "viral-engine",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun run scripts/dev.ts",
    "dev:api": "bun --watch apps/api/src/index.ts",
    "dev:workers": "bun --watch apps/workers/src/index.ts",
    "dev:bot": "bun --watch apps/bot/src/index.ts",
    "dev:dashboard": "bun run --cwd apps/dashboard dev",
    "db:generate": "bun run --cwd packages/db drizzle-kit generate",
    "db:migrate": "bun run --cwd packages/db src/migrate.ts",
    "db:seed": "bun run --cwd packages/db src/seed.ts",
    "db:studio": "bun run --cwd packages/db drizzle-kit studio",
    "build:dashboard": "bun run --cwd apps/dashboard build",
    "typecheck": "bunx tsc -b",
    "lint": "bunx biome check .",
    "lint:fix": "bunx biome check --write .",
    "test": "bun test",
    "start:api": "bun apps/api/src/index.ts",
    "start:workers": "bun apps/workers/src/index.ts",
    "start:bot": "bun apps/bot/src/index.ts"
  }
}
```

`scripts/dev.ts`: spawns api, workers, bot, dashboard concurrently with prefixed output (use `Bun.spawn`, kill children on SIGINT). Keep it ~40 lines, no dependency.

### `bunfig.toml`

```toml
[install]
exact = true

[test]
preload = ["./scripts/test-setup.ts"]   # loads .env.test, silences pino
```

### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "composite": true,
    "declaration": true,
    "declarationMap": true
  }
}
```

Each package/app has `tsconfig.json` extending base with `references` to internal deps (enables `tsc -b` graph typecheck; Bun itself needs no build step — it runs TS directly). `apps/dashboard` overrides `types: ["vite/client"]`, `jsx: "react-jsx"`, `module: "ESNext"`.

### `biome.json`

Defaults + `"formatter": { "indentStyle": "space", "lineWidth": 100 }`, organize imports on, `noExplicitAny: warn` (error later). Ignore: `dist`, `drizzle/meta`, `apps/dashboard/dist`.

### `.gitignore`

`node_modules`, `.env*` (except `.env.example`), `dist`, `*.local`, `tmp/`, `apps/dashboard/dist`, `packages/db/drizzle/meta/_journal.json` stays **tracked** (migrations are committed — never ignore `drizzle/`).

## 3. Package skeleton convention

Every package:

```
packages/<name>/
├─ package.json        # { "name": "@ve/<name>", "type": "module", "exports": { ".": "./src/index.ts" } }
├─ tsconfig.json
└─ src/index.ts        # re-export public surface only
```

Bun resolves workspace TS directly — **no build step for packages**. Internal deps: `"@ve/core": "workspace:*"`.

## 4. Dependency versions (pin at install; these are known-good majors)

| Package | Where | Version line |
|---|---|---|
| `hono` | api | ^4 |
| `@hono/zod-validator` | api | ^0.4 |
| `zod` | everywhere | ^3.24 |
| `drizzle-orm` | db | ^0.44 |
| `drizzle-kit` | db (dev) | ^0.31 |
| `postgres` (postgres.js) | db | ^3.4 |
| `pg-boss` | workers/api | ^10 |
| `@anthropic-ai/sdk` | llm | latest |
| `@google/genai` | llm | ^1 |
| `groq-sdk` | llm | latest |
| `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | storage | ^3 |
| `grammy` | telegram | ^1.30 |
| `uuidv7` | core | ^1 |
| `pino` + `pino-pretty` (dev) | core/apps | ^9 |
| `react`, `react-dom` | dashboard | ^19 |
| `@tanstack/react-router`, `@tanstack/react-query` | dashboard | ^1 / ^5 |
| `tailwindcss` | dashboard | ^4 |
| `recharts` | dashboard | ^2 |
| `vite`, `@vitejs/plugin-react` | dashboard (dev) | ^6 / ^4 |

If a version conflicts at install time, prefer the latest compatible and note it in the PR description — do not downgrade zod/drizzle below these lines.

## 5. `docker-compose.dev.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ve
      POSTGRES_PASSWORD: ve
      POSTGRES_DB: viral_engine
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U ve"], interval: 5s, retries: 10 }

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: ve-local, MINIO_ROOT_PASSWORD: ve-local-secret }
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]

  minio-init:
    image: minio/mc
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "mc alias set local http://minio:9000 ve-local ve-local-secret &&
      mc mb -p local/viral-engine || true"

volumes: { pgdata: {}, miniodata: {} }
```

Local R2 = MinIO: `@ve/storage` reads `R2_ENDPOINT` — set to `http://localhost:9000` in dev, `https://<account>.r2.cloudflarestorage.com` in prod. Code path identical (S3 API, `forcePathStyle: true` when endpoint is MinIO).

## 6. `.env.example` (complete — copy to `.env`, every var documented)

```bash
# ── Runtime ────────────────────────────────────────────────
APP_ENV=development                 # development | production | test
APP_BASE_URL=http://localhost:3000  # public URL of apps/api (presign callbacks, dashboard links in TG)
API_PORT=3000
LOG_LEVEL=debug                     # pino level
DISPLAY_TZ=Asia/Kolkata             # digests, dashboard formatting; storage is always UTC

# ── Database / queue ──────────────────────────────────────
DATABASE_URL=postgres://ve:ve@localhost:5432/viral_engine
PGBOSS_SCHEMA=pgboss                # pg-boss owns this schema

# ── Object storage (R2 prod / MinIO dev) ──────────────────
R2_ENDPOINT=http://localhost:9000
R2_ACCOUNT_ID=local                 # informational in dev
R2_ACCESS_KEY_ID=ve-local
R2_SECRET_ACCESS_KEY=ve-local-secret
R2_BUCKET=viral-engine

# ── LLMs / AI services ─────────────────────────────────────
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL_EDITORIAL=claude-sonnet-5      # scripts, compliance, judgment
GEMINI_API_KEY=
GEMINI_MODEL_VIDEO=gemini-2.5-flash            # video understanding + batch scoring
GEMINI_MODEL_EMBED=gemini-embedding-001
GROQ_API_KEY=
GROQ_MODEL_TRANSCRIBE=whisper-large-v3-turbo
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=                            # chosen brand voice
OPENAI_API_KEY=                                 # optional mini-TTS fallback; empty = disabled

# ── Platform reads ─────────────────────────────────────────
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=web:viral-engine:v0.1 (by /u/YOUR_USERNAME)
YOUTUBE_API_KEY=
X_BEARER_TOKEN=                                 # empty = X scout disabled
APIFY_TOKEN=                                    # TikTok data
ENSEMBLE_TOKEN=                                 # optional second TikTok provider; empty = disabled

# ── Publishing ─────────────────────────────────────────────
AYRSHARE_API_KEY=
AYRSHARE_PROFILE_KEY=                           # the brand profile
PEXELS_API_KEY=

# ── Telegram ───────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_APPROVAL_CHAT_ID=                      # group id, negative number
TELEGRAM_ALERT_CHAT_ID=                         # may equal approval chat
TELEGRAM_ADMIN_USER_IDS=                        # comma-separated numeric user ids allowed to approve

# ── Dashboard / API auth ───────────────────────────────────
SESSION_SECRET=change-me-32-chars-min
DASHBOARD_ADMIN_PASSWORD=change-me              # single-admin login (hashed at boot, compared constant-time)
ADMIN_API_TOKEN=change-me-long-random           # Bearer for bot/workers/CLI

# ── Safety rails ───────────────────────────────────────────
COST_BUDGET_MONTHLY_USD=150
KILL_SWITCH_DEFAULT=false
```

`@ve/config` (doc 03 §1) validates all of this with zod at process start. Optional integrations (`OPENAI_API_KEY`, `ENSEMBLE_TOKEN`, `X_BEARER_TOKEN`) may be empty → feature flags off.

## 7. Dev workflow

```bash
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env            # fill what you have; leave optional empty
bun install
bun run db:migrate && bun run db:seed
bun run dev                     # api :3000, dashboard :5173 (proxies /api → :3000), workers, bot
```

- Dashboard dev server proxies `/api` to `:3000` (vite `server.proxy`).
- Workers and bot log with pino-pretty in dev.
- `bun run db:studio` for schema browsing.

## 8. CI (GitHub Actions, `.github/workflows/ci.yml`)

Jobs on push/PR: (1) `bun install --frozen-lockfile`; (2) `bun run lint`; (3) `bun run typecheck`; (4) `bun test` with services: postgres:16 container (integration tests use `DATABASE_URL` from the service; storage tests use in-memory stub, not MinIO, in CI); (5) `bun run db:generate -- --check` equivalent: run `drizzle-kit check` to ensure schema ↔ migrations are in sync; (6) `bun run build:dashboard` (catches TS/JSX errors in the SPA).

## 9. Production run model (details in doc 12)

Three long-running Bun processes (`api`, `workers`, `bot`) + one static build (`dashboard`, served by api). Managed by systemd units or docker compose on a single VPS. No horizontal scaling in v1; pg-boss `teamSize` controls per-queue concurrency.

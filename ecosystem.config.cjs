/**
 * PM2 process manifest — the whole Viral Engine local stack in one command.
 *
 * One-shot steps that must run BEFORE first start (not PM2 apps):
 *   bun install
 *   # point DATABASE_URL where you intend! .env currently → PROD (Timescale Cloud).
 *   # For trying things out, use the local DB:  DATABASE_URL=postgres://ve:ve@localhost:5432/viral_engine
 *   bun run db:migrate                      # apply schema (local DB only — prod is already migrated)
 *   bun run db:seed                         # categories + sources + policy pages (idempotent)
 *   # Active-speaker reframe service (already set up on this machine; do this on a fresh clone):
 *   #   cd services/asd && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt \
 *   #     && .venv/bin/python download_weights.py
 *
 * Bring everything up / apply changes:
 *   pm2 start ecosystem.config.cjs          (or: pm2 startOrReload ecosystem.config.cjs)
 * First time only, to survive reboots:
 *   pm2 save && pm2 startup                  # persist list + boot on restart (follow the printed cmd)
 * Watch / manage:
 *   pm2 status      pm2 logs      pm2 logs ve-workers      pm2 restart all      pm2 delete all
 *
 * Every entrypoint loads the repo-root `.env` itself via `@ve/config` — secrets are NOT duplicated
 * here. This runs the DEV stack (APP_ENV=development): the API is API-only and the dashboard is the
 * Vite dev server, so open the DASHBOARD, not the API.
 *
 *
 * ⚠️ `ve-workers` runs the FULL autonomous system (radar scouts, editor, publish, learning crons),
 *    NOT just Clip Studio — against whatever DATABASE_URL points to. Use the LOCAL db to keep
 *    experimentation off prod. Clip Studio itself only spends OpenRouter (Whisper) + Gemini; the
 *    background scouts spend APIFY_TOKEN / X_BEARER_TOKEN if set — blank those in .env to isolate.
 */

// Shared options: run under bun from the repo root, restart on crash with backoff, 1 GB leak ceiling.
const base = {
  script: "bun",
  cwd: __dirname, // repo root — entrypoints + @ve/config resolve the root .env from here
  autorestart: true,
  watch: false,
  max_memory_restart: "1G",
  max_restarts: 10,
  min_uptime: "10s",
  merge_logs: true,
};

module.exports = {
  apps: [
    // Hono HTTP API — validates + enqueues, never runs jobs (:3000)
    { ...base, name: "ve-api", args: "apps/api/src/index.ts" },

    // pg-boss consumer — ALL queue workers + cron schedules (radar/factory/distribution/learning
    // + the Clip Studio queues: clip.ingestUrl → transcribe → analyze → render). ffmpeg + ASD live here.
    { ...base, name: "ve-workers", args: "apps/workers/src/index.ts" },

    // grammY approvals bot — idles cleanly if TELEGRAM_BOT_TOKEN is empty
    { ...base, name: "ve-bot", args: "apps/bot/src/index.ts" },
  ],
};

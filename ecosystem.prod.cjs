/**
 * PM2 manifest — PRODUCTION single-box hosting of the whole Viral Engine (UI + API + workers + a
 * public HTTPS tunnel) from ONE machine, shareable with a couple of people. Full walkthrough in
 * HOSTING.md. Run inside WSL2 (Ubuntu) on Windows — the codebase is Unix-oriented (bun scripts,
 * services/asd/.venv/bin/python, ffmpeg/yt-dlp on PATH).
 *
 * How prod differs from ecosystem.config.cjs (dev): APP_ENV=production is forced below, so the API
 * ALSO serves the built dashboard (apps/dashboard/dist) + SPA fallback — UI and API become ONE
 * origin on :3000. No separate Vite process. One origin ⇒ one tunnel ⇒ no CORS/cookie headaches.
 *
 * ONE-TIME pre-steps (NOT pm2 apps — run these first):
 *   bun install
 *   bun run build:dashboard            # builds apps/dashboard/dist (rebuild after any UI change)
 *   # active-speaker reframe + cover-frame scoring (optional but recommended — GPU makes it fast):
 *   #   cd services/asd && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt \
 *   #     && .venv/bin/python download_weights.py
 *   # Edit .env — set a STRONG DASHBOARD_ADMIN_PASSWORD / SESSION_SECRET / ADMIN_API_TOKEN and set
 *   #   APP_BASE_URL to your public tunnel URL. (APP_ENV is forced to production here.)
 *   # Install cloudflared (the tunnel binary): see HOSTING.md.
 *
 * Bring it all up:      pm2 start ecosystem.prod.cjs
 * Get the public URL:   pm2 logs ve-tunnel --lines 40   # copy the https://<…>.trycloudflare.com line
 * Survive reboots:      pm2 save && pm2 startup          # then run the command it prints
 * After a code change:  bun run build:dashboard && pm2 restart all
 * Manage:               pm2 status | pm2 logs ve-workers | pm2 restart ve-api | pm2 delete all
 *
 * ⚠️ SECURITY: this is exposed to the internet, gated ONLY by the dashboard login. Set a STRONG
 *    DASHBOARD_ADMIN_PASSWORD (a leaked login = full control + your API spend). The session cookie is
 *    Secure (HTTPS-only): always log in via the https:// tunnel URL, never http://localhost.
 */

// Shared options: run under bun from the repo root, restart on crash, force production.
const base = {
  script: "bun",
  cwd: __dirname, // repo root — entrypoints + @ve/config resolve the root .env from here
  autorestart: true,
  watch: false,
  max_restarts: 10,
  min_uptime: "10s",
  merge_logs: true,
  // pm2's env is set BEFORE the process starts, and @ve/config keeps already-set vars — so this
  // reliably overrides APP_ENV=development in .env without editing the file.
  env: { APP_ENV: "production" },
};

module.exports = {
  apps: [
    // Hono API — in production it ALSO serves the built dashboard + SPA fallback, so the UI and the
    // API are a single origin on :3000. The bun process just orchestrates (light RSS).
    { ...base, name: "ve-api", args: "apps/api/src/index.ts", max_memory_restart: "1G" },

    // pg-boss consumer — every queue worker + cron. ffmpeg / yt-dlp / Light-ASD run here as CHILD
    // processes (their memory isn't counted by pm2). Higher ceiling because the bun worker itself
    // briefly holds full video bytes in memory during transcribe/analyze/publish.
    { ...base, name: "ve-workers", args: "apps/workers/src/index.ts", max_memory_restart: "4G" },

    // grammY approvals bot — idles cleanly if TELEGRAM_BOT_TOKEN is empty (safe to leave running).
    { ...base, name: "ve-bot", args: "apps/bot/src/index.ts", max_memory_restart: "512M" },

    // Public HTTPS tunnel to :3000 via Cloudflare. This QUICK tunnel needs zero Cloudflare setup, but
    // the URL is RANDOM and CHANGES on every restart. For a STABLE shareable URL, install a NAMED
    // tunnel and replace args with:  "tunnel run <your-tunnel-name>"  (HOSTING.md → Stable URL).
    // If cloudflared isn't installed yet, this one app shows "errored" — the rest still run fine.
    {
      ...base,
      name: "ve-tunnel",
      script: "cloudflared",
      interpreter: "none",
      args: "tunnel --url http://localhost:3000",
      env: {},
      max_memory_restart: "256M",
    },
  ],
};

# Self-hosting the Viral Engine on your Windows PC (shareable with 1–2 people)

Run the **whole stack — UI, API, workers — on your PC**, and hand a friend a link they can open and log
into. Nothing but a login stands between the internet and the app, so this guide also hardens that.

## How it fits together

```
        friend's browser ──HTTPS──►  Cloudflare edge ──tunnel──►  cloudflared (your PC)
                                                                       │  http://localhost:3000
                                                                       ▼
                                              ve-api  ── serves the built dashboard (SPA)  ┐
                                                      └─ /api/v1/*  (Hono API)             │ one origin,
                                              ve-workers ── pg-boss: ingest→transcribe→    │ one port
                                                            analyze→render→cover→publish   │
                                              ve-bot ── Telegram approvals (idle if unused) ┘
                                                      │
      remote services (unchanged):  Timescale Cloud (DB) · Cloudflare R2 (storage) ·
                                    OpenRouter + Gemini (AI) · Buffer (posting)
```

Key point: **in production the API serves the dashboard itself**, so the UI and the API are a single
origin on port **3000**. That's why one tunnel is all you need and there are no CORS/cookie issues.

The **database and object storage stay in the cloud** (Timescale + R2) — they already hold your data and
work from anywhere. Only the app processes move onto your PC.

---

## Why WSL2 (not native Windows)

This codebase is Unix-oriented — bun shell scripts, `services/asd/.venv/bin/python`, ffmpeg/yt-dlp on
`PATH`. Running it in **WSL2 (Ubuntu)** avoids a pile of Windows path/quirk fixes and lets your **RTX 4060
accelerate the reframe** via CUDA passthrough. Everything below runs inside Ubuntu-on-WSL2.

---

## Step 0 — Windows prerequisites (once)

Open **PowerShell as Administrator**:

```powershell
wsl --install -d Ubuntu      # installs WSL2 + Ubuntu; reboot if it asks, then set a Linux username/password
```

**(Optional, for fast reframe)** Install the latest **NVIDIA Windows driver** (the normal GeForce/Game
Ready driver — it includes CUDA-on-WSL). You do **not** install a GPU driver *inside* WSL. Verify later
with `nvidia-smi` in Ubuntu.

Everything from here runs in the **Ubuntu terminal** (open "Ubuntu" from the Start menu).

---

## Step 1 — Get the code onto the PC

The repo isn't pushed anywhere yet and `.env` is gitignored (it holds your real secrets). Easiest path:

```bash
# in Ubuntu/WSL — keep the repo on the LINUX filesystem (~), NOT /mnt/c (much faster for node_modules)
cd ~
# option A: push it to a PRIVATE git repo from your Mac, then here:
git clone <your-private-repo-url> viral-engine
# option B: copy the whole folder over (scp / a USB drive / Windows file share), then:
#   cp -r /mnt/c/Users/<you>/Downloads/just-some-social-media-thing ~/viral-engine
cd ~/viral-engine
```

Then bring your **`.env`** across (it's not in git). Copy the same `.env` you use now into the repo root.
We harden its secrets in Step 4.

---

## Step 2 — Install the runtimes

```bash
sudo apt update && sudo apt install -y ffmpeg python3 python3-venv python3-pip curl unzip
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc   # Bun
python3 -m pip install --user -U yt-dlp                        # Clip Studio URL ingest
bun --version && ffmpeg -version | head -1 && yt-dlp --version # sanity check
npm i -g pm2   # process manager (installs Node+npm first if needed: sudo apt install -y nodejs npm)
```

Install project dependencies:

```bash
cd ~/viral-engine
bun install
```

---

## Step 3 — Reframe / cover service (recommended)

Powers the speaker-follow reframe and the best-frame thumbnail scorer. It **degrades gracefully** if you
skip it (blur-pad reframe, mid-clip thumbnail), but it's worth setting up.

```bash
cd ~/viral-engine/services/asd
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python download_weights.py
# GPU check (True = your 4060 will accelerate it; False = CPU, works but slower):
.venv/bin/python -c "import torch; print('CUDA:', torch.cuda.is_available())"
cd ~/viral-engine
```

If CUDA prints `False` but `nvidia-smi` works, install a CUDA build of torch from
<https://pytorch.org/get-started/locally/> for your CUDA version. Not required — CPU reframe still works.

---

## Step 4 — Configure & build

**Harden the three secrets** in `.env` (they gate a publicly-reachable app — do not skip):

```bash
# generate strong values:
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "ADMIN_API_TOKEN=$(openssl rand -hex 24)"
```

Edit `.env` and set:

| Var | Set it to |
|---|---|
| `DASHBOARD_ADMIN_PASSWORD` | a **strong** password — you and your friend log in with this |
| `SESSION_SECRET` | the generated 64-char value |
| `ADMIN_API_TOKEN` | the generated value |
| `APP_BASE_URL` | your public tunnel URL from Step 6 (e.g. `https://viral.example.com`) |

Leave the rest as-is: `DATABASE_URL` (Timescale), R2, OpenRouter/Gemini, and `BUFFER_ACCESS_TOKEN` are
already set. `APP_ENV` is forced to `production` by the pm2 manifest, so you don't edit that.

> The background autonomous pipeline stays effectively idle here — the scout tokens (`APIFY_TOKEN`,
> `X_BEARER_TOKEN`, `REDDIT_*`) are blank, so it's just Clip Studio + posting. `COST_BUDGET_MONTHLY_USD`
> (150) is your spend guard.

Build the dashboard the API will serve:

```bash
bun run build:dashboard      # → apps/dashboard/dist  (re-run this after any UI change)
```

---

## Step 5 — Run it

```bash
pm2 start ecosystem.prod.cjs     # ve-api + ve-workers + ve-bot + ve-tunnel
pm2 status                       # all should be "online"
pm2 save && pm2 startup          # keep it running across reboots — run the command it prints
```

Quick local check (API up): `curl -s localhost:3000/healthz` → `{"ok":true,...}`.
(Don't try to *log in* over `http://localhost` — the session cookie is HTTPS-only in production. Use the
tunnel URL from the next step.)

---

## Step 6 — Expose it to the internet

### Install cloudflared

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o cloudflared && sudo mv cloudflared /usr/local/bin/ && sudo chmod +x /usr/local/bin/cloudflared
cloudflared --version
```

### Option A — Quick tunnel (instant, zero setup, **ephemeral URL**)

Already wired into the pm2 manifest. Grab the URL:

```bash
pm2 restart ve-tunnel && sleep 3
pm2 logs ve-tunnel --lines 40    # copy the https://<random>.trycloudflare.com line
```

Good for testing or a short session. **The URL changes every time cloudflared restarts** (e.g. a reboot),
so it's not ideal for an ongoing share.

### Option B — Named tunnel (**stable URL**, recommended for a real share)

Needs a domain on a free Cloudflare account (add any domain you own to Cloudflare, ~5 min).

```bash
cloudflared tunnel login                          # opens a browser; pick your domain
cloudflared tunnel create viral-engine            # creates it + a credentials json
cloudflared tunnel route dns viral-engine viral.example.com   # your chosen subdomain
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: viral-engine
credentials-file: /home/<you>/.cloudflared/<UUID>.json
ingress:
  - hostname: viral.example.com
    service: http://localhost:3000
  - service: http_status:404
```

Point the pm2 tunnel app at it: in `ecosystem.prod.cjs`, change the `ve-tunnel` `args` to
`"tunnel run viral-engine"`, then `pm2 restart ve-tunnel`. Set `APP_BASE_URL=https://viral.example.com`
in `.env` and `pm2 restart ve-api`. Your stable URL: **https://viral.example.com**.

### Option C — Tailscale (most private; friends install an app)

If you'd rather **not** put it on the public internet: `curl -fsSL https://tailscale.com/install.sh | sh`
then `sudo tailscale up`. Your friends install Tailscale, you invite them to your tailnet, and they reach
it at `http://<your-machine>.<tailnet>.ts.net:3000`. No public exposure; the trade-off is they each need
the Tailscale app. (For HTTPS + a clean name, `tailscale serve` / MagicDNS.)

---

## Step 7 — Share with your friend

Send them **two things**: the **URL** (your tunnel/Tailscale address) and the **`DASHBOARD_ADMIN_PASSWORD`**.
They open the link → log in → they're in. It's a single shared admin login, which is fine for 1–2 trusted
people. Everyone sees the same Clip Studio, jobs, and Post buttons.

---

## Ops & troubleshooting

| Command | What it does |
|---|---|
| `pm2 status` / `pm2 logs` | health of all apps / live logs |
| `pm2 logs ve-workers` | the clip pipeline (ingest→…→render→cover) |
| `bun run build:dashboard && pm2 restart all` | apply a code/UI update |
| `pm2 restart ve-api` | pick up an `.env` change |

- **Can't log in (login "succeeds" but bounces back):** you're on `http://localhost` or `http://<lan-ip>`.
  The prod session cookie is `Secure` — use the **https** tunnel URL.
- **URL stopped working after a reboot:** that's the quick tunnel (ephemeral). Switch to a named tunnel
  (Option B) for a URL that never changes.
- **Clips don't reframe / stay blur-padded:** `services/asd/.venv` missing or torch errored — re-do Step 3;
  check `pm2 logs ve-workers` for `cover`/`ASD` warnings. It's non-fatal by design.
- **`yt-dlp`/`ffmpeg` not found:** re-run Step 2; confirm they're on `PATH` (`which ffmpeg yt-dlp`).
- **Workers idle / DB errors:** check `DATABASE_URL` is reachable from the PC and `pm2 logs ve-workers`.
- **Reframe is slow:** you're on CPU. Confirm `torch.cuda.is_available()` and the NVIDIA Windows driver.

## Security checklist (it's on the internet)

- [ ] `DASHBOARD_ADMIN_PASSWORD` is strong and **not** `change-me`.
- [ ] `SESSION_SECRET` (≥32) and `ADMIN_API_TOKEN` (≥24) are random, not the placeholders.
- [ ] You share the URL only with the 1–2 people you intend to.
- [ ] `COST_BUDGET_MONTHLY_USD` is set to a ceiling you're comfortable with.
- [ ] To take it offline instantly: `pm2 stop ve-tunnel` (kills public access, leaves the app running) or
      `pm2 delete all` (stops everything).

# The Viral Engine: what survives contact with the 2026 platforms

**Feasibility study · researched 12 July 2026**

A 24/7 AI-agent system that watches Reddit, X, TikTok and YouTube for what's going viral in a category, then publishes across all four and grows to monetization. Researched end-to-end: platform payout rules, originality policies, APIs, copyright enforcement, production costs, and the agent architecture to run it.

**Method stats:** 110 research agents · 800+ tool calls · 24/25 core claims survived 3-vote adversarial verification · 60+ sources, primary-first

Full rendered report: https://claude.ai/code/artifact/ca7ad028-8de0-40f3-a453-f9886d503824

---

## 01 · Verdict

### 🔴 NOT VIABLE — The system as specified (repost others' viral posts/videos verbatim, auto-clip other people's long-form)

It fails **by rule, not by detection risk**. Every platform that pays meaningfully has written reused/unoriginal content out of its monetization program; TikTok also suppresses it from the For You feed, and X cut aggregator payouts 60% in April 2026. Legally it is willful commercial copyright infringement — up to $150,000 statutory damages *per work*. The accounts can be built; they cannot durably earn, and the categories named (football, F1, music) have the most aggressive rights-holders on the internet.

### 🟢 VIABLE · BUILD THIS — The same ambition, restructured (trend radar + original content factory + licensed clipping)

Everything valuable in the idea survives: 24/7 cross-platform viral monitoring (trends and ideas aren't copyrightable), LLM-driven decisions on what/where/when to post, and the "watch a long video, clip the best moments" pipeline — pointed at *your own* long-form and at creators who *pay* for clipping through bounty marketplaces ($0.30–$1.50 per 1,000 views, paid from view one, no follower thresholds). Runs ~$500–800/month for 1–2 categories at 3–4 posts/day.

### 🟡 CALIBRATE — Timeline and revenue expectations

Platform payouts are gated and slow: months, not weeks, to any threshold, and Shorts ads pay only 3–14% of long-form RPM. The realistic revenue stack is licensed clipping first (immediate), affiliate income in the AI niche (early), platform programs (months 4–9), sponsorships (after traction). Most faceless channels fail; the design below is built around that base rate, not against it.

> **Scope note.** This report does not include — and I won't help build — the verbatim-repost mechanics: bulk-downloading third-party videos for re-upload, watermark removal from others' content, Content ID / detection evasion, or fake engagement. That's not caution for its own sake: the evidence below shows that path converges on terminated accounts and statutory damages, while the legitimate design achieves the actual goal — monetized, growing accounts.

---

## 02 · Why the as-specified version fails: three walls

### Wall 1 — Monetization policy excludes reused content, on every platform

These were the most heavily verified findings of the study — each confirmed 3–0 by independent adversarial checks against live fetches of the platforms' own policy pages (12 Jul 2026):

| Platform | Written rule | Effect on the proposed system |
|---|---|---|
| **YouTube** | "Reused content" policy: repurposing others' content without "significant original commentary, substantive modifications, or educational/entertainment value" makes the *whole channel* ineligible for the Partner Program — explicitly listing "short videos you compiled from other social media websites" and clips "edited together with little or no narrative." Separately, views on "non-original Shorts" (reuploads, unedited clips, compilations) are excluded from Shorts revenue sharing. The July 2025 "inauthentic content" update adds: mass-produced, templated AI content without "original, authentic insights" is ineligible too. | Repost channel earns $0 even if it somehow reaches the subscriber/view gates; fully-automated templated output is disqualified by name. |
| **TikTok** | Originality Policy defines as unoriginal: content copied from others, reposts with slight modifications (speed, filters, stickers, fixed text), compilations without new ideas, minimal-edit repurposing ("only splicing clips together," auto-subtitles on the original audio), and anything carrying someone else's watermark. Unoriginal content is *removed from the For You feed* and is ineligible for Creator Rewards, where originality is one of four scoring metrics. Enforcement tightened 15 Sep 2025 (violation points; ~5 violations in 30 days can permanently revoke monetization). | Both distribution *and* revenue are cut off. The exact pipeline described — cross-post with light reformatting — is quoted almost verbatim in the policy's violation list. |
| **X** | Creator Monetization Standards make "Spam, misleading content or online piracy" ineligible. In April 2026, X's product head announced payout cuts for all accounts classified as aggregators — 60% first cycle, a further 20% next — saying "flooding the timeline with 100 stolen reposts… crowded out real creators," alongside work to route revenue to original authors. | The one historically tolerant platform is now actively strangling repost economics. |
| **Reddit** | Contributor Program pays ~$0.90–$1.00 per 100 gold received (US-centric, karma-gated). Sitewide spam rules + per-subreddit norms; 837 users and 709 subreddits banned for repeat copyright infringement in H1 2025 alone; automated accounts get visible [App] labels from March 2026. | Not a revenue platform at all — it's a trend-detection and community surface. |

### Wall 2 — The APIs are built to refuse this exact system

- **TikTok Content Posting API:** unaudited apps can only post `SELF_ONLY` (private). And the audit criteria *categorically reject* (a) "apps that copy content from other platforms to TikTok" and (b) developer-only posting utilities. The UX rules additionally require express per-upload human consent — a fully hands-off TikTok poster is non-compliant by design. Practical cap ~15 API uploads per account per day even when audited.
- **YouTube Data API:** uploads from unaudited API projects (post-July 2020) are **locked private** until the project passes a compliance audit. Default quota: 100 searches and 100 uploads/day.
- **X API (major 2026 change):** the Free/Basic/Pro tiers are gone — it's pay-per-usage credits now. Reads $0.005/post, posting $0.015, *$0.20 per post containing a URL*. A naive 1M-post/month monitor would cost ~$5,000/month; a lean, well-filtered one runs $25–100.
- **TikTok has no commercial read API at all** (Research API is academic-only) — trend data comes from its Creative Center or licensed third-party providers.

### Wall 3 — Copyright enforcement in your chosen categories is industrial

| Rights-holder | What actually happens |
|---|---|
| **Formula 1 (FOM)** | Terminated the popular onboard-*analysis* channel "yelistener" via 3 copyright strikes (Nov 2025) — transformative commentary, still killed. Sent cease-and-desist waves to fan creators over merely using "F1" in account names (Aug 2024). Has struck sim-racing streams containing no real footage. |
| **Premier League / UEFA / FIFA** | PL detected 645k+ infringing live streams and ~900k unauthorized clips in the 2024/25 season; runs High Court blocking orders, Cloudflare/registrar subpoenas, and ~450k clip removals in a single earlier season. UEFA runs a joint anti-piracy program with Meta (Rights Manager upgrades, EURO 2024 onward). A 2024 coalition of leagues told X it had become "the home of social media piracy." |
| **Music labels/publishers** | Content ID scans every YouTube upload at ingest (pre-publish check ~3 minutes) and catches pitch/tempo-shifted matches. UMG pulled its entire catalog off TikTok for 3 months in 2024 — millions of videos muted overnight. NMPA's campaign DMCA'd 200,000+ X posts in a year; X is now in open litigation with publishers. On Shorts, one licensed track halves the revenue pool for that video; a Content ID claim on a >1-minute Short blocks it globally. |
| **Platform slop purges** | YouTube: "True Crime Case Files" (AI slop) terminated Feb 2025; fake-trailer channels Screen Culture & KH Studio (2M+ subs, 1B+ views) demonetized then terminated Dec 2025; a reported Jan 2026 purge hit 16 AI-slop channels (35M subs; single-sourced, treat cautiously). Meta actioned ~500k accounts for unoriginal content and removed ~10M impersonator profiles (Jul 2025). Instagram excluded repost/aggregator accounts from recommendations (Apr 2026). |

> Legal exposure underneath all of this: US statutory damages run $750–$30,000 per infringed work, up to $150,000 if willful — and they multiply per video. Three formal takedowns on YouTube = channel termination and a ban on creating new ones. The fair-use cases that clip channels cite (e.g., *Hosseinzadeh v. Klein*, S.D.N.Y. 2017) protected *moment-by-moment critical commentary* — the court's reasoning explicitly dooms bare re-clipping, which substitutes for the original. And even winning content gets taken down first and litigated after.

---

## 03 · What the platforms pay, and when

*Monetization programs as of 12 Jul 2026 (all thresholds verified against live policy pages)*

| Platform / program | Entry gate | What pays | Realistic rate |
|---|---|---|---|
| **YouTube Partner Program** | 1,000 subs + 4,000 watch-hrs (12 mo) *or* 10M Shorts views (90 d). Lower tier: 500 subs + 3k hrs / 3M views → fan-funding only | Long-form ads + Premium; Shorts creator pool (45% share); memberships, Supers | Long-form $1–10+ /1k · Shorts $0.03–0.10 /1k (3–14% of long-form) |
| **TikTok Creator Rewards** | 18+ · 10k followers · 100k views (30 d) · personal account · eligible country | Only *original* videos **>1 minute**; qualified views = unique FYF views >5s; each video needs 1,000 qualified views to start earning | est. $0.40–1.00 /1k (no official rate card) |
| **X Creator Revenue Sharing** | Premium sub + 5M organic impressions (3 mo) + 500 verified followers | Engagement from Premium users (since Nov 2024) — not ads in replies; biweekly via Stripe, $30 min | Small; engagement-weighted; aggregators cut −60% |
| **Reddit Contributor Program** | 100+ karma · 18+ · eligible country | Cash per gold received on posts/comments | $0.90–1.00 per 100 gold — negligible |
| **Whop clipping bounties** (licensed) | None. No followers, no views history | Brands/creators pay per 1k views on clips *they authorize*, submitted by URL across X/TikTok/YT; same-day payouts | $0.30–1.50 /1k · avg ≈ $1.00 |

The last row is the inversion that makes the whole plan work: in the licensed clipping economy the rights-holder *pays you* to do what the repost model steals. Whop's Content Rewards marketplace pays ~$40k/day to ~480k clippers (~1M videos/month); documented campaigns include MLB ($1/1k), Polymarket ($0.50/1k, $70k budget), Logan Paul, ElevenLabs, Joe Rogan content. One streamer (N3on) spent $1.4M in five weeks on clippers.

### What 1,000,000 short-form views pays (USD)

| Channel | Per 1M views | Constraint |
|---|---|---|
| YouTube Shorts ads | $30–100 | requires YPP: 10M views/90d |
| TikTok Creator Rewards | $400–1,000 (est.) | requires 10k followers · >1min videos |
| Licensed clipping (Whop) | $300–1,500 | no thresholds · pays from view #1 |

For scale, long-form YouTube in a decent niche pays $1,000–$10,000 per 1M views — which is why the design below treats short-form as the discovery engine and long-form + clipping + affiliate as the money. A refuted-in-verification claim worth flagging: precise per-country Shorts RPM figures circulating online (e.g. "$0.328 US") did not survive adversarial checking; only the ranges above did.

**Key gates:**

- **Fastest legit dollar: Day 1** — clipping bounties pay same-day, before you have a single follower.
- **First platform gate: Mo 3–6** — TikTok 10k followers + 100k views/30d is usually the first threshold to fall.
- **YPP Shorts path: 10M / 90d** — views needed for full ad share; treat as a month 4–9 goal per category.
- **X entry: 5M / 3mo** — organic impressions + 500 verified followers + Premium sub.

---

## 04 · Category risk ladder

The five categories named are wildly different businesses. Ordered best-first:

| Category | Risk | Reality | Formats that win (all original) |
|---|---|---|---|
| **AI / tech** | 🟢 Green | Lowest rights risk — screen-record your own tool demos and you own the footage. Richest affiliate economics (AI tools pay 20–30% recurring). No niche ad restrictions. One trap: corporate keynote footage gets DMCA'd (Apple has nuked entire WWDC archive channels). | Tool demos/tutorials (Matt Wolfe archetype), daily AI news recaps (The Rundown: 2M-sub newsletter), "AI did X" spectacle with your own generations (label as AI), model-comparison shorts. |
| **Politics** | 🟡 Amber | US government footage is public domain (House/Senate floor feeds usable) — but C-SPAN's own cameras require a commercial license if monetized. TikTok is hostile (political accounts lose all monetization; political ads banned). YouTube *relaxed* controversial-content monetization Jan 2026. X is the friendliest. Mandatory human review — defamation/misinfo risk, and platform synthetic-media rules bite hardest here. | Rapid-response creator-anchor format (Aaron Parnas archetype, 3.5M TikTok), debate-clip commentary with real analysis, X-first distribution. Never fully autonomous. |
| **Football** | 🟠 Serious | Match footage is untouchable (PL removed ~450k clips in one season; 645k streams detected 2024/25; Content ID claims in minutes). But football *conversation* is enormous and free. | Talking-head hot takes and fan-cam formats (United Stand/AFTV archetypes), animated tactics explainers (Tifo archetype — zero match footage), data/infographic shorts (Score 90), football-finance explainers. Text+graphic X posts around match moments (no video). |
| **Formula 1** | 🔴 Critical | FOM is the strictest rights-holder in sport: killed a transformative analysis channel via strikes (Nov 2025), C&D'd creators for "F1" in usernames, struck videos of the official F1 *game*. Assume zero tolerance for any broadcast audio/video. | Team-radio *discussion* (paraphrase + graphics, not the audio), race-weekend explainer animations, driver-market/news analysis, sim-racing content clearly framed as game content (still occasionally struck — keep appeals ready), sanctioned programs (Aston Martin Creator Collective model). |
| **Music / songs** | 🔴 Critical | Worst of all five. Two rights layers per song; Content ID has 100M+ references and catches sped-up/pitched edits; TikTok's trending library is licensed for *personal, non-commercial* use only (business/branded content is restricted to the ~1M-track Commercial Music Library, TikTok-only); Creator Rewards disqualifies videos with >1 min of copyrighted music or lip-syncs; on Shorts one track halves the revenue pool. UMG showed it can mute an entire platform's archive overnight. | Music *news* and chart commentary, artist-story explainers (no recorded audio beyond platform-permitted snippets), reviews with original voiceover, trend reporting *about* sounds without using them. Honestly: skip as a launch category. |

**Launch recommendation:** AI/tech first (safest, best unit economics, your demos are original footage), football-commentary second (huge audience, works with zero match footage). Politics only once the human-review loop is proven. F1 only in commentary/graphics form. Music: monitor for trend intelligence, don't publish into it.

---

## 05 · The system that works

Same skeleton as the original spec — monitor everything, decide with LLMs, publish 24/7 — with one substitution at the center: the publishing arm **executes trends as original content** instead of copying the trending artifact. Four engines:

| Engine | Job |
|---|---|
| **1 · Radar** | 24/7 cross-platform trend detection per category. Velocity stats + LLM "why is this working" analysis. Trends are free; pixels are not. |
| **2 · Factory** | Turns hot trends into original platform-native assets: scripts, TTS voiceover, own screen recordings, licensed stock, AI visuals (disclosed), captions, renders. |
| **3 · Distribution** | Schedules and publishes native variants to all four platforms through audited APIs, at platform-safe cadence, with per-platform metadata. |
| **4 · Learning loop** | Pulls own-account analytics daily, attributes wins to features (hook, length, topic, timing), rewrites the per-category playbook the other engines read. |

### Engine 1 — Radar (fully legal, and the moat)

- **Reddit:** official API, free tier (100 req/min) — subreddit hot/rising per category + r/all sweep every 30–60 min.
- **YouTube:** Data API free 10k units/day — `mostPopular` charts, tracked-channel uploads via playlistItems (1 unit each; hoard the 100/day searches).
- **X:** pay-per-use reads on tight, entity-filtered queries per category (~10–20k posts/mo ≈ $50–100). Track velocity, not volume.
- **TikTok:** no official read API — TikTok Creative Center (trending hashtags/sounds, free) + a licensed data provider: Apify TikTok scraper ~$1.70/1k results or EnsembleData from $100/mo. (US courts have twice sided with scraping public data — *Meta v. Bright Data*, *X v. Bright Data*, 2024 — but platform ToS still prohibit it; treat providers as replaceable and keep two on hand.)
- **Scoring:** views/hour z-score vs a rolling category baseline + acceleration; embedding-dedupe the same story across platforms; LLM rubric per trend: emotion, format archetype, transferability per platform, longevity (evergreen vs 6-hour meme), and a **rights classification** — 🟢 Green: idea/news/format executable originally · 🟡 Amber: quotable with genuine commentary · 🔴 Red: third-party footage/music at its core → intelligence only, never publish.

### Engine 2 — Factory (where "same content" becomes "same trend, your execution")

- **Original scripts:** the scriptwriter agent gets the trend brief — *never the source transcript to paraphrase*. A similarity guard (embeddings + n-gram overlap vs the source) enforces idea-not-expression before anything renders.
- **Faceless production line:** TTS voiceover (ElevenLabs $0.18/min, or OpenAI mini-TTS at ~$0.015/min), visuals from your own screen recordings (AI niche), licensed stock, or AI generation (auto-toggle the platform AI-disclosure labels — YouTube's altered-content checkbox, TikTok's AIGC label), burned captions, per-platform renders (9:16 >61s for TikTok Rewards; 30–60s cut for Shorts; native 16:9 or square for X).
- **Marginal cost: $0.25–0.90 per short** (verified against current pricing pages; ~$0.50–2.00 all-in with subscription floors amortized at ~100 videos/mo).
- **The clipping pipeline — pointed legally:** Whisper-class transcription ($0.04–0.11/hour via Groq) + Gemini video understanding (a full 60-minute video costs ~$0.11–0.32 to analyze on Gemini Flash) + LLM moment-scoring (hook strength, self-containedness, emotional peak) + FFmpeg/Remotion cut, reframe, caption. Run it against: (a) **your own weekly long-form** — each long-form yields 5–10 shorts and builds the 4,000 watch-hours path; (b) **licensed partner content** — creators who grant clipping rights.
- **The licensed clipping lane (revenue from day 1):** join Whop Content Rewards campaigns in your categories. Sponsors authorize their footage; your pipeline clips it; submit posted URLs; get paid $0.30–1.50/1k views same-day, escrowed. This funds the operation while owned accounts grow — and it's the legal inversion of "find viral creators and clip them": you clip the ones who pay for it. Disclose sponsored posts (#ad) even when campaign norms are lax — undisclosed paid distribution is the sketchy half of that economy; don't inherit its risk.
- **Compliance gate (blocking, before render):** rights check (no third-party footage/music outside license; optional audio-fingerprint self-check), similarity guard, platform policy lint (AI labels, music-library rules per account type, political-content rules per platform), category rules (politics → always human).
- **Human approval queue:** every asset flows through approve/edit/reject — in Telegram or a small web UI — until a category's playbook earns per-format auto-approval. Politics and anything claim-heavy: human forever. One kill-switch pauses all publishing.

### Engine 3 — Distribution

- **Posting rail:** start with an aggregator — Ayrshare ($149/mo, one brand across all four platforms incl. Reddit, unlimited posts, runs audited platform apps) — which sidesteps the TikTok/YouTube audit walls entirely. Budget alternative: Post for Me at $10/mo (no Reddit). Graduate to direct APIs only if/when you pass audits.
- **Cadence (platform-safe):** TikTok 1–2/day per account (Buffer's 11.4M-post study: 2–5 posts/week already yields +17% views/post; volume raises the lottery-ticket count, not the median), Shorts 1/day, X 3–5/day including text posts (avoid URL posts at $0.20 — put links in replies), Reddit only genuine participation under the 9:1 rule.
- **Metadata agent:** per-platform titles/captions/hashtags/sounds; hooks re-written per platform; posting windows from Buffer/Sprout 2026 baselines (TikTok evenings + Sat/Sun 9am contested — test both; Shorts Fri 4pm; X Tue–Wed 9am–12pm) then tuned by your own analytics within 4–6 weeks.
- **Engagement agent:** replies in the first hours (on X, replies-the-author-engages-with carried 75× a like's weight in the open-sourced ranker; the 2026 Grok-based ranker optimizes engagement sequences — same behavior wins), answers comments, flags questions to you.

### Engine 4 — Learning loop

- Daily pulls: YouTube Analytics API (free), TikTok display metrics via aggregator, X owned-reads at $0.001/resource (5× cheaper than third-party reads).
- Attribute performance to features (hook type, length, topic, emotion, timing); update the per-category **playbook file** — a living document the scriptwriter and scheduler read. This is the self-improving part: the system literally rewrites its own instructions weekly (Hermes-style skills).
- Kill rules: format loses to category median 3 weeks running → retire it. Reallocate to winners.

---

## 06 · Agent roster and the harness (including the Hermes answer)

### The 24/7 roster — nine agents, one orchestrator

| Agent | Trigger | Job | Autonomy |
|---|---|---|---|
| **Scouts** (×4, per platform) | cron 30–60 min | Pull category feeds → normalized trend items with metrics snapshots | Full |
| **Analyst** | on new batch | Velocity scoring, cross-platform dedupe, why-viral rubric, rights classification | Full |
| **Editor-in-chief** | hourly | Picks trends to execute, chooses format per platform, owns the content calendar and category mix | Full (within playbook) |
| **Scriptwriter** | per brief | Original script + 3 hook variants per platform target | Full → gate |
| **Producer** | per approved script | TTS, visuals, captions, renders, per-platform variants; retries failed renders | Full |
| **Compliance officer** | before render + before publish | Rights check, similarity guard, AI-disclosure toggles, policy lint. **Blocking.** | Veto power |
| **Publisher** | scheduled slots | Posts via aggregator API with platform metadata; respects cadence caps and jitter | After human approve |
| **Community manager** | first 3h after post | Replies, pins, question triage to human | Templated replies full; novel → gate |
| **Performance analyst** | daily 06:00 | Metrics pull → feature attribution → playbook edits → weekly human digest | Full (playbook edits reviewed weekly) |

### "Copy parts of the Hermes harness" — identified, and yes

**Hermes is Nous Research's open-source agent harness** (MIT license, ~213k GitHub stars, v0.18.2 as of 8 Jul 2026) — a model-agnostic tool-use loop with exactly the pieces this system needs. Worth copying directly:

- **Cron-native scheduling** — natural-language recurring jobs ("every 30 minutes, scan r/artificial") is precisely the Scout trigger model.
- **Skills that self-improve** — Hermes agents write and refine their own skill files after tasks; the per-category playbooks are the same pattern (the Performance analyst maintains them).
- **Multi-layer memory** — persistent user/domain memory + searchable session memory maps to trend history + account state.
- **Messaging gateway** — its Telegram/Discord/Slack bridge is the cheapest human-in-the-loop surface: approvals, digests, and the kill-switch live in your chat app. (The companion *Hermes Studio* project adds a web dashboard with execution approvals and multi-agent orchestration.)

Equally valid: build on the **Claude Agent SDK** (scheduled agents, subagents, task queues, file-based memory are all first-class — the same patterns, batteries included). Either way, the harness is scaffolding around three loops: cron ticks → durable job queue → approval gates.

### Runtime plumbing

- **Start boring:** one VPS (~$40/mo), Postgres (trends, assets, posts, metrics), S3-compatible storage, a worker queue. Cron + queue covers v1.
- **When pipelines get long,** move render/publish flows to a durable-execution layer so a crashed step resumes instead of re-running: Inngest (free to 50k runs/mo, then $75/mo) or Temporal Cloud (from $100/mo). Their `waitForEvent` / signal primitives are purpose-built for "pause until human approves."
- **Models by job:** a frontier model (Claude) for editorial judgment, scripts, and compliance reasoning; Gemini Flash for cheap native video understanding ($0.0018–0.0054/min of video); Groq Whisper for transcripts; small embeddings for dedupe. Batch the Analyst's scoring calls (50% off on Gemini batch).

---

## 07 · Data & posting access, priced

*Per-platform access map (12 Jul 2026)*

| Platform | Read (trends) | Write (publish) | Monthly cost, lean |
|---|---|---|---|
| **Reddit** | Official API free · 100 req/min · OAuth required · must propagate deletions ≤48h | Official API (bot rules: descriptive User-Agent, [App] labels, subreddit rules, 9:1) | $0 |
| **YouTube** | Data API free · 10k units/day (search = 100 units — use channel polling at 1 unit) | Via aggregator (audited) — direct API uploads are private-locked until your project passes audit | $0 |
| **X** | Pay-per-use: $0.005/post read (dedup 24h) · own-account reads $0.001 | $0.015/post · $0.20 with URL (put links in replies) · or via aggregator | $50–100 |
| **TikTok** | Creative Center (free) + licensed provider: Apify ~$1.70/1k · EnsembleData $100/mo · ScrapeCreators ~$1–1.9/1k (Research API is academic-only) | Aggregator only, realistically (unaudited direct API = private posts; repost-style apps categorically failed at audit; ~15 uploads/day/account cap) | $50–100 |
| **All four** | — | **Ayrshare** Premium: 13+ networks incl. all four, unlimited posts, API-first | $149 |

Scraping-provider legal posture: *Meta v. Bright Data* (N.D. Cal. 2024) and the dismissal of *X v. Bright Data* (May 2024) favored logged-out scraping of public data under US law — but ToS prohibitions, GDPR on personal data, and platform blocking all still apply. Architecture rule: providers are swappable adapters, never load-bearing.

---

## 08 · Virality mechanics the agents encode

*Per-platform ranking signals and starting playbook (2025–26, documented sources)*

| Platform | What ranks (documented) | Starting playbook |
|---|---|---|
| **YouTube Shorts** | "Viewed vs swiped away" is the headline metric (official); per-video seed-audience testing expands in waves; channel size barely matters; since Mar 2025 "views" count instantly but *engaged views* (the old threshold) still drive YPP/revenue. | Hook <2s with text overlay (majority watch muted at first); 13–60s sweet spot despite the 3-min ceiling; loopable endings; 1/day; Fri 4pm baseline; clean exports — never another platform's watermark (TikTok-watermarked videos were excluded from the old Shorts Fund; Instagram openly downranks them). |
| **TikTok** | Official factors: completion ("watched to the end" called out), likes/shares/comments, sounds+hashtags as signals; batch testing with wave expansion; feed spaces out same-creator/same-sound posts; unoriginal content isn't recommended. | >61s videos for Rewards eligibility, front-loaded hook, 1–2/day; trending sounds only on personal/creator accounts (business accounts are locked to the commercial library); first-hours completion decides waves — publish when the category is awake (evenings; weekend mornings contested between studies — A/B it). |
| **X** | Legacy open-sourced weights: reply = 13.5× a like; author-engaged reply = 75×; report = −369×. Since Jan 2026 the open-sourced Grok-based ranker learns from engagement sequences ("no manual feature weights") — conversation quality still wins. Premium boosts replies; link posts underperform mechanically (fix shipped Oct 2025; links-in-replies still safer). | 3–5 posts/day mixing native video, text takes, and threads; reply to every substantive comment in hour one (author-reply weighting); build reply-bait hooks (questions, hot takes); avoid $0.20 URL posts; Premium on all publishing accounts. |
| **Reddit** | Archived hot formula: log-scaled votes + ~12.5h half-life — the first 30–60 min of votes in-subreddit decide everything; AutoModerator karma/age floors filter newcomers silently; 9:1 self-promotion guideline is written into Reddit's spam policy. | Genuine participation account per category; post discussion-starters and OC graphics, not links to your channels (1-in-10 max); target subreddit-local morning peaks; never automate replies here — Reddit is radar + community, not a blast target. |

---

## 09 · Unit economics and honest expectations

*Monthly budget — lean single-brand operation, 2 categories, ~100 shorts + ~8 long-form/mo*

| Line | Choice | $/mo |
|---|---|---:|
| Posting rail | Ayrshare Premium (all four platforms) | 149 |
| TikTok trend data | EnsembleData Wood or Apify actor budget | 100 |
| X API credits | ~15k filtered reads + ~150 posts | 80 |
| LLM (scripts, scoring, judgment) | Claude + Gemini Flash batch | 120 |
| Voice + render stack | ElevenLabs Creator + Creatomate/JSON2Video tier | 65 |
| Video understanding + transcripts | Gemini Flash video + Groq Whisper | 15 |
| Infra | VPS + Postgres + object storage | 45 |
| **Total fixed + variable** | | **≈ 575** |

Marginal cost per extra short: $0.25–0.90. The X line scales with read volume — a heavier monitor is the first thing that gets expensive ($0.005/post read adds up; a 1M-post/mo firehose would be ~$5k, which is why the Radar filters hard before reading).

*Revenue timeline — expected ranges, per category account, if execution is good*

| Phase | Platform programs | Licensed clipping | Affiliate/other |
|---|---|---|---|
| **Mo 1–3** | $0 (below all gates) | $100–800/mo | $0–200 (AI niche links) |
| **Mo 4–6** | TikTok Rewards if 10k/100k hit: $50–400 | $300–1,500 | $100–600 |
| **Mo 7–12** | + YPP if Shorts path lands: $100–1,000; X small | $300–2,000 | $300–1,500 + first sponsorships |

Base rates, stated plainly: the classic power-law study (Bärtl 2018) found 96.5% of YouTube creators earn below the US poverty line; vendor claims that faceless channels reliably monetize in 2–6 months come from AI-tool marketing and did not survive source checking. What moves the odds: the Radar's speed (trend-to-publish latency in minutes-to-hours), per-video original insight (which is also the monetization policy bar), multi-category diversification, and revenue that doesn't wait for platform gates (clipping + affiliate). If the channels stall, the Radar itself is a sellable B2B product — Exploding Topics exited to Semrush; Trendpop to Collab.

---

## 10 · Build roadmap

| Phase | Build | Exit criterion |
|---|---|---|
| **Wk 1–2 · Radar MVP** | One category (AI). Reddit + YouTube ingestion (free APIs), Apify TikTok pull 1×/day, trends DB, velocity scoring, LLM why-viral rubric, Telegram digest 2×/day. Cost: <$50. | Digest reliably surfaces trends you'd have wanted to know about, hours before they peak. |
| **Wk 3–4 · Factory MVP** | Brief → script + 3 hooks → TTS → captions → render (one faceless format + one X thread format). Compliance gate + Telegram approve/reject. Post manually. | 10 published videos you're not embarrassed by; production cost <$1 each; zero rights flags. |
| **Wk 5–6 · Distribution + revenue** | Ayrshare hookup, scheduler, engagement agent, analytics pull v1. Join 2–3 Whop clipping campaigns in-category and run the clip pipeline on sponsor footage. | Fully automated post-with-approval flow; first clipping payout received. |
| **Mo 2–3 · Flywheel** | Weekly own long-form → auto-clipped into 5–10 shorts (the legal "watch & clip" engine). Playbook self-updates from analytics. Add category #2 (football commentary). X Premium + posting ramp. | One format with repeatable above-median performance; playbook v2 written by the system. |
| **Mo 4+ · Scale** | Category #3, cadence up, durable-execution migration (Inngest/Temporal), direct-API audits if volume justifies, evaluate selling Radar access as SaaS. | First platform monetization gate crossed; decision point: media business vs. tooling business. |

---

## 11 · Risk register

| Risk | Level | Mitigation built into the design |
|---|---|---|
| Policy drift (thresholds/rules change; X's page literally says payouts are "currently" biweekly) | 🟡 Likely | A policy-watch agent re-fetches the ~12 governing policy pages monthly and diffs them — the system watches the rules that govern it. |
| "Inauthentic content" classification of your own output (AI-slop bar) | 🟠 Serious | Per-video original insight is a hard content requirement, not a style choice; no shared templates across videos; volume caps; human editorial voice in every script; AI-disclosure labels on. |
| Third-party data provider for TikTok gets blocked / ToS action | 🟡 Likely eventually | Two providers integrated behind one adapter; Creative Center as the always-legal fallback; radar degrades gracefully, never breaks. |
| Rights mistake ships (music bed, footage in b-roll) | 🟠 Costly | Blocking compliance agent; licensed-source-only asset store; audio-fingerprint self-check; three-strikes math means the tolerance is zero. |
| Account suspension (spam classification from cadence/automation) | 🟡 Moderate | Platform-safe cadence caps with jitter; aggregator posting via audited apps; accounts warmed manually first; no engagement-buying ever (it's also payout fraud on TikTok's qualified-view rules). |
| Clipping-marketplace payment disputes | 🟡 Documented | Escrowed marketplaces only (Whop-class, with clawback windows); no informal Discord deals; disclose sponsored posts. |
| Defamation / misinformation in politics & news content | 🔴 Severe if hit | Politics is human-gated forever; claims require a citable source in the brief; synthetic-media rules enforced by the compliance agent; when in doubt, don't publish. |
| The whole thing works but earns slowly | 🟡 The base case | Revenue stack that starts day 1 (clipping, affiliate); monthly burn <$600; kill-or-scale review at month 3 with real numbers; Radar-as-SaaS as the pivot asset. |

---

## 12 · Method, confidence, sources

**Method.** A deep-research workflow (107 agents) decomposed the question into five angles, fetched 25 sources, extracted 122 claims, and adversarially verified the top 25 — three independent skeptic agents per claim, each instructed to refute it against live primary sources; 24 survived 3–0, one (per-country Shorts RPM figures) was refuted and excluded. Three follow-up research agents filled the remaining clusters (virality mechanics, production pricing, enforcement cases, harness prior art) with primary-source citations. Everything time-sensitive was checked against pages as they stood on 12 Jul 2026.

**Confidence caveats.** TikTok publishes no official RPM (all $/1k figures are third-party estimates). The Jan 2026 YouTube AI-slop purge is mid-tier-press-sourced only. Reddit's ~$12k/mo commercial API floor is consistently reported but not officially published. Klap/Vizard subscription prices are third-party-corroborated (official pages JS-hidden). X's monetization standards wording rests on search-snippet reconstruction (the page blocks fetchers). All thresholds are platform-set and drift — hence the policy-watch agent.

### Primary sources (selection)

- YouTube channel monetization policies (reused/inauthentic content) — support.google.com/youtube/answer/1311392
- YouTube Shorts monetization policies — support.google.com/youtube/answer/12504220
- YPP eligibility — support.google.com/youtube/answer/72851 · expanded tier /answer/13429240
- YouTube copyright strikes — /answer/2814000 · Content ID /answer/2797370 · CID eligibility /answer/1311402
- YouTube AI disclosure — /answer/14328491 · 3-min Shorts /answer/15424877
- YouTube Data API quotas & audits — developers.google.com/youtube/v3/guides/quota_and_compliance_audits · videos.insert private-lock — /docs/videos/insert
- TikTok Originality Policy — tiktok.com/creator-academy/article/tiktok-originality-policy
- TikTok Creator Rewards — support.tiktok.com (program page) + creator-academy eligibility
- TikTok Content Posting API guidelines — developers.tiktok.com/doc/content-sharing-guidelines
- TikTok Research API access — developers.tiktok.com/products/research-api
- TikTok commercial music library terms — tiktok.com/legal (CML user terms)
- X creator revenue sharing — help.x.com/en/using-x/creator-revenue-sharing
- X content monetization standards — help.x.com/en/rules-and-policies/content-monetization-standards
- X API pricing (pay-per-use) — docs.x.com/x-api/getting-started/pricing
- X aggregator payout cuts — @nikitabier (Apr 2026) + TechCrunch 12 Apr 2026
- X open-sourced rankers — github.com/twitter/the-algorithm (2023) · github.com/xai-org/x-algorithm (Jan 2026)
- Reddit Data API wiki + Responsible Builder Policy — support.reddithelp.com
- Reddit Contributor Program — support.reddithelp.com/hc/en-us/articles/17331620007572
- Reddit spam / 9:1 guidance — support.reddithelp.com/hc/en-us/articles/360043504051
- Formula 1 official guidelines — formula1.com/en/information/guidelines
- Premier League copyright enforcement — premierleague.com/en/copyright-infringement + USTR 2025 submission
- UEFA–Meta anti-piracy program — uefa.com (2024)
- US statutory damages — copyrightalliance.org (17 U.S.C. §504 explainer)
- *Hosseinzadeh v. Klein* fair-use summary — copyright.gov/fair-use/summaries
- *Meta v. Bright Data* / *X v. Bright Data* — CNBC + Farella analysis (2024)
- UMG–TikTok dispute/resolution — Variety, May 2024 · renewal May 2026 — TikTok newsroom
- NMPA v. X litigation + X countersuit — Variety Jan 2026
- Whop Content Rewards economics — whop.com/blog + Forbes 29 Apr 2026 + KERA News 12 May 2026
- Screen Culture/KH Studio terminations — Deadline Dec 2025 · True Crime Case Files — 404 Media/Tubefilter Feb 2025
- Meta unoriginal-content crackdown — CNBC 14 Jul 2025 · Instagram repost dampening — Engadget/Tubefilter Apr 2026
- Buffer 2026 timing study (52M posts) + TikTok cadence study (11.4M posts) — buffer.com
- Sprout Social 2026 timing study — sproutsocial.com
- Gemini API pricing & video tokenization — ai.google.dev · TwelveLabs pricing — twelvelabs.io · Groq — groq.com
- ElevenLabs / Cartesia / OpenAI TTS+transcribe pricing — vendor pages
- OpusClip / Klap API / Vizard / Creatomate / JSON2Video / Shotstack / Remotion licensing — vendor pages
- Apify / EnsembleData / ScrapeCreators / Bright Data pricing — vendor pages
- Ayrshare pricing — ayrshare.com/pricing
- Hermes Agent (Nous Research) — github.com/nousresearch/hermes-agent + official docs · Hermes Studio · hermes-swarm
- Temporal / Inngest / Trigger.dev pricing — vendor pages · HumanLayer — YC launch/PyPI
- Bärtl (2018) creator power-law — Convergence, via Fast Company

---

*Prepared 12 July 2026 · thresholds, prices and policies drift — the report's own design assumes it (see risk register, row one). This is research, not legal advice; for the categories with rights-holder exposure, a one-hour consult with a media-IP lawyer before launch is cheap insurance.*

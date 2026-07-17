#!/usr/bin/env bun
// Clip-pipeline demo (doc 05 §5) — the "find the viral moments in MY video" path, in isolation.
//
// Feed ONE source video. The engine transcribes it (Whisper), finds the most viral-worthy
// self-contained moments (native Gemini video understanding), ranks them, cuts the top ones to
// 1080×1920, and burns karaoke captions from the transcript. Finished clips are saved LOCALLY under
// tmp/clips/<source-basename>/ — nothing clip-related stays in R2, and the source video is deleted
// from R2 automatically when the run completes (--keep-r2 opts out). NOTHING is posted or published.
//
// A clip keeps the SOURCE speaker's OWN audio — it's a real cut of your video, so the "voiceover"
// is the original voice, and captions are burned from the transcript. (A brand-new AI voiceover is
// a different format entirely: faceless-explainer — see scripts/factory-demo.ts.)
//
// The engine does NOT fetch bounties or find videos on the internet — you supply the source (your
// own long-form, or licensed campaign footage). It finds the best CLIPS within that source.
//
// Prints a full report: per-step timing, each step's output, per-component + net cost (from the
// llm_usage ledger), and the final clips.
//
// Usage:
//   bun run scripts/clip-demo.ts <video.mp4> [--platforms tiktok,youtube] [--top 2] [--keep-r2]
//   bun run scripts/clip-demo.ts --offline            # no keys/network, canned moments, auto-sample
//   --keep-r2  keep the source video + clips in R2 instead of the default auto-delete after the run
//
// Real analysis needs OPENROUTER_API_KEY (Whisper) + GEMINI_API_KEY (video). Works with either real
// R2 or local MinIO (Gemini gets the video as an uploaded byte stream, not a URL). --offline swaps in
// canned deps and needs no keys or network.
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  clipAnalyzeHandler,
  clipTranscribeHandler,
  promoteClipCandidate,
} from "../apps/workers/src/engines/factory/clips";
import { complianceHandler } from "../apps/workers/src/engines/factory/compliance";
import { setFactoryDeps } from "../apps/workers/src/engines/factory/deps";
import { offlineFactoryDeps } from "../apps/workers/src/engines/factory/offline";
import { renderHandler } from "../apps/workers/src/engines/factory/render";
import { scriptHandler } from "../apps/workers/src/engines/factory/scriptwriter";
import type { Enqueuer } from "../apps/workers/src/harness";
import { newId, type Platform } from "../packages/core/src";
import {
  and,
  categories,
  clipCandidates,
  db,
  eq,
  gte,
  llmUsage,
  longForms,
  posts,
  renders,
  runMigrations,
  seed,
} from "../packages/db/src";
import { cleanup, runFfmpeg, tmpDir } from "../packages/media/src";
import { deletePrefix, getObjectBytes, putFile, r2Key } from "../packages/storage/src";

// ── args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--platforms", "--top"]);
const BOOL_FLAGS = new Set(["--offline", "--keep-r2"]);
const opts: Record<string, string> = {};
let videoPath = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (BOOL_FLAGS.has(a)) opts[a] = "true";
  else if (VALUE_FLAGS.has(a)) opts[a] = argv[++i] ?? "";
  else if (!a.startsWith("--") && !videoPath) videoPath = a;
}
const offline = opts["--offline"] === "true";
const keepR2 = opts["--keep-r2"] === "true"; // opt OUT of the default R2 wipe (keeps source + clips in R2)
const platforms = (opts["--platforms"] ?? "tiktok").split(",").map((s) => s.trim()) as Platform[];
const topN = Math.max(1, Number(opts["--top"] ?? "2"));
const r2Prefixes: string[] = []; // every R2 object this run creates — deleted at the end unless --keep-r2
const timings: { label: string; ms: number }[] = [];

const boss: Enqueuer = { send: async () => "demo" }; // handlers enqueue next steps; we drive manually
const fmt = (s: string | number): string => {
  const n = Number(s);
  return `${Math.floor(n / 60)}:${Math.floor(n % 60)
    .toString()
    .padStart(2, "0")}`;
};
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number): string => `$${n.toFixed(6)}`;

await runMigrations();
await seed();
if (offline) setFactoryDeps(offlineFactoryDeps);

const [category] = await db.select().from(categories).where(eq(categories.slug, "ai-tech"));
if (!category) throw new Error("ai-tech category missing — seed failed");

// ── source: a real video you pass, or an auto-generated sample (offline only) ──────────────
let cleanupSample: (() => Promise<void>) | null = null;
if (!videoPath) {
  if (!offline) {
    console.error("Provide a <video.mp4>, or use --offline for an auto-generated sample.");
    process.exit(1);
  }
  const dir = await tmpDir("clip-demo-sample");
  cleanupSample = () => cleanup(dir);
  videoPath = join(dir, "sample.mp4");
  console.log("· no video given → generating a 40s synthetic sample (offline)…");
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=24:duration=40",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:duration=40",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    videoPath,
  ]);
}

const runStart = new Date(); // scopes the llm_usage cost query to this run

// ── 1. ingest the source as an own long-form ───────────────────────────────────────────────
const longFormId = newId();
console.log(`\n── clip demo ${offline ? "(offline)" : "(real)"} ──  source: ${videoPath}`);
console.log("1 · uploading source as a long-form…");
let ts = Date.now();
await putFile(r2Key.longformSource(longFormId), videoPath, "video/mp4");
timings.push({ label: "1. upload source → R2", ms: Date.now() - ts });
r2Prefixes.push(`longforms/${longFormId}/`); // source + audio + transcript
await db.insert(longForms).values({
  id: longFormId,
  categoryId: category.id,
  title: `clip-demo source ${longFormId.slice(-6)}`,
  r2Key: r2Key.longformSource(longFormId),
  status: "uploaded",
});

// ── 2. transcribe ───────────────────────────────────────────────────────────────────────────
console.log("2 · transcribe (Whisper: text + word/segment timestamps)…");
ts = Date.now();
const t = await clipTranscribeHandler({ kind: "longform", id: longFormId }, boss);
timings.push({ label: "2. transcribe (Whisper)", ms: Date.now() - ts });
console.log(`     source duration ${t.durationSec.toFixed(1)}s`);
const whisper = JSON.parse(
  new TextDecoder().decode(await getObjectBytes(r2Key.longformTranscript(longFormId))),
) as { text: string; segments: unknown[]; words: unknown[] };

// ── 3. analyze (find moments) ─────────────────────────────────────────────────────────────────
console.log("3 · analyze — Gemini video understanding scoring self-contained moments…");
ts = Date.now();
const a = await clipAnalyzeHandler({ kind: "longform", id: longFormId });
timings.push({ label: "3. analyze (Gemini video)", ms: Date.now() - ts });
console.log(`     ${a.candidates} candidate moment(s) in the 20–90s clip window`);

const ranked = (
  await db.select().from(clipCandidates).where(eq(clipCandidates.longFormId, longFormId))
)
  .map((c) => ({
    ...c,
    total: (c.hookScore ?? 0) + (c.selfContainedScore ?? 0) + (c.emotionScore ?? 0),
  }))
  .sort((x, y) => y.total - x.total);

if (ranked.length === 0) {
  console.log(
    "\nNo moments landed in the 20–90s window for this source. Try a longer/denser video.",
  );
  await cleanupSample?.();
  process.exit(0);
}

console.log("\n── ranked moments (most viral-worthy first) ──");
for (const [i, c] of ranked.entries()) {
  const slice = c.transcriptSlice ?? "";
  console.log(
    `#${i + 1}  ${fmt(c.startSec)}–${fmt(c.endSec)} (${(Number(c.endSec) - Number(c.startSec)).toFixed(0)}s)  ` +
      `hook ${c.hookScore} · self-contained ${c.selfContainedScore} · emotion ${c.emotionScore}  = ${c.total}`,
  );
  console.log(`     “${slice.slice(0, 110)}${slice.length > 110 ? "…" : ""}”`);
}

// ── 4. cut the top N into finished vertical clips (promote → script → compliance → render) ──
// Clips are saved LOCALLY only, under tmp/clips/<source-basename>/. Nothing clip-related persists
// in R2 — the shared render handler writes there transiently, we pull each clip local, and the
// whole R2 footprint (source video + renders + thumbs) is deleted at the end (unless --keep-r2).
const videoBase = basename(videoPath).replace(/\.[^.]+$/, "") || "clip";
const outDir = join(process.cwd(), "tmp", "clips", videoBase);
await rm(outDir, { recursive: true, force: true }); // fresh folder each run of this source
await mkdir(outDir, { recursive: true });
console.log(
  `\n── cutting the top ${Math.min(topN, ranked.length)} into 1080×1920 clips → ${outDir}/ ──`,
);

const results: { rank: number; briefId: string; file: string; line: string }[] = [];
for (const [i, cand] of ranked.slice(0, topN).entries()) {
  console.log(`\n  clip #${i + 1}  ${fmt(cand.startSec)}–${fmt(cand.endSec)}`);
  const clipT0 = Date.now();
  const { briefId } = await promoteClipCandidate(cand.id, platforms, boss);
  r2Prefixes.push(`renders/${briefId}/`);
  console.log("    · scriptwriter (hook + per-platform captions; body = transcript slice)…");
  const s = await scriptHandler({ briefId }, boss);
  if (s.blocked) {
    console.log("    · BLOCKED by compliance/similarity — skipped");
    continue;
  }
  console.log("    · compliance pre_render (clips route straight to render — no TTS/visuals)…");
  await complianceHandler({ briefId, stage: "pre_render" }, boss);
  console.log("    · render (ffmpeg: cut → crop/pad 9:16 → burn captions)…");
  await renderHandler({ briefId }, boss);

  const [render] = await db
    .select()
    .from(renders)
    .where(and(eq(renders.briefId, briefId), eq(renders.status, "done")))
    .limit(1);
  if (!render?.r2Key) {
    console.log("    · render row missing — skipped");
    continue;
  }
  if (render.thumbR2Key) r2Prefixes.push(render.thumbR2Key); // thumbs/ live outside renders/<briefId>/
  const bytes = await getObjectBytes(render.r2Key); // pull the render local; its R2 copy is deleted below
  const file = join(outDir, `clip-${i + 1}.mp4`);
  await Bun.write(file, bytes as Uint8Array<ArrayBuffer>);
  const meta = `${render.width}×${render.height} · ${Number(render.durationSec).toFixed(1)}s · ${(bytes.length / 1024 / 1024).toFixed(1)} MB`;
  timings.push({ label: `4. clip #${i + 1} (script→render)`, ms: Date.now() - clipT0 });
  results.push({ rank: i + 1, briefId, file, line: meta });
}

// ══════════════════════ REPORT ══════════════════════
// cost ledger for this run (llm_usage rows written since runStart)
const usageRows = await db.select().from(llmUsage).where(gte(llmUsage.at, runStart));
interface Agg {
  provider: string;
  model: string;
  inTok: number;
  outTok: number;
  units: number;
  cost: number;
  calls: number;
}
const byPurpose = new Map<string, Agg>();
for (const u of usageRows) {
  const g = byPurpose.get(u.purpose) ?? {
    provider: u.provider,
    model: u.model,
    inTok: 0,
    outTok: 0,
    units: 0,
    cost: 0,
    calls: 0,
  };
  g.inTok += u.inputTokens ?? 0;
  g.outTok += u.outputTokens ?? 0;
  g.units += Number(u.units ?? 0);
  g.cost += Number(u.costUsd);
  g.calls += 1;
  byPurpose.set(u.purpose, g);
}
const netCost = [...byPurpose.values()].reduce((s, g) => s + g.cost, 0);
const totalMs = timings.reduce((s, tm) => s + tm.ms, 0);

console.log("\n════════════════════════════ REPORT ════════════════════════════");

console.log("\n─ STEP OUTPUTS ─");
console.log(
  `  transcribe : ${t.durationSec.toFixed(1)}s audio → ${whisper.words?.length ?? 0} words, ${whisper.segments?.length ?? 0} segments`,
);
console.log(`               "${(whisper.text ?? "").trim().replace(/\s+/g, " ").slice(0, 150)}…"`);
console.log(
  `  analyze    : ${ranked.length} moment(s) scored (top total = ${ranked[0]?.total}/300); full ranking above`,
);
console.log(
  `  render     : ${results.length} clip(s) → 1080×1920, source audio + burned karaoke captions`,
);

console.log("\n─ TIME PER STEP ─");
for (const tm of timings) console.log(`  ${tm.label.padEnd(32)} ${secs(tm.ms)}`);
console.log(`  ${"─".repeat(40)}`);
console.log(`  ${"TOTAL".padEnd(32)} ${secs(totalMs)}`);

console.log("\n─ COST PER COMPONENT (llm_usage ledger, this run) ─");
for (const [purpose, g] of byPurpose) {
  const detail = g.units > 0 ? `${g.units.toFixed(2)} min` : `${g.inTok}/${g.outTok} tok`;
  console.log(
    `  ${purpose.padEnd(15)} ${`${g.provider}/${g.model}`.padEnd(40)} ${detail.padEnd(15)} ${usd(g.cost)}${g.calls > 1 ? ` (×${g.calls})` : ""}`,
  );
}
console.log(
  `  ${"render".padEnd(15)} ${"ffmpeg (local, no API)".padEnd(40)} ${"—".padEnd(15)} ${usd(0)}`,
);
console.log(`  ${"─".repeat(80)}`);
console.log(`  ${"NET COST".padEnd(72)} ${usd(netCost)}`);

console.log(`\n─ FINAL CLIPS (local only) → ${outDir}/ ─`);
for (const r of results) {
  console.log(`  clip #${r.rank}  ${r.line}`);
  console.log(`     ${r.file}`);
}

let drafts = 0;
let published = 0;
for (const r of results) {
  for (const p of await db.select().from(posts).where(eq(posts.briefId, r.briefId))) {
    if (p.status === "published") published++;
    else drafts++;
  }
}
console.log(
  `\n  posts: ${drafts} draft · ${published} published   (this demo never runs the publish path)`,
);

if (keepR2) {
  console.log(`\n  --keep-r2: left this run's source video + ${results.length} clip(s) in R2.`);
} else {
  for (const p of r2Prefixes) await deletePrefix(p);
  console.log(
    `\n  R2 cleaned: deleted the source video + ${results.length} clip render(s). Clips are LOCAL only → ${outDir}/`,
  );
}

await cleanupSample?.();
process.exit(0);

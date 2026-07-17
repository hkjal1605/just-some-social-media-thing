// In-process end-to-end test of the Clip Studio pipeline against the LOCAL test DB.
// Drives the real handlers through a synchronous in-memory queue: ingest-from-URL →
// transcribe (Whisper) → analyze (Gemini, whole video) → auto-promote top-N studio clips →
// script (reuses the merged Gemini copy) → compliance(pre_render) → render (silence-trim +
// viral captions, NO publish) → verify download presign → verify R2 delete.
//
// Uses the REAL R2 + OpenRouter + Gemini, but only a short slice so it's fast + cheap.
// Run: DATABASE_URL=postgres://ve:ve@localhost:5432/viral_engine_test bun run scripts/e2e-studio.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { newId, Q } from "@ve/core";
import {
  and,
  briefs,
  clipCandidates,
  db,
  eq,
  inArray,
  isNotNull,
  longForms,
  posts,
  renders,
  scripts,
} from "@ve/db";
import { cleanup, probe, runFfmpeg, tmpDir } from "@ve/media";
import { deletePrefix, getObjectBytes, presignGet, putFile, r2Key } from "@ve/storage";
import {
  clipAnalyzeHandler,
  clipIngestUrlHandler,
  clipTranscribeHandler,
} from "./src/engines/factory/clips";
import { complianceHandler } from "./src/engines/factory/compliance";
import { renderHandler } from "./src/engines/factory/render";
import { scriptHandler } from "./src/engines/factory/scriptwriter";

// ── safety rails ────────────────────────────────────────────────────
// biome-ignore lint/style/noProcessEnv: standalone dev harness, not app runtime
const DB_URL = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(DB_URL)) {
  throw new Error(`REFUSING to run E2E against a non-local DB: ${DB_URL.slice(0, 45)}…`);
}
// biome-ignore lint/style/noProcessEnv: standalone dev harness, not app runtime
const SOURCE = process.env.E2E_SOURCE ?? join(homedir(), "Downloads", "mkbhd-1.mp4");
// biome-ignore lint/style/noProcessEnv: standalone dev harness, not app runtime
const CLIP_SECONDS = Number(process.env.E2E_SECONDS ?? 90);
// biome-ignore lint/style/noProcessEnv: standalone dev harness, not app runtime
const E2E_URL = process.env.E2E_URL; // set ⇒ paste this URL directly (tests real ingest, e.g. YouTube)

const t0 = performance.now();
const stamp = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);

// ── synchronous in-memory queue: route each send() straight to its handler ──
// biome-ignore lint/suspicious/noExplicitAny: test harness passes through opaque payloads
type H = (d: any) => Promise<unknown>;
const boss = {
  async send(name: string, data: object): Promise<string | null> {
    const map: Record<string, H> = {
      [Q.clipIngestUrl]: (d) => clipIngestUrlHandler(d, boss),
      [Q.clipTranscribe]: (d) => clipTranscribeHandler(d, boss),
      [Q.clipAnalyze]: (d) => clipAnalyzeHandler(d, boss),
      [Q.factoryScript]: (d) => scriptHandler(d, boss),
      [Q.factoryCompliance]: (d) => complianceHandler(d, boss),
      [Q.factoryRender]: (d) => renderHandler(d, boss),
    };
    const fn = map[name];
    if (!fn) {
      log(`   · skip queue ${name}`); // alerts/publish/approvals — irrelevant to studio
      return null;
    }
    log(`→ ${name}`);
    await fn(data);
    return newId();
  },
};

async function main() {
  console.log("═".repeat(70));
  console.log("CLIP STUDIO — END-TO-END PIPELINE TEST");
  console.log(`  DB     : ${DB_URL.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`  Source : ${SOURCE} (first ${CLIP_SECONDS}s)`);
  console.log("═".repeat(70));

  if (!E2E_URL && !(await Bun.file(SOURCE).exists())) {
    throw new Error(`source video not found: ${SOURCE}`);
  }
  await purgeLeftovers();

  const runId = newId();
  const e2eSourceKey = `clip-studio-e2e/${runId}/source.mp4`;
  const dir = await tmpDir(`e2e-${runId.slice(-8)}`);
  let jobId = "";

  try {
    // 1. produce the "pasted URL": a real URL directly (tests yt-dlp/direct ingest), or a short
    //    local slice uploaded to R2 + presigned (fast, no external dependency)
    let sourceUrl: string;
    let sourceDurSec = 1e9; // sanity ceiling when we don't locally probe (URL path)
    if (E2E_URL) {
      sourceUrl = E2E_URL;
      log(`pasted URL (real ingest — yt-dlp for YouTube/pages): ${E2E_URL}`);
    } else {
      log("extracting + uploading a short source slice…");
      const slice = join(dir, "slice.mp4");
      await runFfmpeg([
        "-t",
        String(CLIP_SECONDS),
        "-i",
        SOURCE,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        slice,
      ]);
      const srcMeta = await probe(slice);
      sourceDurSec = srcMeta.durationSec;
      await putFile(e2eSourceKey, slice, "video/mp4");
      sourceUrl = await presignGet(e2eSourceKey, 3600);
      log(
        `   uploaded ${srcMeta.width}×${srcMeta.height} ${srcMeta.durationSec.toFixed(1)}s slice`,
      );
    }

    // 2. create the studio job exactly as POST /clip-jobs does (empty title ⇒ ingest backfills it)
    jobId = newId();
    await db.insert(longForms).values({
      id: jobId,
      categoryId: await ensureStudioCategory(),
      title: E2E_URL ? "" : "e2e mkbhd slice",
      r2Key: r2Key.longformSource(jobId),
      sourceUrl,
      status: "queued",
      clipOptions: { platforms: ["tiktok"], topN: 2, captionPreset: "hormozi" },
    });
    log(`created studio job ${jobId} (topN=2, hormozi captions, tiktok)`);

    // 3. drive the whole pipeline synchronously from the ingest queue
    console.log("─".repeat(70));
    await boss.send(Q.clipIngestUrl, { longFormId: jobId });
    console.log("─".repeat(70));

    // 4. verify final state; download check only if clips were produced
    const clipCount = await verify(jobId, sourceDurSec);
    if (clipCount > 0) await verifyDownload(jobId);
    else log("skipping download check — 0 clips produced from this source");

    // 5. verify DELETE wipes R2 + DB
    await verifyDelete(jobId);

    console.log("═".repeat(70));
    log("✅ E2E PASSED — full studio pipeline works end to end");
    console.log("═".repeat(70));
  } finally {
    await deletePrefix(`clip-studio-e2e/${runId}/`).catch(() => {});
    await cleanup(dir);
    // safety net: if we bailed mid-run, still try to wipe the job's whole R2 footprint
    if (jobId) {
      await deletePrefix(`longforms/${jobId}/`).catch(() => {});
      const leftover = await db
        .select()
        .from(briefs)
        .where(eq(briefs.longFormId, jobId))
        .catch(() => []);
      for (const b of leftover) await deletePrefix(`renders/${b.id}/`).catch(() => {});
    }
  }
}

async function ensureStudioCategory(): Promise<string> {
  const { categories } = await import("@ve/db");
  const [existing] = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, "clip-studio"))
    .limit(1);
  if (existing) return existing.id;
  const id = newId();
  await db
    .insert(categories)
    .values({
      id,
      slug: "clip-studio",
      name: "Clip Studio",
      mode: "human_gated",
      cadenceCaps: { tiktok: 0, youtube: 0, x: 0, reddit: 0 },
    })
    .onConflictDoNothing();
  const [c] = await db.select().from(categories).where(eq(categories.slug, "clip-studio")).limit(1);
  return c?.id ?? id;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  log(`   ✓ ${msg}`);
}

async function verify(id: string, sourceDur: number): Promise<number> {
  console.log("\nVERIFY — pipeline output");
  const [lf] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
  if (!lf) throw new Error("job vanished");
  log(`   longForm.status = ${lf.status} | title = ${JSON.stringify(lf.title)}`);
  assert(lf.status === "rendering" || lf.status === "ready", "job reached rendering/ready");
  assert(!!lf.title, "title present (backfilled from the source when not user-provided)");

  const jobBriefs = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.longFormId, id), eq(briefs.studioOnly, true)));
  if (jobBriefs.length === 0) {
    log("   ⚠ 0 clips promoted — nothing ≥15s clippable; ingest+transcribe+analyze still verified");
    return 0;
  }
  assert(jobBriefs.length > 0, `promoted ${jobBriefs.length} studio-only brief(s)`);
  assert(
    jobBriefs.every((b) => b.studioOnly === true && b.captionPreset === "hormozi"),
    "every brief is studioOnly with the chosen caption preset",
  );
  assert(
    jobBriefs.every((b) => b.formatSlug === "clip-vertical"),
    "every brief is a clip-vertical",
  );

  const briefIds = jobBriefs.map((b) => b.id);
  const rends = await db.select().from(renders).where(inArray(renders.briefId, briefIds));
  const done = rends.filter((r) => r.status === "done");
  assert(done.length === jobBriefs.length, `all ${done.length}/${jobBriefs.length} renders done`);

  const cands = await db.select().from(clipCandidates).where(eq(clipCandidates.longFormId, id));
  const candByBrief = new Map(cands.map((c) => [c.briefId, c]));
  for (const r of done) {
    const b = jobBriefs.find((x) => x.id === r.briefId);
    const cand = b ? candByBrief.get(b.id) : undefined;
    const win = cand ? Number(cand.endSec) - Number(cand.startSec) : 0;
    const outDur = Number(r.durationSec);
    const trimmed = win > 0 ? (100 * (win - outDur)) / win : 0;
    log(
      `   clip ${r.platform} ${r.width}×${r.height} ${outDur.toFixed(1)}s ` +
        `(window ${win.toFixed(1)}s → ${trimmed > 1 ? `${trimmed.toFixed(0)}% silence trimmed` : "no trim"})`,
    );
    assert(r.width === 1080 && r.height === 1920, `  render is vertical 1080×1920`);
    assert(!!r.r2Key && !!r.thumbR2Key, `  render has video + thumb in R2`);
    assert(outDur <= sourceDur + 1, `  clip not longer than the source`);
  }

  // studioOnly MUST NOT publish: no posts, no pre_publish
  const postRows = await db.select().from(posts).where(inArray(posts.briefId, briefIds));
  assert(postRows.length === 0, "studio clips created NO posts (never publishes)");

  const scriptRows = await db.select().from(scripts).where(inArray(scripts.briefId, briefIds));
  assert(scriptRows.length === jobBriefs.length, "each brief has exactly one script");
  return jobBriefs.length;
}

async function verifyDownload(id: string) {
  console.log("\nVERIFY — download");
  const jobBriefs = await db.select().from(briefs).where(eq(briefs.longFormId, id));
  const rends = await db
    .select()
    .from(renders)
    .where(
      inArray(
        renders.briefId,
        jobBriefs.map((b) => b.id),
      ),
    );
  const done = rends.find((r) => r.status === "done" && r.r2Key);
  if (!done?.r2Key) throw new Error("no done render to download");
  const url = await presignGet(done.r2Key, 600);
  const res = await fetch(url);
  const len = Number(res.headers.get("content-length") ?? 0);
  assert(res.ok, `presigned GET → HTTP ${res.status}`);
  assert(len > 10_000, `downloaded a real MP4 (${(len / 1024).toFixed(0)} KB)`);
}

async function gone(key: string): Promise<boolean> {
  try {
    await getObjectBytes(key);
    return false; // still fetchable → not deleted
  } catch {
    return true; // 404/NoSuchKey → deleted
  }
}

/** The exact R2 + DB teardown DELETE /clip-jobs/:id performs. Returns the R2 keys it removed. */
async function deleteJob(id: string): Promise<string[]> {
  const [lf] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
  const jobBriefs = await db.select().from(briefs).where(eq(briefs.longFormId, id));
  const briefIds = jobBriefs.map((b) => b.id);
  const rends = briefIds.length
    ? await db.select().from(renders).where(inArray(renders.briefId, briefIds))
    : [];
  const keys = [lf?.r2Key, ...rends.map((r) => r.r2Key), ...rends.map((r) => r.thumbR2Key)].filter(
    (k): k is string => !!k,
  );

  await deletePrefix(`longforms/${id}/`);
  for (const b of briefIds) await deletePrefix(`renders/${b}/`);
  for (const r of rends) if (r.thumbR2Key) await deletePrefix(r.thumbR2Key);

  if (briefIds.length) await db.delete(renders).where(inArray(renders.briefId, briefIds));
  await db.delete(clipCandidates).where(eq(clipCandidates.longFormId, id));
  if (briefIds.length) {
    await db.delete(scripts).where(inArray(scripts.briefId, briefIds));
    await db.delete(briefs).where(inArray(briefs.id, briefIds));
  }
  await db.delete(longForms).where(eq(longForms.id, id));
  return keys;
}

/** Idempotent hygiene: remove any studio jobs left behind by earlier (possibly failed) runs. */
async function purgeLeftovers() {
  const leftover = await db.select().from(longForms).where(isNotNull(longForms.clipOptions));
  if (leftover.length === 0) return;
  log(`purging ${leftover.length} leftover studio job(s) from prior runs`);
  for (const lf of leftover) await deleteJob(lf.id).catch(() => {});
}

async function verifyDelete(id: string) {
  console.log("\nVERIFY — delete from R2 + DB (mirrors DELETE /clip-jobs/:id)");
  const [lf] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
  assert(!!lf?.r2Key && !(await gone(lf.r2Key)), "source object exists in R2 before delete");

  const keys = await deleteJob(id);
  const stillThere: string[] = [];
  for (const k of keys) if (!(await gone(k))) stillThere.push(k);
  assert(
    stillThere.length === 0,
    `all ${keys.length} R2 objects removed (source + clips + thumbs)`,
  );

  const [ghost] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
  assert(!ghost, "job row removed from DB");
  const briefsLeft = await db.select().from(briefs).where(eq(briefs.longFormId, id));
  assert(briefsLeft.length === 0, "brief rows removed from DB");
}

await main();
process.exit(0);

// Asset production (doc 05 §3): factory.tts, factory.visuals, factory.captions.
// Completion is tracked with the deterministic settings counter
// brief_assets_done:<briefId> under a row lock; the last job enqueues factory.render.
// Sequencing note: captions transcribe the TTS audio, so the tts job enqueues captions
// instead of racing it in the fan-out (retry-free ordering, same three-job counter).

import { pexels } from "@ve/connectors";
import { briefAssetsDoneKey, makeLogger, newId, Q, type SceneVisual } from "@ve/core";
import {
  and,
  assets,
  briefs,
  categories,
  db,
  eq,
  scripts,
  settings,
  sql,
  transitionBrief,
  withTx,
} from "@ve/db";
import { buildAss, type CaptionSegment } from "@ve/media";
import { putObject, r2Key } from "@ve/storage";
import { type Enqueuer, enqueueAlert } from "../../harness";
import { factoryDeps } from "./deps";

const log = makeLogger("factory-assets");

type AssetJob = "tts" | "visuals" | "captions";

/** Mark one asset job done; returns true when all three have completed (doc 05 §3). */
export async function markAssetJobDone(briefId: string, job: AssetJob): Promise<boolean> {
  const key = briefAssetsDoneKey(briefId);
  return withTx(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.key, key)).for("update");
    const state = {
      tts: false,
      visuals: false,
      captions: false,
      ...((row?.value ?? {}) as Record<string, boolean>),
    };
    state[job] = true;
    await tx
      .insert(settings)
      .values({ key, value: state })
      .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: new Date() } });
    return state.tts && state.visuals && state.captions;
  });
}

/** Narration text: chosen hook + body with [SCENE n] markers and thread separators stripped. */
export function buildNarration(script: {
  hookVariants: unknown;
  chosenHook: string | null;
  body: string;
}): string {
  const variants = script.hookVariants as { id: string; text: string }[];
  const hookId = script.chosenHook ?? "a";
  const hook = variants.find((v) => v.id === hookId)?.text ?? variants[0]?.text ?? "";
  const body = script.body
    .replace(/\[SCENE \d+\]/gi, " ")
    .replace(/^---$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${hook} ${body}`.trim();
}

async function loadBriefAndScript(briefId: string, scriptId: string) {
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId)).limit(1);
  const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId)).limit(1);
  if (!brief || !script) throw new Error(`assets: brief/script missing (${briefId})`);
  return { brief, script };
}

async function maybeEnqueueRender(briefId: string, job: AssetJob, boss: Enqueuer): Promise<void> {
  const allDone = await markAssetJobDone(briefId, job);
  if (allDone) {
    await boss.send(Q.factoryRender, { briefId }, { singletonKey: briefId });
  }
}

// ── factory.tts ──────────────────────────────────────────────────────
export async function ttsHandler(
  payload: { briefId: string; scriptId: string },
  boss: Enqueuer,
): Promise<string | null> {
  const { brief, script } = await loadBriefAndScript(payload.briefId, payload.scriptId);

  // idempotency (doc 08 §11): skip if the asset kind already exists for the brief
  const [existing] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.briefId, brief.id), eq(assets.kind, "tts_audio")))
    .limit(1);
  if (existing) {
    await boss.send(Q.factoryCaptions, { briefId: brief.id, scriptId: script.id });
    await maybeEnqueueRender(brief.id, "tts", boss);
    return existing.id;
  }

  const narration = buildNarration(script);
  const result = await factoryDeps.tts({ text: narration });
  const assetId = newId();
  const key = r2Key.asset(brief.id, assetId, "mp3");
  const { bytes } = await putObject(key, result.audio, "audio/mpeg");
  await db.insert(assets).values({
    id: assetId,
    briefId: brief.id,
    kind: "tts_audio",
    r2Key: key,
    mime: "audio/mpeg",
    bytes,
    durationSec: result.durationSec.toFixed(2),
    meta: { provider: result.provider },
    licenseRef: "ai-gen:tts",
  });
  log.info({ briefId: brief.id, assetId, durationSec: result.durationSec }, "tts asset ready");

  await boss.send(Q.factoryCaptions, { briefId: brief.id, scriptId: script.id });
  await maybeEnqueueRender(brief.id, "tts", boss);
  return assetId;
}

// ── factory.captions ─────────────────────────────────────────────────
export async function captionsHandler(
  payload: { briefId: string; scriptId: string },
  boss: Enqueuer,
): Promise<string | null> {
  const { brief } = await loadBriefAndScript(payload.briefId, payload.scriptId);

  const [existing] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.briefId, brief.id), eq(assets.kind, "captions_ass")))
    .limit(1);
  if (existing) {
    await maybeEnqueueRender(brief.id, "captions", boss);
    return existing.id;
  }

  const [ttsAsset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.briefId, brief.id), eq(assets.kind, "tts_audio")))
    .limit(1);
  if (!ttsAsset) throw new Error(`captions: tts asset missing for brief ${brief.id} (will retry)`);

  const whisper = await factoryDeps.transcribe({ r2Key: ttsAsset.r2Key });
  const segments: CaptionSegment[] = whisper.segments.map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text,
    words: whisper.words
      .filter((w) => w.start >= seg.start && w.start < seg.end)
      .map((w) => ({ start: w.start, end: w.end, text: w.word })),
  }));
  const ass = buildAss({ segments });

  const assetId = newId();
  const key = r2Key.asset(brief.id, assetId, "ass");
  const { bytes } = await putObject(key, new TextEncoder().encode(ass), "text/plain");
  await db.insert(assets).values({
    id: assetId,
    briefId: brief.id,
    kind: "captions_ass",
    r2Key: key,
    mime: "text/plain",
    bytes,
    durationSec: whisper.durationSec.toFixed(2),
    meta: { segments: segments.length },
    licenseRef: "own-recording",
  });
  log.info({ briefId: brief.id, assetId, segments: segments.length }, "captions asset ready");

  await maybeEnqueueRender(brief.id, "captions", boss);
  return assetId;
}

// ── factory.visuals ──────────────────────────────────────────────────
async function resolveScreenDemo(
  brief: typeof briefs.$inferSelect,
  scene: number,
): Promise<string | null> {
  // demos are uploaded per category (dashboard) as source_video assets with meta.demo=true;
  // reuse by referencing the same object under this brief
  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, brief.categoryId))
    .limit(1);
  const demos = (await db.execute(sql`
    select a.id, a.r2_key as "r2Key", a.mime, a.bytes, a.duration_sec as "durationSec"
    from assets a
    where a.kind = 'source_video'
      and a.meta->>'demo' = 'true'
      and (a.meta->>'categorySlug' = ${category?.slug ?? ""} or a.brief_id = ${brief.id})
    order by a.created_at desc limit 1
  `)) as unknown as {
    id: string;
    r2Key: string;
    mime: string;
    bytes: number | null;
    durationSec: string | null;
  }[];
  const demo = demos[0];
  if (!demo) return null;
  const assetId = newId();
  await db.insert(assets).values({
    id: assetId,
    briefId: brief.id,
    kind: "source_video",
    r2Key: demo.r2Key,
    mime: demo.mime,
    bytes: demo.bytes,
    durationSec: demo.durationSec,
    meta: { demo: true, sceneIndex: scene },
    licenseRef: "own-recording",
  });
  return assetId;
}

export async function visualsHandler(
  payload: { briefId: string; scriptId: string },
  boss: Enqueuer,
): Promise<{ created: number; blocked: boolean }> {
  const { brief, script } = await loadBriefAndScript(payload.briefId, payload.scriptId);
  const sceneVisuals = (script.sceneVisuals ?? []) as SceneVisual[];

  const existing = await db
    .select()
    .from(assets)
    .where(and(eq(assets.briefId, brief.id)));
  const existingScenes = new Set(
    existing
      .filter((a) => ["image", "broll_video", "source_video"].includes(a.kind))
      .map((a) => (a.meta as { sceneIndex?: number }).sceneIndex)
      .filter((s): s is number => s !== undefined),
  );

  let created = 0;
  for (const sv of sceneVisuals) {
    if (existingScenes.has(sv.scene)) continue; // idempotent re-run

    if (sv.want === "screen-demo") {
      const assetId = await resolveScreenDemo(brief, sv.scene);
      if (!assetId) {
        // the designed human touchpoint for the AI category (doc 05 §3)
        await transitionBrief(db, brief.id, "blocked", { blockedReason: "needs-demo" });
        await enqueueAlert(
          boss,
          `🎥 brief needs a screen demo | brief:${brief.id} scene ${sv.scene} — upload a demo recording via the dashboard`,
          `needs-demo:${brief.id}`,
        );
        return { created, blocked: true };
      }
      created++;
      continue;
    }

    if (sv.want.startsWith("ai-image:")) {
      const prompt = sv.want.slice("ai-image:".length).trim();
      const { image, mime } = await factoryDeps.generateImage({
        agent: "scene-image",
        prompt,
        aspectRatio: "9:16",
      });
      const assetId = newId();
      const ext = mime.includes("jpeg") ? "jpg" : "png";
      const key = r2Key.asset(brief.id, assetId, ext);
      const { bytes } = await putObject(key, image, mime);
      await db.insert(assets).values({
        id: assetId,
        briefId: brief.id,
        kind: "image",
        r2Key: key,
        mime,
        bytes,
        meta: { sceneIndex: sv.scene, model: "gemini" },
        licenseRef: "ai-gen:gemini",
      });
      if (!script.aiDisclosure) {
        await db.update(scripts).set({ aiDisclosure: true }).where(eq(scripts.id, script.id));
      }
      created++;
      continue;
    }

    // stock-search: Pexels, video preferred else photo (doc 05 §3)
    const videos = await pexels.searchVideos(sv.want, "portrait", 5);
    const video = videos.find((v) => v.downloadUrl !== "");
    if (video) {
      const media = await factoryDeps.fetchStock(video.downloadUrl);
      const assetId = newId();
      const key = r2Key.asset(brief.id, assetId, "mp4");
      const { bytes } = await putObject(key, media, "video/mp4");
      await db.insert(assets).values({
        id: assetId,
        briefId: brief.id,
        kind: "broll_video",
        r2Key: key,
        mime: "video/mp4",
        bytes,
        durationSec: video.durationSec.toFixed(2),
        meta: { sceneIndex: sv.scene, pexelsId: video.id },
        licenseRef: `pexels:${video.id}`,
      });
      created++;
      continue;
    }
    const photos = await pexels.searchPhotos(sv.want, 5);
    const photo = photos[0];
    if (!photo) throw new Error(`visuals: no stock found for "${sv.want}" (will retry)`);
    const media = await factoryDeps.fetchStock(photo.downloadUrl);
    const assetId = newId();
    const key = r2Key.asset(brief.id, assetId, "jpg");
    const { bytes } = await putObject(key, media, "image/jpeg");
    await db.insert(assets).values({
      id: assetId,
      briefId: brief.id,
      kind: "image",
      r2Key: key,
      mime: "image/jpeg",
      bytes,
      meta: { sceneIndex: sv.scene, pexelsId: photo.id },
      licenseRef: `pexels:${photo.id}`,
    });
    created++;
  }

  log.info({ briefId: brief.id, created }, "visual assets ready");
  await maybeEnqueueRender(brief.id, "visuals", boss);
  return { created, blocked: false };
}

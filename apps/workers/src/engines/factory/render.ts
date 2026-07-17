// factory.render (doc 05 §4): one render per target platform variant. Download assets
// to tmp → render → probe sanity → thumbnail → upload → renders.done. When every
// platform render is done: posts drafts + compliance(pre_publish).
import { join } from "node:path";
import { env } from "@ve/config";
import {
  FORMATS,
  type FormatSlug,
  makeLogger,
  newId,
  type Platform,
  Q,
  RENDER_DURATION_TOLERANCE,
  TIKTOK_MIN_DURATION_SEC,
  type WhisperResultLike,
} from "@ve/core";
import {
  and,
  assets,
  briefs,
  campaigns,
  clipCandidates,
  db,
  desc,
  eq,
  longForms,
  renders,
  scripts,
  transitionRender,
} from "@ve/db";
import {
  buildAss,
  CAPTION_PRESETS,
  type CaptionSegment,
  cachedDownload,
  chunkWords,
  cleanup,
  computeKeepSegments,
  downloadToTmp,
  type KeepSegment,
  makeTimeMapper,
  prependHookCard,
  probe,
  renderClip,
  renderScreencastVo,
  renderSlideshowVo,
  type SpeakerSample,
  thumbnail,
  tmpDir,
  worthTrimming,
} from "@ve/media";
import { getObjectBytes, putFile, r2Key } from "@ve/storage";
import type { Enqueuer } from "../../harness";
import { createPostsDrafts } from "./compliance";
import { generateClipCover } from "./cover";
import { asdSpeakerTrack } from "./reframe";

const log = makeLogger("factory-render");

const VERTICAL = { w: 1080, h: 1920 } as const;
const HORIZONTAL = { w: 1920, h: 1080 } as const;

function sizeFor(renderKind: string, platform: Platform) {
  // demo-screencast ships 16:9 on X, vertical elsewhere (doc 05 §4)
  if (renderKind === "screencast-vo" && platform === "x") return HORIZONTAL;
  return VERTICAL;
}

interface RenderSanity {
  min: number;
  max: number;
}

/** Duration sanity: format range ±10%; Rewards-eligible VO formats must clear 61s on tiktok. */
export function durationBounds(formatSlug: FormatSlug, platform: Platform): RenderSanity | null {
  const range = FORMATS[formatSlug].durationSec;
  if (!range) return null;
  let min = range[0] * (1 - RENDER_DURATION_TOLERANCE);
  const max = range[1] * (1 + RENDER_DURATION_TOLERANCE);
  if (platform === "tiktok" && range[0] >= TIKTOK_MIN_DURATION_SEC) {
    min = TIKTOK_MIN_DURATION_SEC; // hard floor, no tolerance (doc 05 §4)
  }
  return { min, max };
}

interface BriefAssets {
  tts: typeof assets.$inferSelect | undefined;
  captions: typeof assets.$inferSelect | undefined;
  scenes: (typeof assets.$inferSelect)[];
  demo: typeof assets.$inferSelect | undefined;
}

function collectAssets(rows: (typeof assets.$inferSelect)[]): BriefAssets {
  const scenes = rows
    .filter((a) => ["image", "broll_video"].includes(a.kind))
    .sort((a, b) => {
      const sa = (a.meta as { sceneIndex?: number }).sceneIndex ?? 0;
      const sb = (b.meta as { sceneIndex?: number }).sceneIndex ?? 0;
      return sa - sb;
    });
  return {
    tts: rows.find((a) => a.kind === "tts_audio"),
    captions: rows.find((a) => a.kind === "captions_ass"),
    scenes,
    demo: rows.find(
      (a) => a.kind === "source_video" && (a.meta as { demo?: boolean }).demo === true,
    ),
  };
}

/** Slideshow scenes must be images — extract a representative frame from video b-roll. */
async function sceneImagePaths(scenes: (typeof assets.$inferSelect)[], dir: string) {
  const out: string[] = [];
  for (const [i, scene] of scenes.entries()) {
    const local = await downloadToTmp(scene.r2Key, dir);
    if (scene.kind === "broll_video") {
      const frame = join(dir, `scene-${i}.jpg`);
      await thumbnail(local, 1, frame);
      out.push(frame);
    } else {
      out.push(local);
    }
  }
  return out;
}

/** Captions for clip briefs: slice the source transcript to the window, shifted to 0. */
export function clipCaptionSegments(
  whisper: WhisperResultLike,
  startSec: number,
  endSec: number,
): CaptionSegment[] {
  return whisper.segments
    .filter((seg) => seg.end > startSec && seg.start < endSec)
    .map((seg) => ({
      start: Math.max(0, seg.start - startSec),
      end: Math.min(endSec - startSec, seg.end - startSec),
      text: seg.text,
      words: whisper.words
        .filter(
          (w) => w.start >= Math.max(seg.start, startSec) && w.start < Math.min(seg.end, endSec),
        )
        .map((w) => ({ start: w.start - startSec, end: w.end - startSec, text: w.word })),
    }));
}

async function clipSource(brief: typeof briefs.$inferSelect): Promise<{
  sourceKey: string;
  startSec: number;
  endSec: number;
  transcriptKey: string | null;
}> {
  const [candidate] = await db
    .select()
    .from(clipCandidates)
    .where(eq(clipCandidates.briefId, brief.id))
    .limit(1);
  if (!candidate) throw new Error(`render: clip brief ${brief.id} has no promoted candidate`);
  if (brief.longFormId) {
    const [lf] = await db
      .select()
      .from(longForms)
      .where(eq(longForms.id, brief.longFormId))
      .limit(1);
    if (!lf) throw new Error(`render: long_form ${brief.longFormId} missing`);
    return {
      sourceKey: lf.r2Key,
      startSec: Number(candidate.startSec),
      endSec: Number(candidate.endSec),
      transcriptKey: lf.transcriptR2Key,
    };
  }
  if (brief.campaignId) {
    const [camp] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, brief.campaignId))
      .limit(1);
    if (!camp) throw new Error(`render: campaign ${brief.campaignId} missing`);
    return {
      sourceKey: r2Key.campaignSource(camp.id, "source"),
      startSec: Number(candidate.startSec),
      endSec: Number(candidate.endSec),
      transcriptKey: `campaigns/${camp.id}/transcript.json`,
    };
  }
  throw new Error(`render: clip brief ${brief.id} has neither longFormId nor campaignId`);
}

/** Did the studio job opt this clip into a baked hook-card cover (clip_options.hookCard)? */
async function jobWantsHookCard(brief: typeof briefs.$inferSelect): Promise<boolean> {
  if (!brief.studioOnly || !brief.longFormId) return false;
  const [lf] = await db.select().from(longForms).where(eq(longForms.id, brief.longFormId)).limit(1);
  const opts = lf?.clipOptions as { hookCard?: boolean } | null;
  return opts?.hookCard === true;
}

async function renderOne(
  brief: typeof briefs.$inferSelect,
  script: typeof scripts.$inferSelect,
  briefAssets: BriefAssets,
  platform: Platform,
): Promise<string> {
  const formatSlug = brief.formatSlug as FormatSlug;
  const renderKind = FORMATS[formatSlug].render;
  const size = sizeFor(renderKind, platform);

  const renderId = newId();
  await db.insert(renders).values({
    id: renderId,
    briefId: brief.id,
    scriptId: script.id,
    platform,
    status: "pending",
  });
  await transitionRender(db, renderId, "rendering");

  const dir = await tmpDir(`render-${renderId.slice(-8)}`);
  try {
    const out = join(dir, `${platform}.mp4`);

    if (renderKind === "slideshow-vo") {
      if (!briefAssets.tts || !briefAssets.captions || briefAssets.scenes.length === 0) {
        throw new Error("slideshow-vo requires tts + captions + scene assets");
      }
      const images = await sceneImagePaths(briefAssets.scenes, dir);
      const audioPath = await downloadToTmp(briefAssets.tts.r2Key, dir);
      const assPath = await downloadToTmp(briefAssets.captions.r2Key, dir);
      await renderSlideshowVo({ images, audioPath, assPath, out, size, kenBurns: true });
    } else if (renderKind === "screencast-vo") {
      if (!briefAssets.demo || !briefAssets.captions) {
        throw new Error("screencast-vo requires a demo source_video + captions");
      }
      const videoPath = await downloadToTmp(briefAssets.demo.r2Key, dir);
      const assPath = await downloadToTmp(briefAssets.captions.r2Key, dir);
      const audioPath = briefAssets.tts
        ? await downloadToTmp(briefAssets.tts.r2Key, dir)
        : undefined;
      await renderScreencastVo({
        videoPath,
        ...(audioPath ? { audioPath } : {}),
        assPath,
        out,
        size,
      });
    } else if (renderKind === "clip-captions") {
      const clip = await clipSource(brief);
      const sourcePath = await cachedDownload(clip.sourceKey); // shared cache: source downloaded once per run
      let assPath: string | undefined;
      let keepSegments: KeepSegment[] | undefined;
      if (clip.transcriptKey) {
        try {
          const whisper = JSON.parse(
            new TextDecoder().decode(await getObjectBytes(clip.transcriptKey)),
          ) as WhisperResultLike;
          // silence/filler trim: keep only the spoken spans, drop long internal pauses (research §Part-1)
          const keep = computeKeepSegments(whisper.words ?? [], clip.startSec, clip.endSec);
          const trim =
            (whisper.words?.length ?? 0) > 0 && worthTrimming(keep, clip.startSec, clip.endSec);
          // captions on the (possibly compressed) clip timeline: word times → mapped → chunked 1-3 words
          const mapT = trim ? makeTimeMapper(keep) : (t: number) => t - clip.startSec;
          const capWords = (whisper.words ?? [])
            .filter((wd) => wd.end > clip.startSec && wd.start < clip.endSec)
            .map((wd) => ({
              start: mapT(Math.max(clip.startSec, wd.start)),
              end: mapT(Math.min(clip.endSec, wd.end)),
              text: wd.word,
            }))
            .filter((wd) => wd.end > wd.start);
          let chunked: CaptionSegment[];
          if (capWords.length > 0) {
            const merged: CaptionSegment = {
              start: capWords[0]?.start ?? 0,
              end: capWords[capWords.length - 1]?.end ?? 0,
              text: capWords.map((wd) => wd.text).join(" "),
              words: capWords,
            };
            chunked = chunkWords([merged], 3);
          } else {
            // no word-level timing — fall back to segment slicing (no trim possible)
            chunked = chunkWords(clipCaptionSegments(whisper, clip.startSec, clip.endSec), 3);
          }
          // viral captions: 1-3 words on screen, karaoke highlight, Anton preset, ~65% height
          const preset =
            CAPTION_PRESETS[brief.captionPreset ?? "hormozi"] ?? CAPTION_PRESETS.hormozi;
          if (chunked.length > 0) {
            assPath = join(dir, "clip.ass");
            await Bun.write(
              assPath,
              buildAss({
                segments: chunked,
                style: { ...preset, playResX: size.w, playResY: size.h },
              }),
            );
          }
          if (trim) {
            keepSegments = keep;
            log.info(
              {
                briefId: brief.id,
                windowSec: +(clip.endSec - clip.startSec).toFixed(1),
                keptSec: +keep.reduce((s, k) => s + (k.end - k.start), 0).toFixed(1),
                spans: keep.length,
              },
              "silence-trim applied",
            );
          }
        } catch (err) {
          log.warn({ err, briefId: brief.id }, "clip captions unavailable — rendering without");
        }
      }
      const src = await probe(sourcePath);
      const landscape = src.width > src.height;
      let cropMode: "center" | "blur-pad" | "speaker" = landscape ? "blur-pad" : "center";
      let speakerTrack: SpeakerSample[] | undefined;
      // active-speaker reframe (research §Part-1 #3): studio clips on a landscape source get a 9:16
      // window that follows the talker (+ subtle punch-in) instead of a letterboxed blur-pad. Slow,
      // so scoped to the user-facing studio flow; any ASD failure falls back to blur-pad.
      if (landscape && brief.studioOnly && env.REFRAME_ENABLED) {
        const asd = await asdSpeakerTrack(sourcePath, clip.startSec, clip.endSec, dir);
        if (asd?.track?.length) {
          // map the ASD track (absolute source time) onto the output timeline, honoring silence-trim
          const kept = keepSegments;
          const mapT = kept ? makeTimeMapper(kept) : (tt: number) => tt - clip.startSec;
          const inKept = (tt: number) => !kept || kept.some((k) => tt >= k.start && tt <= k.end);
          const mapped = asd.track
            .filter((s) => inKept(s.t))
            .map((s) => ({ t: mapT(s.t), cx: s.cx, cy: s.cy }));
          if (mapped.length > 0) {
            speakerTrack = mapped;
            cropMode = "speaker";
          }
        }
      }
      await renderClip({
        sourcePath,
        startSec: clip.startSec,
        endSec: clip.endSec,
        out,
        size,
        cropMode,
        ...(assPath ? { assPath } : {}),
        ...(keepSegments ? { keepSegments } : {}),
        ...(speakerTrack ? { speakerTrack } : {}),
      });
    } else {
      throw new Error(`render: unexpected render kind ${renderKind}`);
    }

    // sanity: duration within format range ±10%; tiktok VO floor 61s (doc 05 §4).
    // clip-captions may be silence-trimmed shorter than the format floor — relax the lower bound
    // (a 6s floor still catches a genuinely broken render) while keeping the upper guard.
    const meta = await probe(out);
    const bounds = durationBounds(formatSlug, platform);
    const minBound =
      bounds && renderKind === "clip-captions" ? Math.min(bounds.min, 6) : bounds?.min;
    if (bounds && (meta.durationSec < (minBound ?? 0) || meta.durationSec > bounds.max)) {
      throw new Error(
        `render duration ${meta.durationSec.toFixed(1)}s outside [${(minBound ?? 0).toFixed(1)}, ${bounds.max.toFixed(1)}] for ${formatSlug}/${platform}`,
      );
    }

    const thumbOut = join(dir, "thumb.jpg");
    let thumbOffsetMs: number | null = null;
    let finalOut = out;

    if (renderKind === "clip-captions" && env.COVER_SELECTION_ENABLED) {
      // research-backed cover: best-MOMENT real frame + designed thumbnail (engines/factory/cover.ts)
      const cover = await generateClipCover({
        clipPath: out,
        outDir: dir,
        thumbOut,
        ...(brief.angle ? { context: brief.angle } : {}),
      });
      thumbOffsetMs = cover.coverMs;

      // hook-card bake (per-job, default off): make the designed cover the ACTUAL in-feed cover on
      // X / YouTube Shorts / TikTok — their APIs (and Buffer) won't accept a cover image, only a baked
      // frame; Buffer forwards a frame-offset to TikTok only. So bake once, point the offset at frame 0.
      if (cover.ready && (await jobWantsHookCard(brief))) {
        const baked = join(dir, "clip_card.mp4");
        try {
          await prependHookCard({ clipPath: out, cardImage: thumbOut, out: baked, holdSec: 0.7 });
          finalOut = baked;
          thumbOffsetMs = 0; // the designed card is now frame 0
          log.info({ briefId: brief.id, renderId }, "hook-card baked into clip");
        } catch (err) {
          log.warn(
            { err: String(err).slice(0, 150), briefId: brief.id },
            "hook-card bake failed — posting the clip without it",
          );
        }
      }
    } else {
      await thumbnail(out, 1, thumbOut); // non-clip formats: keep the simple frame grab
    }

    const finalMeta = finalOut === out ? meta : await probe(finalOut);
    const videoKey = r2Key.render(brief.id, renderId, platform);
    const thumbKey = r2Key.thumb(renderId);
    const uploaded = await putFile(videoKey, finalOut, "video/mp4");
    await putFile(thumbKey, thumbOut, "image/jpeg");

    await transitionRender(db, renderId, "done", {
      r2Key: videoKey,
      thumbR2Key: thumbKey,
      ...(thumbOffsetMs != null ? { thumbOffsetMs } : {}),
      width: finalMeta.width,
      height: finalMeta.height,
      durationSec: finalMeta.durationSec.toFixed(2),
      bytes: uploaded.bytes,
    });
    log.info(
      { briefId: brief.id, renderId, platform, durationSec: meta.durationSec },
      "render done",
    );
    return renderId;
  } catch (err) {
    await transitionRender(db, renderId, "failed", {
      ffmpegLog: String(err).slice(-4096),
    }).catch(() => {});
    throw err;
  } finally {
    await cleanup(dir);
  }
}

export async function renderHandler(
  payload: { briefId: string },
  boss: Enqueuer,
): Promise<{ rendered: number; skipped: number }> {
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, payload.briefId)).limit(1);
  if (!brief) {
    // deleted while queued — terminal, not transient; complete cleanly so it never retries
    log.warn({ briefId: payload.briefId }, "render: brief gone — nothing to render");
    return { rendered: 0, skipped: 0 };
  }
  const [script] = await db
    .select()
    .from(scripts)
    .where(eq(scripts.briefId, brief.id))
    .orderBy(desc(scripts.version))
    .limit(1);
  if (!script) throw new Error(`render: no script for brief ${brief.id}`);

  const format = FORMATS[brief.formatSlug as FormatSlug];
  if (format.render === "text-only") return { rendered: 0, skipped: 0 };

  // A clip-captions brief with no promoted candidate can never render — e.g. an editor-picked clip
  // format for a trend (which has no source video), or a candidate deleted with its clip job.
  // Abandon it and complete cleanly rather than throwing and crash-looping through pg-boss retries.
  if (format.render === "clip-captions") {
    const [cand] = await db
      .select()
      .from(clipCandidates)
      .where(eq(clipCandidates.briefId, brief.id))
      .limit(1);
    if (!cand) {
      log.error(
        { briefId: brief.id, originKind: brief.originKind },
        "clip brief has no promoted candidate — abandoned (unrenderable)",
      );
      await db.update(briefs).set({ status: "abandoned" }).where(eq(briefs.id, brief.id));
      return { rendered: 0, skipped: 0 };
    }
  }

  const platforms = (brief.targetPlatforms as Platform[]).filter((p) =>
    (format.platforms as readonly Platform[]).includes(p),
  );
  const briefAssets = collectAssets(
    await db.select().from(assets).where(eq(assets.briefId, brief.id)),
  );

  const existing = await db.select().from(renders).where(eq(renders.briefId, brief.id));
  const doneByPlatform = new Map(
    existing.filter((r) => r.status === "done").map((r) => [r.platform, r.id]),
  );

  // A clip is one identical 1080×1920 vertical video for every target platform, so render it ONCE
  // (not once per platform) and reuse it — no duplicate ffmpeg + speaker-reframe work. Other formats
  // still render per platform (e.g. screencast is 16:9 on X, vertical elsewhere).
  const renderTargets =
    format.render === "clip-captions" && platforms.length > 0
      ? [platforms[0] as Platform]
      : platforms;

  let rendered = 0;
  let skipped = 0;
  for (const platform of renderTargets) {
    if (doneByPlatform.has(platform)) {
      skipped++;
      continue; // idempotency: done render per (brief, platform) is final (doc 08 §11)
    }
    // re-render replaces the failed row (doc 08 §11)
    await db
      .delete(renders)
      .where(
        and(
          eq(renders.briefId, brief.id),
          eq(renders.platform, platform),
          eq(renders.status, "failed"),
        ),
      );
    const renderId = await renderOne(brief, script, briefAssets, platform);
    doneByPlatform.set(platform, renderId);
    rendered++;
  }

  // clips render once: point every target platform at that single render (autopilot posting reuses
  // it; a studio clip just shows the one video).
  if (format.render === "clip-captions") {
    const only = renderTargets[0] ? doneByPlatform.get(renderTargets[0]) : undefined;
    if (only) for (const p of platforms) doneByPlatform.set(p, only);
  }

  // all platform renders done → posts drafts + pre_publish gate (doc 05 §4).
  // studio clips are render-only: never create posts or publish — the user downloads then deletes.
  if (platforms.every((p) => doneByPlatform.has(p)) && !brief.studioOnly) {
    await createPostsDrafts(brief, doneByPlatform as Map<string, string>);
    await boss.send(Q.factoryCompliance, { briefId: brief.id, stage: "pre_publish" });
  }
  return { rendered, skipped };
}

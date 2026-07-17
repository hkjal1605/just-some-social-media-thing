// Clipping pipeline (doc 05 §5): own long-form + licensed campaign footage only.
// clip.transcribe → clip.analyze → (promotion) → clip-vertical brief → factory.render.
import { join } from "node:path";
import {
  CLIP_MAX_SEC,
  CLIP_MIN_SEC,
  ClipMomentsSchema,
  makeLogger,
  newId,
  type Platform,
  Q,
} from "@ve/core";
import {
  and,
  briefs,
  campaigns,
  clipCandidates,
  db,
  eq,
  isNull,
  longForms,
  transitionBrief,
} from "@ve/db";
import { clipAnalyzerPrompt } from "@ve/llm";
import { cachedDownload, cleanup, probe, runFfmpeg, tmpDir } from "@ve/media";
import { getObjectBytes, putFile, putObject, r2Key } from "@ve/storage";
import type { Enqueuer } from "../../harness";
import { factoryDeps } from "./deps";
import { downloadWithYtDlp, isDirectMediaUrl } from "./ytdlp";

const log = makeLogger("factory-clips");

interface ClipSource {
  kind: "longform" | "campaign";
  id: string;
  sourceKey: string;
  transcriptKey: string;
  audioKey: string;
  categoryId: string | null;
}

// Returns null when the source row is gone (e.g. the clip job was deleted while queued) — callers
// treat that as a TERMINAL, non-retryable condition and abort cleanly instead of throwing.
async function resolveSource(
  kind: "longform" | "campaign",
  id: string,
): Promise<ClipSource | null> {
  if (kind === "longform") {
    const [lf] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
    if (!lf) return null;
    return {
      kind,
      id,
      sourceKey: lf.r2Key,
      transcriptKey: r2Key.longformTranscript(id),
      audioKey: `longforms/${id}/audio.mp3`,
      categoryId: lf.categoryId,
    };
  }
  const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!camp) return null;
  return {
    kind,
    id,
    sourceKey: r2Key.campaignSource(id, "source"), // upload convention: single source.mp4
    transcriptKey: `campaigns/${id}/transcript.json`,
    audioKey: `campaigns/${id}/audio.mp3`,
    categoryId: camp.categoryId,
  };
}

// ── clip.transcribe (doc 05 §5) ──────────────────────────────────────
export async function clipTranscribeHandler(
  payload: { kind: "longform" | "campaign"; id: string },
  boss: Enqueuer,
): Promise<{ transcriptKey: string; durationSec: number }> {
  const src = await resolveSource(payload.kind, payload.id);
  if (!src) {
    log.warn({ kind: payload.kind, id: payload.id }, "clip source gone — transcribe aborted");
    return { transcriptKey: "", durationSec: 0 };
  }
  const dir = await tmpDir(`transcribe-${payload.id.slice(-8)}`);
  try {
    const videoPath = await cachedDownload(src.sourceKey); // shared cache: downloaded once, reused by renders
    const sourceMeta = await probe(videoPath);

    // extract mono 16k audio as MP3 (doc 05 §5). MP3 not WAV because OpenRouter's Whisper multipart
    // caps at 25 MB: 16k mono WAV is ~1.9 MB/min (>25 MB past ~13 min); 48 kbps mp3 is ~0.36 MB/min
    // (an hour ≈ 21 MB) and Whisper transcribes it identically.
    const audioPath = join(dir, "audio.mp3");
    await runFfmpeg(["-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audioPath]);
    await putFile(src.audioKey, audioPath, "audio/mpeg");

    const whisper = await factoryDeps.transcribe({ r2Key: src.audioKey });
    await putObject(
      src.transcriptKey,
      new TextEncoder().encode(JSON.stringify(whisper)),
      "application/json",
    );

    if (payload.kind === "longform") {
      await db
        .update(longForms)
        .set({
          transcriptR2Key: src.transcriptKey,
          durationSec: Math.round(sourceMeta.durationSec),
          status: "transcribed",
        })
        .where(eq(longForms.id, payload.id));
    }
    await boss.send(Q.clipAnalyze, { kind: payload.kind, id: payload.id });
    log.info(
      { kind: payload.kind, id: payload.id, durationSec: sourceMeta.durationSec },
      "transcribed",
    );
    return { transcriptKey: src.transcriptKey, durationSec: sourceMeta.durationSec };
  } finally {
    await cleanup(dir);
  }
}

// ── clip.analyze (doc 05 §5) ─────────────────────────────────────────
export async function clipAnalyzeHandler(
  payload: { kind: "longform" | "campaign"; id: string },
  boss?: Enqueuer,
): Promise<{ candidates: number }> {
  const src = await resolveSource(payload.kind, payload.id);
  if (!src) {
    log.warn({ kind: payload.kind, id: payload.id }, "clip source gone — analyze aborted");
    return { candidates: 0 };
  }
  // studio jobs carry a genre hint + auto-clip options on the long_form
  const lf =
    payload.kind === "longform"
      ? (await db.select().from(longForms).where(eq(longForms.id, payload.id)).limit(1))[0]
      : undefined;
  const whisper = JSON.parse(new TextDecoder().decode(await getObjectBytes(src.transcriptKey))) as {
    durationSec: number;
    segments: { start: number; end: number; text: string }[];
  };

  const transcriptText = whisper.segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");

  const sourcePath = await cachedDownload(src.sourceKey); // reuse the cached source (no re-download)
  const result = await factoryDeps.analyzeVideo({
    agent: "clip-analyzer",
    r2Key: src.sourceKey,
    sourcePath,
    prompt: clipAnalyzerPrompt(transcriptText, lf?.genre ?? undefined),
    schema: ClipMomentsSchema,
    fps: whisper.durationSec > 1200 ? "low" : "default", // >20 min → low fps (doc 05 §5)
  });

  // analyzeVideo above can run for MINUTES; if the job was deleted meanwhile (the user removed the
  // clip job, or re-submitted the same source), the long_form/campaign row is gone and the candidate
  // inserts below would violate clip_candidates_long_form_id_long_forms_id_fk — a dangling-FK error
  // that pg-boss then retries in a loop. Re-check the source still exists and abort gracefully
  // (terminal, no retry) if it was removed mid-analyze. The promote/render tail is guarded too.
  if (!(await resolveSource(payload.kind, payload.id))) {
    log.warn(
      { kind: payload.kind, id: payload.id },
      "clip source deleted during analyze — aborting before candidate insert",
    );
    return { candidates: 0 };
  }

  // idempotency (doc 08 §11): a retry re-runs analyzeVideo, so first clear this source's
  // un-promoted candidates (promoted ones — briefId set — are kept) to avoid duplicate inserts (M8)
  await db
    .delete(clipCandidates)
    .where(
      and(
        payload.kind === "longform"
          ? eq(clipCandidates.longFormId, payload.id)
          : eq(clipCandidates.campaignId, payload.id),
        isNull(clipCandidates.briefId),
      ),
    );

  let inserted = 0;
  for (const m of result.moments) {
    const startSec = Math.max(0, m.startSec);
    const endSec = Math.min(m.endSec, whisper.durationSec || m.endSec);
    const len = endSec - startSec;
    if (len < CLIP_MIN_SEC || len > CLIP_MAX_SEC) {
      log.debug({ startSec, endSec }, "moment outside 15-90s window — dropped");
      continue;
    }
    await db.insert(clipCandidates).values({
      id: newId(),
      longFormId: payload.kind === "longform" ? payload.id : null,
      campaignId: payload.kind === "campaign" ? payload.id : null,
      startSec: startSec.toFixed(2),
      endSec: endSec.toFixed(2),
      hookScore: Math.round(m.hookScore),
      selfContainedScore: Math.round(m.selfContainedScore),
      emotionScore: Math.round(m.emotionScore),
      transcriptSlice: m.transcriptSlice,
      // merged: the same Gemini call wrote the clip's copy — stored so no scriptwriter call runs
      scriptData: { hookVariants: m.hookVariants, perPlatformCaptions: m.perPlatformCaptions },
    });
    inserted++;
  }

  if (payload.kind === "longform") {
    await db.update(longForms).set({ status: "analyzed" }).where(eq(longForms.id, payload.id));
  }

  // clip-studio one-click auto-promotion: promote the top-N moments as render-only studio clips
  const opts = lf?.clipOptions as
    | { platforms?: Platform[]; topN?: number; captionPreset?: string; minScore?: number }
    | null
    | undefined;
  if (lf && opts && boss) {
    const cands = await db
      .select()
      .from(clipCandidates)
      .where(and(eq(clipCandidates.longFormId, lf.id), isNull(clipCandidates.briefId)));
    const ranked = cands
      .map((c) => ({ id: c.id, total: c.hookScore + c.selfContainedScore + c.emotionScore }))
      .filter((r) => r.total >= (opts.minScore ?? 0) * 3)
      .sort((a, b) => b.total - a.total)
      .slice(0, Math.max(1, opts.topN ?? 3));
    for (const r of ranked) {
      await promoteClipCandidate(r.id, opts.platforms ?? ["tiktok"], boss, {
        studioOnly: true,
        ...(opts.captionPreset ? { captionPreset: opts.captionPreset } : {}),
      });
    }
    await db
      .update(longForms)
      .set({ status: ranked.length > 0 ? "rendering" : "ready" })
      .where(eq(longForms.id, lf.id));
    log.info({ longFormId: lf.id, promoted: ranked.length }, "studio auto-promoted top-N clips");
  }

  log.info({ kind: payload.kind, id: payload.id, candidates: inserted }, "moments analyzed");
  return { candidates: inserted };
}

// ── promotion (doc 05 §5): candidate → clip-vertical brief ───────────
export async function promoteClipCandidate(
  candidateId: string,
  targetPlatforms: Platform[],
  boss: Enqueuer,
  opts?: { studioOnly?: boolean; captionPreset?: string },
): Promise<{ briefId: string } | null> {
  const [candidate] = await db
    .select()
    .from(clipCandidates)
    .where(eq(clipCandidates.id, candidateId))
    .limit(1);
  if (!candidate) throw new Error(`promote: clip candidate ${candidateId} missing`);
  if (candidate.briefId) return { briefId: candidate.briefId }; // already promoted

  const src = await resolveSource(
    candidate.longFormId ? "longform" : "campaign",
    candidate.longFormId ?? candidate.campaignId ?? "",
  );
  if (!src) {
    log.warn({ candidateId }, "clip source gone — promote skipped");
    return null;
  }
  if (!src.categoryId) {
    throw new Error(`promote: ${src.kind} ${src.id} has no category — set one first`);
  }

  const briefId = newId();
  await db.insert(briefs).values({
    id: briefId,
    categoryId: src.categoryId,
    originKind: candidate.longFormId ? "longform_clip" : "campaign_clip",
    longFormId: candidate.longFormId,
    campaignId: candidate.campaignId,
    status: "draft",
    angle: (candidate.transcriptSlice ?? "clip highlight").slice(0, 300),
    formatSlug: "clip-vertical",
    targetPlatforms,
    studioOnly: opts?.studioOnly ?? false,
    ...(opts?.captionPreset ? { captionPreset: opts.captionPreset } : {}),
  });
  await db.update(clipCandidates).set({ briefId }).where(eq(clipCandidates.id, candidateId));
  // The regular auto-clip pipeline marks the source "clipped" here. Studio jobs own their own
  // status lifecycle (analyzed → rendering → ready, derived in the API) and must NOT be stamped
  // with "clipped" — it isn't in the studio status vocabulary and would blank the UI badge.
  if (candidate.longFormId && !opts?.studioOnly) {
    await db
      .update(longForms)
      .set({ status: "clipped" })
      .where(eq(longForms.id, candidate.longFormId));
  }
  await boss.send(Q.factoryScript, { briefId });
  log.info({ candidateId, briefId }, "clip candidate promoted to brief");
  return { briefId };
}

/** clip.cut is the render step for clip briefs — same handler, doc 05 §5. */
export async function clipCutHandler(
  payload: { clipCandidateId: string; briefId: string },
  boss: Enqueuer,
): Promise<void> {
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, payload.briefId)).limit(1);
  if (!brief) throw new Error(`clip.cut: brief ${payload.briefId} missing`);
  if (brief.status === "blocked") {
    await transitionBrief(db, brief.id, "producing");
  }
  await boss.send(Q.factoryRender, { briefId: payload.briefId }, { singletonKey: payload.briefId });
}

// ── clip.ingest_url (clip-studio): resolve a pasted URL (YouTube/any site via yt-dlp, or a direct
// video-file URL) into R2, backfill the title, then transcribe ──
export async function clipIngestUrlHandler(
  payload: { longFormId: string },
  boss: Enqueuer,
): Promise<void> {
  const [lf] = await db
    .select()
    .from(longForms)
    .where(eq(longForms.id, payload.longFormId))
    .limit(1);
  if (!lf) throw new Error(`clip.ingest_url: long_form ${payload.longFormId} missing`);
  if (!lf.sourceUrl) {
    throw new Error(`clip.ingest_url: long_form ${payload.longFormId} has no sourceUrl`);
  }
  await db.update(longForms).set({ status: "ingesting" }).where(eq(longForms.id, lf.id));
  try {
    const direct = isDirectMediaUrl(lf.sourceUrl);
    let bytes = 0;
    let metaTitle: string | null = null;
    if (direct) {
      // direct video-file URL (R2/S3/CDN/presigned): stream the bytes straight into R2
      const res = await fetch(lf.sourceUrl);
      if (!res.ok) throw new Error(`fetch ${lf.sourceUrl.slice(0, 80)} → ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      await putObject(lf.r2Key, buf, res.headers.get("content-type") ?? "video/mp4");
      bytes = buf.length;
      try {
        metaTitle =
          decodeURIComponent(new URL(lf.sourceUrl).pathname.split("/").pop() ?? "") || null;
      } catch {
        metaTitle = null;
      }
    } else {
      // YouTube / any supported site or page URL: yt-dlp extracts the real stream, muxes to mp4
      const dir = await tmpDir(`ingest-${lf.id.slice(-8)}`);
      try {
        const dl = await downloadWithYtDlp(lf.sourceUrl, dir);
        await putFile(lf.r2Key, dl.path, "video/mp4");
        bytes = Bun.file(dl.path).size;
        metaTitle = dl.title;
      } finally {
        await cleanup(dir);
      }
    }
    await db
      .update(longForms)
      .set({
        status: "transcribing",
        // backfill a human title from the source only when the user didn't type one (title is "")
        ...(!lf.title && metaTitle ? { title: metaTitle } : {}),
      })
      .where(eq(longForms.id, lf.id));
    await boss.send(Q.clipTranscribe, { kind: "longform", id: lf.id });
    log.info(
      { longFormId: lf.id, bytes, via: direct ? "direct" : "yt-dlp" },
      "ingested clip source",
    );
  } catch (err) {
    await db.update(longForms).set({ status: "error" }).where(eq(longForms.id, lf.id));
    throw err;
  }
}

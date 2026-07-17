// Cover-frame selection (research-backed): the clip's cover should be its real PEAK MOMENT, lightly
// enhanced — never fabricated bait (YouTube's misleading-thumbnail policy + retention penalties).
// Pipeline: services/asd/cover.py CV-shortlists the strongest frames → a Gemini call picks the most
// EXPRESSIVE one + a ≤3-word hook → composeThumbnail turns it into the designed cover. Every stage
// degrades gracefully (naive mid-clip frame) so a render never fails over its thumbnail. Returns the
// best-moment offset (ms) so clip.publish can hand it to Buffer as thumbnailOffset (the TikTok cover).
import { join } from "node:path";
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";
import { pickThumbnailFrame } from "@ve/llm";
import { composeThumbnail, probe, thumbnail } from "@ve/media";

const log = makeLogger("factory-cover");

// cover.py lives in services/asd and reuses that service's Python venv (opencv + numpy).
const ASD_DIR = env.ASD_SERVICE_DIR || join(import.meta.dir, "../../../../../services/asd");
const ASD_PYTHON = env.ASD_PYTHON || join(ASD_DIR, ".venv", "bin", "python");

interface CoverCandidate {
  index: number;
  ms: number;
  t: number;
  file: string;
  score: number;
}
interface CoverPyResult {
  ok: boolean;
  durationSec: number;
  candidates: CoverCandidate[];
  cvBest?: CoverCandidate;
}

/** Run cover.py to CV-shortlist candidate frames; null on any failure (caller falls back). */
async function cvShortlist(clipPath: string, outDir: string): Promise<CoverPyResult | null> {
  if (!(await Bun.file(ASD_PYTHON).exists())) {
    log.warn({ ASD_PYTHON }, "cover: python venv not found — naive frame fallback");
    return null;
  }
  const framesDir = join(outDir, "cover-frames");
  const outJson = join(outDir, "cover.json");
  try {
    const proc = Bun.spawn(
      [
        ASD_PYTHON,
        join(ASD_DIR, "cover.py"),
        clipPath,
        "--out",
        outJson,
        "--frames-dir",
        framesDir,
        "--fps",
        "2",
        "--shortlist",
        "6",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), env.COVER_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).slice(-300);
      log.warn({ code, err }, "cover.py exited non-zero — naive frame fallback");
      return null;
    }
    const parsed = JSON.parse(await Bun.file(outJson).text()) as CoverPyResult;
    return parsed?.candidates?.length ? parsed : null;
  } catch (err) {
    log.warn({ err: String(err).slice(0, 200) }, "cover.py unavailable — naive frame fallback");
    return null;
  }
}

export interface ClipCoverResult {
  coverMs: number | null; // best-moment offset (ms) into the clip; null if undetermined
  ready: boolean; // a designed thumbnail was successfully written to thumbOut
}

/**
 * Generate the designed cover for a rendered clip → written to `thumbOut`. CV shortlist (cover.py) →
 * Gemini expressive pick + hook → composeThumbnail. Falls back to a mid-clip frame (still contrast-
 * popped) if any stage fails, so thumbOut always ends up with a usable image.
 */
export async function generateClipCover(opts: {
  clipPath: string;
  outDir: string;
  thumbOut: string;
  context?: string; // the clip's angle/topic, for Gemini relevance
}): Promise<ClipCoverResult> {
  const wantHook = env.COVER_TEXT_HOOK;
  const hookFile = join(opts.outDir, "hook.txt");
  const shortlist = await cvShortlist(opts.clipPath, opts.outDir);

  if (shortlist?.candidates?.length) {
    let chosen: CoverCandidate | undefined = shortlist.cvBest ?? shortlist.candidates[0];
    let hook = "";
    try {
      const frames = await Promise.all(
        shortlist.candidates.map(async (c) => ({
          index: c.index,
          bytes: new Uint8Array(await Bun.file(c.file).arrayBuffer()),
        })),
      );
      const pick = await pickThumbnailFrame({
        agent: "thumbnail-picker",
        frames,
        ...(opts.context ? { context: opts.context } : {}),
      });
      chosen = shortlist.candidates.find((c) => c.index === pick.best) ?? chosen;
      if (wantHook) hook = pick.hook;
      log.info({ coverMs: chosen?.ms, hook }, "cover: gemini pick");
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200) }, "cover: gemini re-rank failed — CV top frame");
    }
    if (chosen) {
      try {
        await composeThumbnail({
          baseFrame: chosen.file,
          out: opts.thumbOut,
          ...(wantHook && hook ? { hookText: hook, hookFile } : {}),
        });
        return { coverMs: chosen.ms, ready: true };
      } catch (err) {
        log.warn({ err: String(err).slice(0, 150) }, "cover: compose failed — naive fallback");
      }
    }
  }

  // fallback: a mid-clip frame (much better than the old frame@1s), contrast-popped, no hook
  try {
    const meta = await probe(opts.clipPath);
    const at = Math.max(1, (meta.durationSec || 4) * 0.4);
    const raw = join(opts.outDir, "raw-frame.jpg");
    await thumbnail(opts.clipPath, at, raw);
    await composeThumbnail({ baseFrame: raw, out: opts.thumbOut });
    return { coverMs: Math.round(at * 1000), ready: true };
  } catch (err) {
    log.warn({ err: String(err).slice(0, 150) }, "cover: fallback compose failed — plain grab");
    await thumbnail(opts.clipPath, 1, opts.thumbOut);
    return { coverMs: null, ready: false };
  }
}

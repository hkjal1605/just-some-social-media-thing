// Designed clip cover/thumbnail (research: real peak-MOMENT frame, lightly enhanced — NOT AI bait).
// - composeThumbnail: turn a chosen frame into a cover — cover-fit to 9:16, a contrast/saturation pop,
//   and an optional ≤3-word curiosity hook burned in the top safe-zone (Anton, heavy stroke + plate).
// - prependHookCard: bake that cover as a short freeze-frame at the clip START. That's the ONLY way a
//   designed cover reaches the X / YouTube Shorts / TikTok feed — their APIs (and Buffer) refuse a
//   custom cover image; at most Buffer forwards a frame-offset to TikTok.
import { join } from "node:path";
import { FONTS_DIR } from "./ass";
import { escapeFilterPath, runFfmpeg } from "./ffmpeg";
import { probe } from "./probe";
import { ENCODE_ARGS } from "./render";

// Anton (OFL) — the same heavy condensed face used for viral captions; legible at grid/preview size.
const HOOK_FONT = join(FONTS_DIR, "Anton-Regular.ttf");

export interface ComposeThumbnailOpts {
  baseFrame: string; // the chosen frame (JPEG)
  out: string; // output JPEG path
  hookText?: string; // ≤3-word uppercase hook; burned in when present
  hookFile?: string; // temp path to write the hook to (avoids drawtext escaping) — required with hookText
  width?: number; // default 1080
  height?: number; // default 1920
}

/** Compose the designed cover: cover-fit 9:16 + contrast/saturation pop + optional burned hook. */
export async function composeThumbnail(opts: ComposeThumbnailOpts): Promise<void> {
  const w = opts.width ?? 1080;
  const h = opts.height ?? 1920;
  const filters = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    // subject pop: lift contrast first, then saturation, a touch of brightness (research §A #2/#7)
    "eq=contrast=1.12:saturation=1.28:brightness=0.02",
  ];
  if (opts.hookText && opts.hookFile) {
    // textfile avoids escaping the hook's own characters; only the PATHS need filter-escaping.
    await Bun.write(opts.hookFile, opts.hookText);
    filters.push(
      `drawtext=fontfile='${escapeFilterPath(HOOK_FONT)}':textfile='${escapeFilterPath(opts.hookFile)}':` +
        // white text, heavy black stroke + a translucent plate → legible on any busy frame; top safe-zone
        "fontcolor=white:fontsize=96:borderw=9:bordercolor=black:box=1:boxcolor=black@0.42:boxborderw=26:" +
        "line_spacing=8:x=(w-text_w)/2:y=h*0.13",
    );
  }
  await runFfmpeg([
    "-i",
    opts.baseFrame,
    "-vf",
    filters.join(","),
    "-frames:v",
    "1",
    "-q:v",
    "2",
    opts.out,
  ]);
}

export interface HookCardOpts {
  clipPath: string; // the rendered clip
  cardImage: string; // the composed cover to bake in
  out: string; // output mp4 (clip with the card prepended)
  holdSec?: number; // how long the card holds (default 0.7s)
}

/** Prepend the designed cover as a ~0.7s freeze-frame so it becomes the platform's in-feed cover. */
export async function prependHookCard(opts: HookCardOpts): Promise<void> {
  const hold = (opts.holdSec ?? 0.7).toFixed(2);
  const meta = await probe(opts.clipPath);
  const w = meta.width || 1080;
  const h = meta.height || 1920;
  const inputs = ["-loop", "1", "-t", hold, "-i", opts.cardImage, "-i", opts.clipPath];
  // normalize both video streams to identical size/sar/fps/pix_fmt so concat won't reject them
  const fc = [
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30,format=yuv420p[card]`,
    `[1:v]scale=${w}:${h},setsar=1,fps=30,format=yuv420p[v]`,
    "[card][v]concat=n=2:v=1:a=0[outv]",
  ];
  const maps = ["-map", "[outv]"];
  if (meta.hasAudio) {
    // prepend matching silence for the card, then the clip's (resampled) audio
    inputs.push("-f", "lavfi", "-t", hold, "-i", "anullsrc=r=44100:cl=stereo");
    fc.push("[1:a]aresample=44100,aformat=channel_layouts=stereo[a1]");
    fc.push("[2:a][a1]concat=n=2:v=0:a=1[outa]");
    maps.push("-map", "[outa]");
  }
  await runFfmpeg([...inputs, "-filter_complex", fc.join(";"), ...maps, ...ENCODE_ARGS, opts.out]);
}

// Render pipeline (doc 03 §8): H.264 High CRF 21, AAC 192k, +faststart,
// captions burned with libass, -t guard, 10-min timeout, explicit args only.
import { FONTS_DIR } from "./ass";
import { escapeFilterPath, runFfmpeg } from "./ffmpeg";
import { probe } from "./probe";
import { type KeepSegment, keptDuration } from "./trim";

export interface Size {
  w: number;
  h: number;
}

export const ENCODE_ARGS = [
  "-c:v",
  "libx264",
  "-profile:v",
  "high",
  "-preset",
  "veryfast",
  "-crf",
  "21",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-movflags",
  "+faststart",
];

const MAX_OUTPUT_SEC = 300; // -t guard: nothing we render should exceed 5 minutes

function subtitlesFilter(assPath: string): string {
  return `subtitles=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(FONTS_DIR)}'`;
}

/** slideshow-vo: Ken Burns over scene images + VO + burned captions (faceless-explainer). */
export async function renderSlideshowVo(opts: {
  images: string[];
  audioPath: string;
  assPath: string;
  out: string;
  size: Size;
  kenBurns: boolean;
}): Promise<void> {
  if (opts.images.length === 0) throw new Error("renderSlideshowVo: no images");
  const { durationSec: audioDur } = await probe(opts.audioPath);
  if (audioDur <= 0) throw new Error("renderSlideshowVo: audio has no duration");
  const per = audioDur / opts.images.length;
  const fps = 30;
  const framesPer = Math.max(1, Math.round(per * fps));
  const { w, h } = opts.size;

  const args: string[] = [];
  for (const img of opts.images) {
    // kenBurns: feed ONE still frame per image — zoompan's d=framesPer then emits exactly `per`
    // seconds of zoom from it. (Looping the input with -t per would feed ~fps·per frames and
    // zoompan multiplies d frames PER input frame, so image 1 alone overran the whole video and
    // scenes 2..n never rendered — H5.) Non-kenBurns keeps the looped still.
    if (opts.kenBurns) args.push("-i", img);
    else args.push("-loop", "1", "-t", per.toFixed(3), "-i", img);
  }
  args.push("-i", opts.audioPath);

  // 1.3x oversample is enough headroom for a 1.12x zoom — 2x makes zoompan
  // prohibitively slow at 1080×1920 (it renders every frame at source size)
  const ow = Math.round((w * 1.3) / 2) * 2;
  const oh = Math.round((h * 1.3) / 2) * 2;
  const chains: string[] = [];
  for (let i = 0; i < opts.images.length; i++) {
    if (opts.kenBurns) {
      // oversample → slow zoom, centered
      chains.push(
        `[${i}:v]scale=${ow}:${oh}:force_original_aspect_ratio=increase,` +
          `crop=${ow}:${oh},` +
          `zoompan=z='min(zoom+0.0012,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${framesPer}:s=${w}x${h}:fps=${fps},` +
          `setsar=1[v${i}]`,
      );
    } else {
      chains.push(
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`,
      );
    }
  }
  const concatInputs = opts.images.map((_, i) => `[v${i}]`).join("");
  chains.push(`${concatInputs}concat=n=${opts.images.length}:v=1:a=0[vc]`);
  chains.push(`[vc]${subtitlesFilter(opts.assPath)}[vout]`);

  await runFfmpeg([
    ...args,
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[vout]",
    "-map",
    `${opts.images.length}:a`,
    ...ENCODE_ARGS,
    "-t",
    Math.min(audioDur + 0.5, MAX_OUTPUT_SEC).toFixed(3),
    opts.out,
  ]);
}

/** screencast-vo: demo video scaled/cropped, VO over ducked demo audio, captions. */
export async function renderScreencastVo(opts: {
  videoPath: string;
  audioPath?: string;
  assPath: string;
  out: string;
  size: Size;
}): Promise<void> {
  const { w, h } = opts.size;
  const src = await probe(opts.videoPath);
  const videoChain =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,` +
    `${subtitlesFilter(opts.assPath)}[vout]`;

  const args: string[] = ["-i", opts.videoPath];
  const filters: string[] = [videoChain];
  let mapAudio: string[];
  let tGuard = Math.min(src.durationSec || MAX_OUTPUT_SEC, MAX_OUTPUT_SEC);

  if (opts.audioPath) {
    args.push("-i", opts.audioPath);
    const vo = await probe(opts.audioPath);
    tGuard = Math.min(Math.max(vo.durationSec, 1) + 0.5, MAX_OUTPUT_SEC);
    if (src.hasAudio) {
      // duck the demo audio under the VO (doc 05 §4)
      filters.push(
        "[0:a]volume=0.25[da];[1:a][da]amix=inputs=2:duration=first:dropout_transition=2[aout]",
      );
      mapAudio = ["-map", "[aout]"];
    } else {
      mapAudio = ["-map", "1:a"];
    }
  } else if (src.hasAudio) {
    mapAudio = ["-map", "0:a"];
  } else {
    mapAudio = []; // silent screencast
  }

  await runFfmpeg([
    ...args,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    ...mapAudio,
    ...ENCODE_ARGS,
    "-t",
    tGuard.toFixed(3),
    opts.out,
  ]);
}

/** A normalized active-speaker sample on the OUTPUT timeline (already silence-trim-mapped by caller). */
export interface SpeakerSample {
  t: number;
  cx: number;
  cy: number;
}

/** clip-captions: cut + crop (center) / blur-pad / speaker-follow 16:9→9:16 + optional captions.
 *  `keepSegments` cuts+concats only the spoken spans (silence removed). `cropMode:"speaker"` with a
 *  `speakerTrack` pans a 9:16 window to the active talker and gently punches in during held shots. */
export async function renderClip(opts: {
  sourcePath: string;
  startSec: number;
  endSec: number;
  out: string;
  size: Size;
  cropMode: "center" | "blur-pad" | "speaker";
  assPath?: string;
  keepSegments?: KeepSegment[];
  speakerTrack?: SpeakerSample[];
}): Promise<void> {
  const { w, h } = opts.size;
  const dur = opts.endSec - opts.startSec;
  if (dur <= 0) throw new Error("renderClip: endSec must be after startSec");
  const src = await probe(opts.sourcePath);
  const subs = opts.assPath ? `,${subtitlesFilter(opts.assPath)}` : "";

  // speaker-follow: a 9:16 crop that pans to the talker (sendcmd crop@sp x/y) and gently zooms in
  // during a held shot, resetting on a speaker switch (a large cx jump) — motivated, not mechanical.
  let speakerCore = "";
  if (opts.cropMode === "speaker" && opts.speakerTrack && opts.speakerTrack.length > 0) {
    const srcW = src.width;
    const srcH = src.height;
    const SWITCH = 0.14; // normalized cx jump ⇒ a cut to a different speaker
    const MAX_ZOOM = 1.06; // ≤6% tighten during a held shot
    const RATE = 0.015; // zoom-in per second held
    // sendcmd HOLDS each value until the next command, so emitting once per 5 fps ASD sample made the
    // crop window snap every 0.2s — a staircase that reads as ~5 fps judder. Fix: build the per-sample
    // targets, then resample to the output frame rate with LINEAR interpolation (the window glides),
    // SNAP across a speaker-switch (cuts stay crisp), and EMA-smooth the path into a gentle virtual-
    // camera motion. Deduped emits keep static holds from bloating the command file.
    const CMD_FPS = 30;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    interface CropTarget {
      t: number;
      cw: number;
      ch: number;
      x: number;
      y: number;
      cut: boolean; // this sample is a jump to a different speaker (don't interpolate into it)
    }
    const targets: CropTarget[] = [];
    let sinceSwitch = 0;
    const tr = opts.speakerTrack;
    for (let i = 0; i < tr.length; i++) {
      const s = tr[i];
      if (!s) continue;
      const prev = i > 0 ? tr[i - 1] : undefined;
      let cut = false;
      if (prev) {
        if (Math.abs(s.cx - prev.cx) > SWITCH) {
          sinceSwitch = 0;
          cut = true;
        } else {
          sinceSwitch += Math.max(0, s.t - prev.t);
        }
      }
      const zoom = Math.min(MAX_ZOOM, 1 + RATE * sinceSwitch);
      let ch = Math.round(srcH / zoom / 2) * 2;
      let cw = Math.round((ch * w) / h / 2) * 2; // keep the 9:16 target aspect
      if (cw > srcW) {
        cw = Math.floor(srcW / 2) * 2;
        ch = Math.round((cw * h) / w / 2) * 2;
      }
      const x = clamp(s.cx * srcW - cw / 2, 0, srcW - cw);
      const y = clamp(s.cy * srcH - ch / 2, 0, srcH - ch);
      targets.push({ t: Math.max(0, s.t), cw, ch, x, y, cut });
    }

    const cmds: string[] = [];
    let init = { w: 0, h: 0, x: 0, y: 0 };
    const ALPHA = 0.3; // EMA responsiveness (~0.09s time constant at 30 fps): smooth but not laggy
    let smX: number | null = null;
    let smY: number | null = null;
    let lastW: number | null = null;
    let lastH: number | null = null;
    let lastX: number | null = null;
    let lastY: number | null = null;
    let first = true;
    // emit only the crop params that actually changed (static shots ⇒ almost no commands)
    const emit = (t: number, cw: number, ch: number, x: number, y: number): void => {
      const T = t.toFixed(3);
      if (cw !== lastW) {
        cmds.push(`${T} crop@sp w ${cw};`);
        lastW = cw;
      }
      if (ch !== lastH) {
        cmds.push(`${T} crop@sp h ${ch};`);
        lastH = ch;
      }
      if (x !== lastX) {
        cmds.push(`${T} crop@sp x ${x};`);
        lastX = x;
      }
      if (y !== lastY) {
        cmds.push(`${T} crop@sp y ${y};`);
        lastY = y;
      }
    };
    // EMA-smooth a raw target and emit (snap the smoother to the target on a speaker cut / first frame)
    const place = (
      t: number,
      cw: number,
      ch: number,
      rx: number,
      ry: number,
      cut: boolean,
    ): void => {
      if (cut || smX === null || smY === null) {
        smX = rx;
        smY = ry;
      } else {
        smX += ALPHA * (rx - smX);
        smY += ALPHA * (ry - smY);
      }
      const cwi = Math.min(srcW, Math.round(cw / 2) * 2);
      const chi = Math.min(srcH, Math.round(ch / 2) * 2);
      const xi = clamp(Math.round(smX), 0, srcW - cwi);
      const yi = clamp(Math.round(smY), 0, srcH - chi);
      if (first) {
        init = { w: cwi, h: chi, x: xi, y: yi };
        first = false;
      }
      emit(t, cwi, chi, xi, yi);
    };

    const dt = 1 / CMD_FPS;
    for (let i = 0; i < targets.length - 1; i++) {
      const a = targets[i];
      const b = targets[i + 1];
      if (!a || !b) continue;
      const span = Math.max(dt, b.t - a.t);
      const steps = Math.max(1, Math.round(span / dt));
      for (let k = 0; k < steps; k++) {
        const u = k / steps;
        const t = a.t + span * u;
        if (b.cut) {
          place(t, a.cw, a.ch, a.x, a.y, false); // hold the current framing across the gap
        } else {
          place(
            t,
            a.cw + (b.cw - a.cw) * u,
            a.ch + (b.ch - a.ch) * u,
            a.x + (b.x - a.x) * u,
            a.y + (b.y - a.y) * u,
            false,
          );
        }
      }
      if (b.cut) place(b.t, b.cw, b.ch, b.x, b.y, true); // hard snap to the new speaker
    }
    const lastTarget = targets[targets.length - 1];
    if (lastTarget) {
      place(lastTarget.t, lastTarget.cw, lastTarget.ch, lastTarget.x, lastTarget.y, false);
    }
    const cmdFile = `${opts.out}.crop.txt`;
    await Bun.write(cmdFile, cmds.join("\n"));
    speakerCore =
      `sendcmd=f='${escapeFilterPath(cmdFile)}',` +
      `crop@sp=w=${init.w}:h=${init.h}:x=${init.x}:y=${init.y},` +
      `scale=${w}:${h},setsar=1${subs}`;
  }

  // reframing/pad chain from an input label → [vout]
  const cropChain = (inLabel: string) => {
    if (speakerCore) return `${inLabel}${speakerCore}[vout]`;
    return opts.cropMode === "center"
      ? `${inLabel}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1${subs}[vout]`
      : `${inLabel}split=2[bg][fg];` +
          `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=24[bgb];` +
          `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs];` +
          `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1${subs}[vout]`;
  };

  // silence-trimmed path: trim each kept span (absolute source times), concat, then reframe.
  const keep = opts.keepSegments;
  if (keep && keep.length > 0) {
    const vparts = keep.map(
      (s, i) => `[0:v]trim=${s.start.toFixed(3)}:${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
    );
    const aparts = src.hasAudio
      ? keep.map(
          (s, i) =>
            `[0:a]atrim=${s.start.toFixed(3)}:${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
        )
      : [];
    const cin = keep.map((_, i) => (src.hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
    const concat = `${cin}concat=n=${keep.length}:v=1:a=${src.hasAudio ? 1 : 0}[vc]${src.hasAudio ? "[ac]" : ""}`;
    const filter = [...vparts, ...aparts, concat, cropChain("[vc]")].join(";");
    await runFfmpeg([
      "-i",
      opts.sourcePath,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      ...(src.hasAudio ? ["-map", "[ac]"] : []),
      ...ENCODE_ARGS,
      "-t",
      Math.min(keptDuration(keep) + 0.5, MAX_OUTPUT_SEC).toFixed(3),
      opts.out,
    ]);
    return;
  }

  // simple single-window cut
  await runFfmpeg([
    "-ss",
    opts.startSec.toFixed(3),
    "-t",
    Math.min(dur, MAX_OUTPUT_SEC).toFixed(3),
    "-i",
    opts.sourcePath,
    "-filter_complex",
    cropChain("[0:v]"),
    "-map",
    "[vout]",
    ...(src.hasAudio ? ["-map", "0:a"] : []),
    ...ENCODE_ARGS,
    opts.out,
  ]);
}

/** First-frame-ish thumbnail (doc 05 §4: at 1 s). */
export async function thumbnail(videoPath: string, atSec: number, out: string): Promise<void> {
  await runFfmpeg([
    "-ss",
    Math.max(0, atSec).toFixed(3),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    out,
  ]);
}

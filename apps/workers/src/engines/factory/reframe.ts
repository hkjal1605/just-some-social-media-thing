// Active-speaker reframing (research §Part-1 #3): call the Light-ASD service (services/asd) to get a
// smoothed face-center track for a clip window, so the render can crop a 9:16 window that FOLLOWS /
// switches to whoever is talking instead of letterboxing a static 16:9 frame. Best-effort: any
// failure (service missing, weights absent, timeout) returns null and the caller falls back to blur-pad.
import { join } from "node:path";
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";

const log = makeLogger("factory-reframe");

export interface SpeakerSample {
  t: number; // seconds, absolute in the SOURCE video
  cx: number; // 0..1 normalized horizontal center of the active speaker
  cy: number; // 0..1 normalized vertical center
}
export interface SpeakerTrackResult {
  sourceW: number;
  sourceH: number;
  fps: number;
  method: string; // "light-asd" | "face-only" | "center-fallback" | …
  track: SpeakerSample[];
}

// services/asd lives at the repo root; this file is apps/workers/src/engines/factory/*.
const ASD_DIR = env.ASD_SERVICE_DIR || join(import.meta.dir, "../../../../../services/asd");
const ASD_PYTHON = env.ASD_PYTHON || join(ASD_DIR, ".venv", "bin", "python");
const ASD_TIMEOUT_MS = env.ASD_TIMEOUT_MS;

/** Run the ASD service on [startSec,endSec] of sourcePath; null on any failure (caller falls back). */
export async function asdSpeakerTrack(
  sourcePath: string,
  startSec: number,
  endSec: number,
  outDir: string,
): Promise<SpeakerTrackResult | null> {
  if (!(await Bun.file(ASD_PYTHON).exists())) {
    log.warn({ ASD_PYTHON }, "ASD service venv not found — falling back to blur-pad");
    return null;
  }
  const outJson = join(outDir, "asd-track.json");
  try {
    const proc = Bun.spawn(
      [
        ASD_PYTHON,
        join(ASD_DIR, "detect.py"),
        sourcePath,
        "--out",
        outJson,
        "--start",
        startSec.toFixed(2),
        "--end",
        endSec.toFixed(2),
        "--fps",
        "5",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), ASD_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).slice(-400);
      log.warn({ code, err }, "ASD service exited non-zero — falling back to blur-pad");
      return null;
    }
    const parsed = JSON.parse(await Bun.file(outJson).text()) as SpeakerTrackResult;
    if (!parsed?.track?.length) return null;
    log.info(
      {
        method: parsed.method,
        samples: parsed.track.length,
        windowSec: +(endSec - startSec).toFixed(1),
      },
      "ASD speaker track ready",
    );
    return parsed;
  } catch (err) {
    log.warn(
      { err: String(err).slice(0, 200) },
      "ASD service unavailable — falling back to blur-pad",
    );
    return null;
  }
}

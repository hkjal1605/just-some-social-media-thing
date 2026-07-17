import { runFfprobe } from "./ffmpeg";

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probe(localPath: string): Promise<ProbeResult> {
  const out = await runFfprobe([
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    localPath,
  ]);
  const json = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  const durationSec = Number.parseFloat(
    json.format?.duration ?? video?.duration ?? audio?.duration ?? "0",
  );
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: audio !== undefined,
  };
}

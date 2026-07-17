// Clip Studio source ingest: resolve a pasted URL to a local video file. Direct video-file URLs are
// downloaded straight; anything else (YouTube watch pages, other supported sites) goes through
// yt-dlp, which extracts the real stream and merges to mp4. ffmpeg (already a repo dep) does the mux.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";

const log = makeLogger("factory-ytdlp");

const VIDEO_EXT = /\.(mp4|mkv|webm|m4v|mov|avi|m3u8)$/i;

/** A URL whose path points straight at a media file (R2/S3/CDN links, presigned URLs) — no yt-dlp. */
export function isDirectMediaUrl(url: string): boolean {
  try {
    return VIDEO_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Download `url` via yt-dlp into `dir`; returns the local mp4 path + the source's title (if any). */
export async function downloadWithYtDlp(
  url: string,
  dir: string,
): Promise<{ path: string; title: string | null }> {
  const maxH = env.YTDLP_MAX_HEIGHT;
  const args = [
    // prefer ≤maxH mp4 video + m4a audio; fall back to best combined ≤maxH; last resort best-anything
    "-f",
    `bv*[height<=${maxH}]+ba/b[height<=${maxH}]/b`,
    "--merge-output-format",
    "mp4",
    "--no-playlist", // a playlist/channel URL ⇒ just the one video
    "--no-progress",
    "--write-info-json", // for the title
    "-o",
    join(dir, "source.%(ext)s"),
    url,
  ];
  log.info({ url: url.slice(0, 100), maxH }, "yt-dlp: downloading source");
  const proc = Bun.spawn([env.YTDLP_PATH, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), env.YTDLP_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).slice(-600);
    throw new Error(`yt-dlp failed (exit ${code}) for ${url.slice(0, 80)} — ${err}`);
  }

  const files = readdirSync(dir);
  const video = files.find((f) => f.startsWith("source.") && VIDEO_EXT.test(f));
  if (!video)
    throw new Error(`yt-dlp produced no video file (dir has: ${files.join(", ") || "∅"})`);

  let title: string | null = null;
  const infoName = files.find((f) => f.endsWith(".info.json"));
  if (infoName) {
    try {
      const info = JSON.parse(await Bun.file(join(dir, infoName)).text()) as { title?: string };
      title = info.title?.trim() || null;
    } catch {
      // best-effort — a missing/garbled title just means we keep the user/URL-derived one
    }
  }
  log.info({ file: video, title }, "yt-dlp: download complete");
  return { path: join(dir, video), title };
}

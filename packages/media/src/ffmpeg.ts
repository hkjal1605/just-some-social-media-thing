// FFmpeg via Bun.spawn with explicit args — never shell-interpolated strings (doc 03 §8).
import { makeLogger } from "@ve/core";

const log = makeLogger("media");

export class MediaError extends Error {
  constructor(
    public readonly tool: "ffmpeg" | "ffprobe",
    public readonly exitCode: number | null,
    public readonly logTail: string,
  ) {
    super(`${tool} exited ${exitCode}: ${logTail.slice(-500)}`);
    this.name = "MediaError";
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10-min process timeout (doc 03 §8)

async function run(
  tool: "ffmpeg" | "ffprobe",
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([tool, ...args], { stdout: "pipe", stderr: "pipe" });
  const killTimer = setTimeout(() => {
    log.error({ tool, args: args.slice(0, 8) }, "process timeout — killing");
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new MediaError(tool, exitCode, stderr.slice(-4096));
    return { stdout, stderr };
  } finally {
    clearTimeout(killTimer);
  }
}

export async function runFfmpeg(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const { stderr } = await run(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", ...args],
    timeoutMs,
  );
  return stderr; // ffmpeg logs to stderr; empty on clean runs at loglevel error
}

export async function runFfprobe(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await run("ffprobe", ["-v", "error", ...args], timeoutMs);
  return stdout;
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Paths inside filtergraph options need ':' , '\' and quotes escaped. */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

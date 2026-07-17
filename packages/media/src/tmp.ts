// Temp workspace: tmp/ under the repo root (gitignored), always cleaned in finally (doc 03 §8).
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { extname, join } from "node:path";
import { newId } from "@ve/core";
import { getObjectBytes } from "@ve/storage";

const TMP_ROOT = join(process.cwd(), "tmp");
const CACHE_DIR = join(TMP_ROOT, "cache");
const CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB LRU cap — bounded so it can't leak (H10)
const inflight = new Map<string, Promise<string>>();

export async function tmpDir(prefix: string): Promise<string> {
  const dir = join(TMP_ROOT, `${prefix}-${newId()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

/**
 * Download an R2 object to a temp file. Pass the caller's `dir` (its tmpDir) so the file is cleaned
 * when that workspace is — every render/clip job cleans its tmpDir in `finally`, but nothing ever
 * cleaned the old shared tmp/dl/, so GB-scale sources leaked until the disk filled (H10). `dir`
 * defaults to tmp/dl/ only for callers that manage cleanup themselves.
 */
export async function downloadToTmp(r2Key: string, dir?: string): Promise<string> {
  const targetDir = dir ?? join(TMP_ROOT, "dl");
  await mkdir(targetDir, { recursive: true });
  const ext = extname(r2Key) || ".bin";
  const path = join(targetDir, `${newId()}${ext}`);
  // Buffer via the resilient getObjectBytes (presigned fetch + timeout + retry): remote-R2 reads
  // transiently STALL under Bun with no timeout otherwise, hanging the job. Fine for clip sources;
  // a multi-GB source would want streaming, but correctness-over-hang wins here.
  const bytes = await getObjectBytes(r2Key);
  await Bun.write(path, bytes as Uint8Array<ArrayBuffer>);
  return path;
}

/** LRU eviction: delete oldest cached files (by mtime) until `incoming` bytes fit under the cap. */
async function evictToFit(incoming: number): Promise<void> {
  const names = await readdir(CACHE_DIR).catch(() => [] as string[]);
  const files: { path: string; size: number; mtime: number }[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue; // skip in-progress .tmp downloads
    const s = await stat(join(CACHE_DIR, n)).catch(() => null);
    if (s?.isFile()) files.push({ path: join(CACHE_DIR, n), size: s.size, mtime: s.mtimeMs });
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total + incoming <= CACHE_MAX_BYTES) return;
  files.sort((x, y) => x.mtime - y.mtime); // oldest first
  for (const f of files) {
    if (total + incoming <= CACHE_MAX_BYTES) break;
    await rm(f.path, { force: true }).catch(() => {});
    total -= f.size;
  }
}

/**
 * Download an R2 object to a SHARED local cache (tmp/cache/), keyed by r2Key, so repeated reads of
 * the same source — every clip render cutting from one long-form, plus transcribe + analyze — pull
 * it down ONCE. Sources are immutable (written once under a unique id), so cache staleness is a
 * non-issue. LRU-capped so it can't leak; atomic (temp→rename) + in-flight dedup for concurrent jobs.
 * Use for large re-read SOURCES; use downloadToTmp for per-job unique assets (its dir is auto-cleaned).
 */
export async function cachedDownload(r2Key: string): Promise<string> {
  const path = join(CACHE_DIR, r2Key.replace(/[^a-zA-Z0-9._-]/g, "_"));
  if (await Bun.file(path).exists()) {
    await utimes(path, new Date(), new Date()).catch(() => {}); // LRU touch on hit
    return path;
  }
  const existing = inflight.get(r2Key);
  if (existing) return existing;
  const job = (async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    const bytes = await getObjectBytes(r2Key);
    await evictToFit(bytes.byteLength);
    const tmp = join(CACHE_DIR, `.dl-${newId()}.tmp`);
    await Bun.write(tmp, bytes as Uint8Array<ArrayBuffer>);
    await rename(tmp, path).catch(async (err) => {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    });
    return path;
  })();
  inflight.set(r2Key, job);
  try {
    return await job;
  } finally {
    inflight.delete(r2Key);
  }
}

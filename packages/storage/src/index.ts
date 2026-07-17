// @ve/storage — R2 via S3 API (MinIO in dev, in-memory driver under test) (doc 03 §4).
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";

export * from "./keys";

const log = makeLogger("storage");

const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // >100 MB → multipart (doc 03 §4)

// In-memory driver for tests (doc 01 §8: CI storage tests use a stub, not MinIO).
const memoryMode = env.APP_ENV === "test";
const memoryStore = new Map<string, { bytes: Uint8Array; mime: string }>();

let _s3: S3Client | null = null;
function s3(): S3Client {
  _s3 ??= new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: env.APP_ENV !== "production", // MinIO needs path style; R2 works with virtual-host
  });
  return _s3;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function putObject(
  key: string,
  body: Uint8Array | ReadableStream<Uint8Array>,
  mime: string,
): Promise<{ key: string; bytes: number }> {
  if (memoryMode) {
    const bytes = body instanceof Uint8Array ? body : await streamToBytes(body);
    memoryStore.set(key, { bytes, mime });
    return { key, bytes: bytes.byteLength };
  }
  if (body instanceof Uint8Array) {
    await s3().send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: mime,
      }),
    );
    return { key, bytes: body.byteLength };
  }
  // unknown-length stream → multipart upload handles it
  const upload = new Upload({
    client: s3(),
    params: { Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: mime },
  });
  const result = await upload.done();
  log.debug({ key, etag: result.ETag }, "stream upload done");
  return { key, bytes: -1 };
}

/** Streams a local file (renders, long-forms) — multipart when >100 MB. */
export async function putFile(
  key: string,
  localPath: string,
  mime: string,
): Promise<{ key: string; bytes: number }> {
  const info = await stat(localPath);
  if (memoryMode) {
    const bytes = new Uint8Array(await Bun.file(localPath).arrayBuffer());
    memoryStore.set(key, { bytes, mime });
    return { key, bytes: bytes.byteLength };
  }
  if (info.size > MULTIPART_THRESHOLD_BYTES) {
    const upload = new Upload({
      client: s3(),
      params: {
        Bucket: env.R2_BUCKET,
        Key: key,
        Body: Bun.file(localPath).stream(),
        ContentType: mime,
      },
      partSize: 32 * 1024 * 1024,
    });
    await upload.done();
  } else {
    await s3().send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        Body: new Uint8Array(await Bun.file(localPath).arrayBuffer()),
        ContentType: mime,
      }),
    );
  }
  return { key, bytes: info.size };
}

export async function getObjectStream(key: string): Promise<ReadableStream<Uint8Array>> {
  if (memoryMode) {
    const hit = memoryStore.get(key);
    if (!hit) throw new Error(`storage: no such key ${key}`);
    return new Response(hit.bytes as Uint8Array<ArrayBuffer>).body as ReadableStream<Uint8Array>;
  }
  const res = await s3().send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`storage: empty body for ${key}`);
  // Under Bun the SDK's transformToWebStream() can stall on Node-Readable bodies —
  // convert explicitly when the body is a Node stream.
  if (res.Body instanceof Readable) {
    return Readable.toWeb(res.Body) as unknown as ReadableStream<Uint8Array>;
  }
  return res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  if (memoryMode) {
    const hit = memoryStore.get(key);
    if (!hit) throw new Error(`storage: no such key ${key}`);
    return hit.bytes;
  }
  // Bun-native fetch on a presigned URL, with a per-attempt timeout + retry. Multi-MB reads from
  // REMOTE R2 can transiently STALL under Bun (both the AWS SDK Node stream AND a plain stream),
  // and nothing else in the path has a timeout — an untimed stall hangs the worker indefinitely.
  const url = await presignGet(key, 900);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`GET ${key} → ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      clearTimeout(timer);
      return bytes;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      log.warn(
        { key, attempt, err: String(e).slice(0, 100) },
        "getObjectBytes stalled/failed — retrying",
      );
    }
  }
  throw new Error(
    `storage: getObjectBytes(${key}) failed after 3 attempts: ${String(lastErr).slice(0, 150)}`,
  );
}

/**
 * Public URL for a key when the bucket has public access (R2_PUBLIC_BASE_URL set — r2.dev or a
 * custom domain); null otherwise. Used to hand LLM providers a plainly-fetchable media URL for
 * external fetches (e.g. video clip analysis), avoiding presigned-URL edge cases. Requires the
 * bucket/object to be publicly readable — do NOT use for anything that must stay private.
 */
export function publicUrl(key: string): string | null {
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  return base ? `${base}/${key.replace(/^\/+/, "")}` : null;
}

/** Presigned GET — TG/dashboard previews 1 h TTL, Ayrshare media 24 h TTL (doc 00 §5.5). */
export async function presignGet(key: string, ttlSec = 3600): Promise<string> {
  if (memoryMode) return `memory://${env.R2_BUCKET}/${key}?ttl=${ttlSec}`;
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), {
    expiresIn: ttlSec,
  });
}

/** Presigned PUT — dashboard uploads long-forms straight to R2 (doc 11 /longforms). */
export async function presignPut(key: string, mime: string, ttlSec = 3600): Promise<string> {
  if (memoryMode) return `memory://${env.R2_BUCKET}/${key}?put&ttl=${ttlSec}`;
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: mime }),
    { expiresIn: ttlSec },
  );
}

/** Brief cleanup (doc 03 §4) — batch-deletes every object under the prefix. */
export async function deletePrefix(prefix: string): Promise<void> {
  if (memoryMode) {
    for (const k of [...memoryStore.keys()]) if (k.startsWith(prefix)) memoryStore.delete(k);
    return;
  }
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: env.R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key ?? "" })).filter((o) => o.Key);
    if (keys.length > 0) {
      await s3().send(
        new DeleteObjectsCommand({
          Bucket: env.R2_BUCKET,
          Delete: { Objects: keys },
        }),
      );
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/** healthz probe. */
export async function headBucket(): Promise<boolean> {
  if (memoryMode) return true;
  try {
    await s3().send(new HeadBucketCommand({ Bucket: env.R2_BUCKET }));
    return true;
  } catch {
    return false;
  }
}

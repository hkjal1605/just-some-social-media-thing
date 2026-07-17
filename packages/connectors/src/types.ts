// Common connector surface (doc 03 §6): everything returns NormalizedItem and logs api_usage.
import { env, type IntegrationFlag, integrations } from "@ve/config";
import { type Logger, MediaTypeSchema, makeLogger, type Platform, PlatformSchema } from "@ve/core";
import { type ApiUsageInput, recordApiUsage } from "@ve/db";
import { z } from "zod";

export const log: Logger = makeLogger("connectors");

export interface NormalizedItem {
  platform: Platform;
  externalId: string;
  url: string;
  author?: string;
  title?: string;
  text?: string;
  mediaType?: "video" | "image" | "text" | "link";
  thumbnailUrl?: string;
  durationSec?: number;
  publishedAt?: Date;
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    score?: number;
  };
}

export const NormalizedItemSchema = z.object({
  platform: PlatformSchema,
  externalId: z.string().min(1),
  url: z.string().url(),
  author: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  mediaType: MediaTypeSchema.optional(),
  thumbnailUrl: z.string().optional(),
  durationSec: z.number().optional(),
  publishedAt: z.date().optional(),
  metrics: z.object({
    views: z.number().optional(),
    likes: z.number().optional(),
    comments: z.number().optional(),
    shares: z.number().optional(),
    score: z.number().optional(),
  }),
});

export class ConnectorError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    body: string,
  ) {
    super(`${service} ${status}: ${body.slice(0, 400)}`);
    this.name = "ConnectorError";
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Fixture mode: APP_ENV=test or the integration flag is off (doc 03 §6). */
export function fixtureMode(flag: IntegrationFlag): boolean {
  return env.APP_ENV === "test" || !integrations[flag];
}

/**
 * Load a recorded fixture from packages/connectors/fixtures/, reviving publishedAt dates.
 * Timestamps are REBASED so the newest one is ~2 h ago (relative spacing preserved):
 * fixture mode must stay "fresh" forever, or the radar's 7-day stale-item guard would
 * silently drop everything as the recorded JSON ages.
 */
export async function loadFixture<T = NormalizedItem[]>(name: string): Promise<T> {
  const path = new URL(`../fixtures/${name}.json`, import.meta.url).pathname;
  const raw = (await Bun.file(path).json()) as unknown;
  const DATE_KEYS = new Set(["publishedAt", "createdAt"]);

  const dates: Date[] = [];
  const revive = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (DATE_KEYS.has(k) && typeof val === "string") {
          const d = new Date(val);
          dates.push(d);
          out[k] = d;
        } else {
          out[k] = revive(val);
        }
      }
      return out;
    }
    return v;
  };
  const revived = revive(raw);

  if (dates.length > 0) {
    const newest = Math.max(...dates.map((d) => d.getTime()));
    const shiftMs = Date.now() - 2 * 3_600_000 - newest;
    if (shiftMs > 0) for (const d of dates) d.setTime(d.getTime() + shiftMs);
  }
  return revived as T;
}

/** api_usage is a meter, never a failure path. Fixture-mode calls are free and unlogged. */
export async function logUsage(u: ApiUsageInput): Promise<void> {
  try {
    await recordApiUsage(u);
  } catch (err) {
    log.warn({ err, service: u.service }, "api_usage write failed (metering is best-effort)");
  }
}

export async function fetchJson<T = unknown>(
  service: ApiUsageInput["service"],
  url: string,
  init?: RequestInit,
  opts: { retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 2; // idempotent GETs only — callers pass 0 for writes
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const err = new ConnectorError(service, res.status, await res.text());
        if (!err.retryable || attempt === retries) throw err;
        lastErr = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (err) {
      if (err instanceof ConnectorError) {
        lastErr = err;
        if (!err.retryable || attempt === retries) throw err;
      } else if (attempt === retries) {
        throw err;
      } else {
        lastErr = err;
      }
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastErr;
}

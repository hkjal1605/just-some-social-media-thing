// Ayrshare — the audited posting rail for all four platforms (doc 06 §2).
// ⚠️ Field names follow the docs as of research date (12 Jul 2026) — verify against
// current Ayrshare docs when credentials land and adjust ONLY in this module.
import { env } from "@ve/config";
import { ConnectorError, fetchJson, fixtureMode, loadFixture, logUsage } from "./types";

const BASE_DEFAULT = "https://api.ayrshare.com/api";

// Test seam (doc 06 §8: "tests spin a stub Ayrshare server"): when set, calls hit the
// override URL and bypass fixture mode so the real serialization/parsing is exercised.
let baseOverride: string | null = null;
export function setAyrshareBaseUrl(url: string | null): void {
  baseOverride = url;
}
function base(): string {
  return baseOverride ?? BASE_DEFAULT;
}
function useFixtures(): boolean {
  return baseOverride === null && fixtureMode("ayrshare");
}
/**
 * Reads may fall back to fixtures anywhere (keeps the pipeline runnable uncredentialed), but a WRITE
 * must NEVER be faked in production — returning the success fixture would mark a post 'published'
 * with a fabricated permalink for a post that never went out (H7). Refuse loudly (503 → the job
 * retries) until Ayrshare is actually configured.
 */
function refuseFakeWriteInProd(action: string): void {
  if (env.APP_ENV === "production") {
    throw new AyrshareError(
      503,
      `Ayrshare not configured — refusing to fake ${action} in production`,
    );
  }
}

export type AyrsharePlatform = "tiktok" | "youtube" | "twitter" | "reddit";

export interface AyrsharePost {
  post: string; // caption / text body
  platforms: AyrsharePlatform[]; // we fan out one platform per call for per-platform metadata
  mediaUrls?: string[]; // presigned R2 GET (24h TTL)
  scheduleDate?: string; // ISO; we usually publish immediately at slot time instead
  tikTokOptions?: {
    autoAddMusic?: boolean;
    disableComments?: boolean;
    privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
    isAiGenerated?: boolean; // AI-disclosure flag (compliance-enforced, doc 05 §2)
  };
  youTubeOptions?: {
    title: string;
    visibility: "public" | "unlisted" | "private";
    shorts?: boolean;
    tags?: string[];
    madeForKids?: boolean;
    containsSyntheticMedia?: boolean; // AI-disclosure flag
  };
  redditOptions?: { subreddit: string; title: string };
  twitterOptions?: { thread?: string[] };
}

export interface AyrsharePostResult {
  id: string;
  status: string;
  refId?: string;
  postIds?: { platform: string; id?: string; postUrl?: string; status?: string }[];
  errors?: unknown[];
}

export interface AyrshareAnalytics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  watchTimeSec: number | null;
  avgViewDurationSec: number | null;
  raw: Record<string, unknown>;
}

export interface AyrshareComment {
  commentId: string;
  platform: string;
  comment: string;
  userName?: string;
  created?: string; // ISO string as returned by Ayrshare
}

export class AyrshareError extends ConnectorError {
  constructor(status: number, body: string) {
    super("ayrshare", status, body);
    this.name = "AyrshareError";
  }
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${env.AYRSHARE_API_KEY}`,
    "profile-key": env.AYRSHARE_PROFILE_KEY,
    "content-type": "application/json",
  };
}

async function ayrPost<T>(path: string, body: unknown): Promise<T> {
  // Writes are NOT retried here — 4xx is a payload bug (mark failed),
  // 5xx retry policy belongs to pg-boss at the job layer (doc 06 §2).
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AyrshareError(res.status, await res.text());
  return (await res.json()) as T;
}

export async function createPost(p: AyrsharePost): Promise<AyrsharePostResult> {
  if (useFixtures()) {
    refuseFakeWriteInProd("createPost");
    return loadFixture<AyrsharePostResult>("ayrshare-create-post");
  }
  const result = await ayrPost<AyrsharePostResult>("/post", p);
  await logUsage({ service: "ayrshare", endpoint: "post", units: 1, costUsd: 0 });
  return result;
}

export async function deletePost(id: string): Promise<void> {
  if (useFixtures()) {
    refuseFakeWriteInProd("deletePost");
    return;
  }
  const res = await fetch(`${base()}/post`, {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new AyrshareError(res.status, await res.text());
  await logUsage({ service: "ayrshare", endpoint: "post.delete", units: 1, costUsd: 0 });
}

/** Normalized per doc 06 §2 for metrics.snapshot. */
export async function getPostAnalytics(id: string): Promise<AyrshareAnalytics> {
  if (useFixtures()) return loadFixture<AyrshareAnalytics>("ayrshare-analytics");
  const raw = await ayrPost<Record<string, unknown>>("/analytics/post", { id });
  await logUsage({ service: "ayrshare", endpoint: "analytics.post", units: 1, costUsd: 0 });

  // find the platform payload (response is keyed by platform name)
  const platformBlock =
    (Object.values(raw).find(
      (v) => v && typeof v === "object" && "analytics" in (v as Record<string, unknown>),
    ) as { analytics?: Record<string, unknown> } | undefined) ?? {};
  const a = platformBlock.analytics ?? {};
  const num = (k: string): number | null => {
    const v = a[k];
    return typeof v === "number" ? v : null;
  };
  // watchTimeSec is seconds; YouTube Analytics reports estimatedMinutesWatched in MINUTES — convert
  // it, or the learning engine's watch-time features come out 60× too small (M3).
  const minutesWatched = num("estimatedMinutesWatched");
  return {
    views: num("views") ?? num("playCount") ?? num("impressions"),
    likes: num("likes") ?? num("likeCount") ?? num("diggCount"),
    comments: num("comments") ?? num("commentCount"),
    shares: num("shares") ?? num("shareCount"),
    watchTimeSec:
      num("watchTime") ?? (minutesWatched !== null ? Math.round(minutesWatched * 60) : null),
    avgViewDurationSec: num("averageViewDuration"),
    raw,
  };
}

export async function getHistory(lastDays = 7): Promise<Record<string, unknown>[]> {
  if (useFixtures()) return loadFixture<Record<string, unknown>[]>("ayrshare-history");
  const json = await fetchJson<{ history?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    "ayrshare",
    `${base()}/history?lastDays=${lastDays}`,
    { headers: headers() },
  );
  await logUsage({ service: "ayrshare", endpoint: "history", units: 1, costUsd: 0 });
  return Array.isArray(json) ? json : (json.history ?? []);
}

export async function getComments(id: string): Promise<AyrshareComment[]> {
  if (useFixtures()) return loadFixture<AyrshareComment[]>("ayrshare-comments");
  const json = await fetchJson<Record<string, unknown>>("ayrshare", `${base()}/comments/${id}`, {
    headers: headers(),
  });
  await logUsage({ service: "ayrshare", endpoint: "comments.get", units: 1, costUsd: 0 });
  const out: AyrshareComment[] = [];
  for (const [platform, v] of Object.entries(json)) {
    if (!Array.isArray(v)) continue;
    for (const c of v as Record<string, unknown>[]) {
      out.push({
        commentId: String(c.commentId ?? c.id ?? ""),
        platform,
        comment: String(c.comment ?? c.text ?? ""),
        ...(c.userName ? { userName: String(c.userName) } : {}),
        ...(c.created ? { created: String(c.created) } : {}),
      });
    }
  }
  return out.filter((c) => c.commentId !== "");
}

export async function replyComment(id: string, text: string): Promise<void> {
  if (useFixtures()) {
    refuseFakeWriteInProd("replyComment");
    return;
  }
  await ayrPost(`/comments/reply/${id}`, { comment: text });
  await logUsage({ service: "ayrshare", endpoint: "comments.reply", units: 1, costUsd: 0 });
}

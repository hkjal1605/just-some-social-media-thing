// Reddit — app-only OAuth (client credentials), token cached 50 min,
// X-Ratelimit-* honored, UA from env (doc 03 §6). Read-only use.
import { env } from "@ve/config";
import {
  ConnectorError,
  fixtureMode,
  loadFixture,
  log,
  logUsage,
  type NormalizedItem,
} from "./types";

interface RedditListingChild {
  kind: string;
  data: {
    name: string; // t3_xxx
    permalink: string;
    author: string;
    title: string;
    selftext?: string;
    stickied?: boolean;
    is_video?: boolean;
    is_self?: boolean;
    post_hint?: string;
    thumbnail?: string;
    created_utc: number;
    score: number;
    ups?: number;
    num_comments: number;
    num_crossposts?: number;
    media?: { reddit_video?: { duration?: number } };
  };
}

interface RedditListing {
  data: { children: RedditListingChild[] };
}

let cachedToken: { value: string; expiresAt: number } | null = null;
const rate = { remaining: 100, resetAtMs: 0 };

async function appToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": env.REDDIT_USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new ConnectorError("reddit", res.status, await res.text());
  const json = (await res.json()) as { access_token: string };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + 50 * 60_000 };
  return json.access_token;
}

async function redditGet<T>(path: string): Promise<T> {
  if (rate.remaining < 2 && Date.now() < rate.resetAtMs) {
    const waitMs = rate.resetAtMs - Date.now();
    log.warn({ waitMs }, "reddit rate limit — waiting for reset");
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: {
      authorization: `Bearer ${await appToken()}`,
      "user-agent": env.REDDIT_USER_AGENT,
    },
  });
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const resetSec = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(remaining)) rate.remaining = remaining;
  if (Number.isFinite(resetSec)) rate.resetAtMs = Date.now() + resetSec * 1000;
  if (!res.ok) throw new ConnectorError("reddit", res.status, await res.text());
  return (await res.json()) as T;
}

function normalize(child: RedditListingChild): NormalizedItem {
  const d = child.data;
  const thumbOk = d.thumbnail?.startsWith("http");
  const mediaType = d.is_video
    ? "video"
    : d.post_hint === "image"
      ? "image"
      : d.is_self
        ? "text"
        : "link";
  return {
    platform: "reddit",
    externalId: d.name,
    url: `https://www.reddit.com${d.permalink}`,
    author: d.author,
    title: d.title,
    ...(d.selftext ? { text: d.selftext.slice(0, 8000) } : {}),
    mediaType,
    ...(thumbOk ? { thumbnailUrl: d.thumbnail } : {}),
    ...(d.media?.reddit_video?.duration ? { durationSec: d.media.reddit_video.duration } : {}),
    publishedAt: new Date(d.created_utc * 1000),
    metrics: {
      score: d.score,
      likes: d.ups ?? d.score,
      comments: d.num_comments,
      ...(d.num_crossposts !== undefined ? { shares: d.num_crossposts } : {}),
    },
  };
}

function subPath(name: string): string {
  return name.replace(/^r\//, "");
}

export async function fetchSubredditHot(name: string, limit = 50): Promise<NormalizedItem[]> {
  if (fixtureMode("reddit")) return loadFixture("reddit-hot");
  const listing = await redditGet<RedditListing>(
    `/r/${subPath(name)}/hot?limit=${limit}&raw_json=1`,
  );
  const items = listing.data.children.filter((c) => !c.data.stickied).map(normalize);
  await logUsage({ service: "reddit", endpoint: "hot", units: items.length, costUsd: 0 });
  return items;
}

export async function fetchRising(name: string, limit = 25): Promise<NormalizedItem[]> {
  if (fixtureMode("reddit")) return loadFixture("reddit-rising");
  const listing = await redditGet<RedditListing>(
    `/r/${subPath(name)}/rising?limit=${limit}&raw_json=1`,
  );
  const items = listing.data.children.filter((c) => !c.data.stickied).map(normalize);
  await logUsage({ service: "reddit", endpoint: "rising", units: items.length, costUsd: 0 });
  return items;
}

export interface RedditComment {
  externalCommentId: string;
  author: string;
  text: string;
  score: number;
  createdAt: Date;
}

export async function fetchComments(postId: string, limit = 50): Promise<RedditComment[]> {
  if (fixtureMode("reddit")) return loadFixture<RedditComment[]>("reddit-comments");
  const id36 = postId.replace(/^t3_/, "");
  const thread = await redditGet<RedditListing[]>(
    `/comments/${id36}?limit=${limit}&depth=1&raw_json=1`,
  );
  const commentsListing = thread[1];
  const out: RedditComment[] = [];
  for (const c of commentsListing?.data.children ?? []) {
    if (c.kind !== "t1") continue;
    const d = c.data as unknown as {
      name: string;
      author: string;
      body?: string;
      score: number;
      created_utc: number;
    };
    out.push({
      externalCommentId: d.name,
      author: d.author,
      text: (d.body ?? "").slice(0, 4000),
      score: d.score,
      createdAt: new Date(d.created_utc * 1000),
    });
  }
  await logUsage({ service: "reddit", endpoint: "comments", units: out.length, costUsd: 0 });
  return out;
}

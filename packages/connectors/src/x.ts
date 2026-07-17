// X API v2 — pay-per-use reads ($0.005/post), own-account reads ($0.001),
// writes $0.015 ($0.20 with URL). Hard monthly read cap from settings (doc 03 §6).
import { env } from "@ve/config";
import { X_MONTHLY_READ_CAP_USD_DEFAULT, X_UNIT_PRICES_USD } from "@ve/core";
import { db, getSetting, sql } from "@ve/db";
import { ConnectorError, fixtureMode, loadFixture, logUsage, type NormalizedItem } from "./types";

const BASE = "https://api.x.com/2";

export class XReadCapExceededError extends Error {
  constructor(spent: number, cap: number) {
    super(`x monthly read spend $${spent.toFixed(2)} ≥ cap $${cap.toFixed(2)} — scout skipped`);
    this.name = "XReadCapExceededError";
  }
}

/** Month-to-date X read spend in USD — the scout tick also gates on this (doc 04 §1). */
export async function xReadSpendMtd(): Promise<number> {
  const rows = (await db.execute(sql`
    select coalesce(sum(cost_usd), 0)::float as spent from api_usage
    where service = 'x_api' and endpoint like 'read:%'
      and date_trunc('month', at) = date_trunc('month', now())
  `)) as unknown as { spent: number }[];
  return rows[0]?.spent ?? 0;
}

export async function xReadCapUsd(): Promise<number> {
  return (await getSetting<number>("x_monthly_read_cap_usd")) ?? X_MONTHLY_READ_CAP_USD_DEFAULT;
}

async function assertReadBudget(): Promise<void> {
  const [spent, cap] = await Promise.all([xReadSpendMtd(), xReadCapUsd()]);
  if (spent >= cap) throw new XReadCapExceededError(spent, cap);
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${env.X_BEARER_TOKEN}` };
}

interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  entities?: { urls?: unknown[] };
  attachments?: { media_keys?: string[] };
  public_metrics?: {
    impression_count?: number;
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
    quote_count?: number;
    bookmark_count?: number;
  };
}

interface XSearchResponse {
  data?: XTweet[];
  includes?: { users?: { id: string; username: string }[] };
  meta?: { newest_id?: string; next_token?: string };
}

function normalize(t: XTweet, users: Map<string, string>): NormalizedItem {
  const username = t.author_id ? users.get(t.author_id) : undefined;
  const pm = t.public_metrics ?? {};
  return {
    platform: "x",
    externalId: t.id,
    url: `https://x.com/${username ?? "i"}/status/${t.id}`,
    ...(username ? { author: username } : {}),
    text: t.text.slice(0, 8000),
    mediaType: t.attachments?.media_keys?.length
      ? "video"
      : t.entities?.urls?.length
        ? "link"
        : "text",
    ...(t.created_at ? { publishedAt: new Date(t.created_at) } : {}),
    metrics: {
      ...(pm.impression_count !== undefined ? { views: pm.impression_count } : {}),
      ...(pm.like_count !== undefined ? { likes: pm.like_count } : {}),
      ...(pm.reply_count !== undefined ? { comments: pm.reply_count } : {}),
      shares: (pm.retweet_count ?? 0) + (pm.quote_count ?? 0),
      ...(pm.bookmark_count !== undefined ? { score: pm.bookmark_count } : {}),
    },
  };
}

export async function searchRecent(
  query: string,
  sinceId?: string,
  maxResults = 50,
): Promise<{ items: NormalizedItem[]; newestId?: string }> {
  if (fixtureMode("x"))
    return { items: await loadFixture("x-search"), newestId: "1946000000000000002" };
  await assertReadBudget();
  const url = new URL(`${BASE}/tweets/search/recent`);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.min(Math.max(maxResults, 10), 100)));
  url.searchParams.set("tweet.fields", "public_metrics,created_at,author_id,entities,attachments");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");
  if (sinceId) url.searchParams.set("since_id", sinceId);

  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new ConnectorError("x_api", res.status, await res.text());
  const json = (await res.json()) as XSearchResponse;
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u.username]));
  const items = (json.data ?? []).map((t) => normalize(t, users));
  await logUsage({
    service: "x_api",
    endpoint: "read:tweets.search.recent",
    units: items.length,
    costUsd: items.length * X_UNIT_PRICES_USD.readPerPost,
  });
  return {
    items,
    ...(json.meta?.newest_id ? { newestId: json.meta.newest_id } : {}),
  };
}

/** Own-account metrics at $0.001/resource (doc 07 §1). */
export async function getOwnPostsMetrics(
  ids: string[],
): Promise<Map<string, NormalizedItem["metrics"]>> {
  if (ids.length === 0) return new Map();
  if (fixtureMode("x")) {
    const fixture = await loadFixture("x-search");
    return new Map(ids.map((id, i) => [id, fixture[i % fixture.length]?.metrics ?? {}]));
  }
  const out = new Map<string, NormalizedItem["metrics"]>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const url = new URL(`${BASE}/tweets`);
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set("tweet.fields", "public_metrics");
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new ConnectorError("x_api", res.status, await res.text());
    const json = (await res.json()) as { data?: XTweet[] };
    for (const t of json.data ?? []) {
      const pm = t.public_metrics ?? {};
      out.set(t.id, {
        ...(pm.impression_count !== undefined ? { views: pm.impression_count } : {}),
        ...(pm.like_count !== undefined ? { likes: pm.like_count } : {}),
        ...(pm.reply_count !== undefined ? { comments: pm.reply_count } : {}),
        shares: (pm.retweet_count ?? 0) + (pm.quote_count ?? 0),
      });
    }
    await logUsage({
      service: "x_api",
      endpoint: "own:tweets.lookup",
      units: chunk.length,
      costUsd: chunk.length * X_UNIT_PRICES_USD.ownReadPerResource,
    });
  }
  return out;
}

/** Optional direct write (default publishing rail is Ayrshare — doc 06 §5). */
export async function postText(text: string): Promise<{ id: string }> {
  if (fixtureMode("x")) {
    // never fabricate a real post in production (H7) — refuse so the caller retries once credentialed
    if (env.APP_ENV === "production") {
      throw new ConnectorError(
        "x_api",
        503,
        "X not configured — refusing to fake a post in production",
      );
    }
    return { id: "1946000000000000099" };
  }
  const res = await fetch(`${BASE}/tweets`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new ConnectorError("x_api", res.status, await res.text());
  const json = (await res.json()) as { data: { id: string } };
  const hasUrl = /https?:\/\//.test(text);
  await logUsage({
    service: "x_api",
    endpoint: "write:tweets.create",
    units: 1,
    costUsd: hasUrl ? X_UNIT_PRICES_USD.urlPostWrite : X_UNIT_PRICES_USD.writePerPost,
  });
  return { id: json.data.id };
}

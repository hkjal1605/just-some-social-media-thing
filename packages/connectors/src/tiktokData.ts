// TikTok has no commercial read API — data comes from licensed providers behind one
// interface (doc 03 §6): apify (primary) + ensemble (optional secondary). Providers are
// swappable adapters, never load-bearing (research §07).
import { env, integrations } from "@ve/config";
import {
  ConnectorError,
  fixtureMode,
  loadFixture,
  log,
  logUsage,
  type NormalizedItem,
} from "./types";

export interface TikTokDataProvider {
  readonly name: "apify" | "ensemble";
  fetchHashtagTop(tag: string, limit: number): Promise<NormalizedItem[]>;
  fetchCreatorRecent(handle: string): Promise<NormalizedItem[]>;
}

const APIFY_ACTOR = "clockworks~tiktok-scraper";
const APIFY_COST_PER_1K_USD = 1.7; // research §07

interface ApifyItem {
  id: string;
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  createTime?: number;
  authorMeta?: { name?: string };
  videoMeta?: { duration?: number; coverUrl?: string };
  covers?: { default?: string };
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
}

function normalizeApify(i: ApifyItem): NormalizedItem {
  const publishedAt = i.createTimeISO
    ? new Date(i.createTimeISO)
    : i.createTime
      ? new Date(i.createTime * 1000)
      : undefined;
  const thumb = i.videoMeta?.coverUrl ?? i.covers?.default;
  return {
    platform: "tiktok",
    externalId: i.id,
    url: i.webVideoUrl ?? `https://www.tiktok.com/@${i.authorMeta?.name ?? "user"}/video/${i.id}`,
    ...(i.authorMeta?.name ? { author: i.authorMeta.name } : {}),
    ...(i.text ? { text: i.text.slice(0, 8000) } : {}),
    mediaType: "video",
    ...(thumb ? { thumbnailUrl: thumb } : {}),
    ...(i.videoMeta?.duration !== undefined ? { durationSec: i.videoMeta.duration } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    metrics: {
      ...(i.playCount !== undefined ? { views: i.playCount } : {}),
      ...(i.diggCount !== undefined ? { likes: i.diggCount } : {}),
      ...(i.commentCount !== undefined ? { comments: i.commentCount } : {}),
      ...(i.shareCount !== undefined ? { shares: i.shareCount } : {}),
    },
  };
}

async function apifyRun(input: Record<string, unknown>, limit: number): Promise<NormalizedItem[]> {
  // token in the Authorization header, never the URL — Bun's fetch-error `path` (the full URL) is
  // serialized by pino, so a token in the query string leaks into the logs on any failure (M12)
  const apifyAuth = { authorization: `Bearer ${env.APIFY_TOKEN}` };
  const startRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...apifyAuth },
    body: JSON.stringify({ ...input, resultsPerPage: limit, shouldDownloadVideos: false }),
  });
  if (!startRes.ok) throw new ConnectorError("apify", startRes.status, await startRes.text());
  const start = (await startRes.json()) as {
    data: { id: string; defaultDatasetId: string };
  };

  // poll the run (doc 03 §6: call actor, poll run, fetch dataset)
  const deadline = Date.now() + 180_000;
  let status = "RUNNING";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const runRes = await fetch(`https://api.apify.com/v2/actor-runs/${start.data.id}`, {
      headers: apifyAuth,
    });
    if (!runRes.ok) throw new ConnectorError("apify", runRes.status, await runRes.text());
    const run = (await runRes.json()) as { data: { status: string } };
    status = run.data.status;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) break;
  }
  if (status !== "SUCCEEDED") throw new ConnectorError("apify", 502, `run ended ${status}`);

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${start.data.defaultDatasetId}/items?clean=true&limit=${limit}`,
    { headers: apifyAuth },
  );
  if (!itemsRes.ok) throw new ConnectorError("apify", itemsRes.status, await itemsRes.text());
  const items = ((await itemsRes.json()) as ApifyItem[]).map(normalizeApify);
  await logUsage({
    service: "apify",
    endpoint: APIFY_ACTOR,
    units: items.length,
    costUsd: (items.length / 1000) * APIFY_COST_PER_1K_USD,
  });
  return items;
}

const apifyProvider: TikTokDataProvider = {
  name: "apify",
  fetchHashtagTop: (tag, limit) => apifyRun({ hashtags: [tag.replace(/^#/, "")] }, limit),
  fetchCreatorRecent: (handle) => apifyRun({ profiles: [handle.replace(/^@/, "")] }, 30),
};

interface EnsemblePost {
  aweme_id: string;
  desc?: string;
  create_time?: number;
  author?: { unique_id?: string };
  video?: { duration?: number; cover?: { url_list?: string[] } };
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
  };
}

function normalizeEnsemble(p: EnsemblePost): NormalizedItem {
  const author = p.author?.unique_id;
  return {
    platform: "tiktok",
    externalId: p.aweme_id,
    url: `https://www.tiktok.com/@${author ?? "user"}/video/${p.aweme_id}`,
    ...(author ? { author } : {}),
    ...(p.desc ? { text: p.desc.slice(0, 8000) } : {}),
    mediaType: "video",
    ...(p.video?.cover?.url_list?.[0] ? { thumbnailUrl: p.video.cover.url_list[0] } : {}),
    ...(p.video?.duration !== undefined
      ? { durationSec: Math.round(p.video.duration / 1000) }
      : {}),
    ...(p.create_time ? { publishedAt: new Date(p.create_time * 1000) } : {}),
    metrics: {
      ...(p.statistics?.play_count !== undefined ? { views: p.statistics.play_count } : {}),
      ...(p.statistics?.digg_count !== undefined ? { likes: p.statistics.digg_count } : {}),
      ...(p.statistics?.comment_count !== undefined
        ? { comments: p.statistics.comment_count }
        : {}),
      ...(p.statistics?.share_count !== undefined ? { shares: p.statistics.share_count } : {}),
    },
  };
}

async function ensembleGet(path: string, params: Record<string, string>): Promise<EnsemblePost[]> {
  const url = new URL(`https://ensembledata.com/apis${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // EnsembleData authenticates via a token query param, so a raw network error would carry the URL
  // (with the token) into the logs — catch it and re-throw a URL-free ConnectorError (M12).
  url.searchParams.set("token", env.ENSEMBLE_TOKEN);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ConnectorError(
      "ensemble",
      0,
      `network error: ${err instanceof Error ? err.message : "fetch failed"}`,
    );
  }
  if (!res.ok) throw new ConnectorError("ensemble", res.status, await res.text());
  const json = (await res.json()) as { data?: { posts?: EnsemblePost[] } };
  return json.data?.posts ?? [];
}

const ensembleProvider: TikTokDataProvider = {
  name: "ensemble",
  fetchHashtagTop: async (tag, limit) => {
    const posts = await ensembleGet("/tt/hashtag/posts", {
      name: tag.replace(/^#/, ""),
      days: "7",
    });
    const items = posts.slice(0, limit).map(normalizeEnsemble);
    await logUsage({
      service: "ensemble",
      endpoint: "hashtag/posts",
      units: items.length,
      costUsd: 0,
    });
    return items;
  },
  fetchCreatorRecent: async (handle) => {
    const posts = await ensembleGet("/tt/user/posts", {
      username: handle.replace(/^@/, ""),
      depth: "1",
    });
    const items = posts.map(normalizeEnsemble);
    await logUsage({
      service: "ensemble",
      endpoint: "user/posts",
      units: items.length,
      costUsd: 0,
    });
    return items;
  },
};

function providers(): TikTokDataProvider[] {
  const list: TikTokDataProvider[] = [];
  if (integrations.apify) list.push(apifyProvider);
  if (integrations.ensemble) list.push(ensembleProvider);
  return list;
}

/** Provider chosen by env; primary failure falls through to the secondary (doc 03 §6). */
export const tiktokData: TikTokDataProvider = {
  get name() {
    return providers()[0]?.name ?? "apify";
  },
  async fetchHashtagTop(tag, limit = 30) {
    if (fixtureMode("apify") && fixtureMode("ensemble")) return loadFixture("tiktok-hashtag");
    const chain = providers();
    let lastErr: unknown;
    for (const p of chain) {
      try {
        return await p.fetchHashtagTop(tag, limit);
      } catch (err) {
        lastErr = err;
        log.warn({ provider: p.name, err }, "tiktok provider failed — trying secondary");
      }
    }
    throw lastErr ?? new Error("no tiktok data provider configured");
  },
  async fetchCreatorRecent(handle) {
    if (fixtureMode("apify") && fixtureMode("ensemble")) return loadFixture("tiktok-creator");
    const chain = providers();
    let lastErr: unknown;
    for (const p of chain) {
      try {
        return await p.fetchCreatorRecent(handle);
      } catch (err) {
        lastErr = err;
        log.warn({ provider: p.name, err }, "tiktok provider failed — trying secondary");
      }
    }
    throw lastErr ?? new Error("no tiktok data provider configured");
  },
};

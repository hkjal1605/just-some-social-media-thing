// YouTube Data API v3 — key auth, quota ledger in settings.youtube_quota:
// search costs 100 units, everything else 1; refuse when <500 left (doc 03 §6).
import { env } from "@ve/config";
import { type SettingsYoutubeQuota, YOUTUBE_QUOTA_DAILY, YOUTUBE_QUOTA_FLOOR } from "@ve/core";
import { getSetting, setSetting } from "@ve/db";
import { fetchJson, fixtureMode, loadFixture, logUsage, type NormalizedItem } from "./types";

const BASE = "https://www.googleapis.com/youtube/v3";

// Send the API key in the X-Goog-Api-Key HEADER, never the query string — Bun's fetch attaches the
// full URL to network-error objects and pino serializes it, so a key in the URL leaks into the logs
// on any connection failure (M12). Headers are not logged.
function ytJson<T>(url: URL): Promise<T> {
  return fetchJson<T>("youtube", url.toString(), {
    headers: { "X-Goog-Api-Key": env.YOUTUBE_API_KEY },
  });
}

export class QuotaExhaustedError extends Error {
  constructor(public readonly remaining: number) {
    super(`youtube quota guard: only ${remaining} units left today (< ${YOUTUBE_QUOTA_FLOOR})`);
    this.name = "QuotaExhaustedError";
  }
}

async function spendQuota(units: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const state = (await getSetting<SettingsYoutubeQuota>("youtube_quota")) ?? {
    date: today,
    used: 0,
  };
  const used = state.date === today ? state.used : 0;
  const remaining = YOUTUBE_QUOTA_DAILY - used;
  if (remaining - units < YOUTUBE_QUOTA_FLOOR) throw new QuotaExhaustedError(remaining);
  await setSetting("youtube_quota", { date: today, used: used + units });
}

interface YtVideo {
  id: string | { videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
    resourceId?: { videoId?: string };
  };
  contentDetails?: { duration?: string; videoId?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

function isoDurationToSec(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function videoId(v: YtVideo): string {
  if (typeof v.id === "string") return v.id;
  return v.id?.videoId ?? v.snippet?.resourceId?.videoId ?? v.contentDetails?.videoId ?? "";
}

function normalize(v: YtVideo): NormalizedItem {
  const id = videoId(v);
  const dur = isoDurationToSec(v.contentDetails?.duration);
  const thumb = v.snippet?.thumbnails?.high?.url ?? v.snippet?.thumbnails?.medium?.url;
  return {
    platform: "youtube",
    externalId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    ...(v.snippet?.channelTitle ? { author: v.snippet.channelTitle } : {}),
    ...(v.snippet?.title ? { title: v.snippet.title } : {}),
    ...(v.snippet?.description ? { text: v.snippet.description.slice(0, 8000) } : {}),
    mediaType: "video",
    ...(thumb ? { thumbnailUrl: thumb } : {}),
    ...(dur !== undefined ? { durationSec: dur } : {}),
    ...(v.snippet?.publishedAt ? { publishedAt: new Date(v.snippet.publishedAt) } : {}),
    metrics: {
      ...(v.statistics?.viewCount !== undefined ? { views: Number(v.statistics.viewCount) } : {}),
      ...(v.statistics?.likeCount !== undefined ? { likes: Number(v.statistics.likeCount) } : {}),
      ...(v.statistics?.commentCount !== undefined
        ? { comments: Number(v.statistics.commentCount) }
        : {}),
    },
  };
}

export async function fetchMostPopular(
  regionCode = "US",
  videoCategoryId?: string,
): Promise<NormalizedItem[]> {
  if (fixtureMode("youtube")) return loadFixture("youtube-mostpopular");
  await spendQuota(1);
  const url = new URL(`${BASE}/videos`);
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("regionCode", regionCode);
  url.searchParams.set("maxResults", "50");
  if (videoCategoryId) url.searchParams.set("videoCategoryId", videoCategoryId);
  const json = await ytJson<{ items: YtVideo[] }>(url);
  const items = json.items.map(normalize);
  await logUsage({ service: "youtube", endpoint: "videos.mostPopular", units: 1, costUsd: 0 });
  return items;
}

export async function fetchVideoStats(ids: string[]): Promise<NormalizedItem[]> {
  if (ids.length === 0) return [];
  if (fixtureMode("youtube")) return loadFixture("youtube-video-stats");
  const out: NormalizedItem[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    await spendQuota(1);
    const url = new URL(`${BASE}/videos`);
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", ids.slice(i, i + 50).join(","));
    const json = await ytJson<{ items: YtVideo[] }>(url);
    out.push(...json.items.map(normalize));
    await logUsage({ service: "youtube", endpoint: "videos.list", units: 1, costUsd: 0 });
  }
  return out;
}

/** New uploads for a channel since the given ISO time — via the uploads playlist (1 unit each call). */
export async function fetchChannelUploads(
  channelId: string,
  sinceISO: string,
): Promise<NormalizedItem[]> {
  if (fixtureMode("youtube")) return loadFixture("youtube-channel-uploads");
  await spendQuota(1);
  const chUrl = new URL(`${BASE}/channels`);
  chUrl.searchParams.set("part", "contentDetails");
  chUrl.searchParams.set("id", channelId);
  const ch = await ytJson<{
    items: { contentDetails: { relatedPlaylists: { uploads: string } } }[];
  }>(chUrl);
  const uploads = ch.items[0]?.contentDetails.relatedPlaylists.uploads;
  if (!uploads) return [];

  await spendQuota(1);
  const plUrl = new URL(`${BASE}/playlistItems`);
  plUrl.searchParams.set("part", "snippet,contentDetails");
  plUrl.searchParams.set("playlistId", uploads);
  plUrl.searchParams.set("maxResults", "50");
  const pl = await ytJson<{ items: YtVideo[] }>(plUrl);
  await logUsage({ service: "youtube", endpoint: "playlistItems.list", units: 2, costUsd: 0 });

  const since = new Date(sinceISO).getTime();
  const recentIds = pl.items
    .filter((v) => {
      const at = v.snippet?.publishedAt ? new Date(v.snippet.publishedAt).getTime() : 0;
      return at >= since;
    })
    .map(videoId)
    .filter(Boolean);
  return fetchVideoStats(recentIds);
}

/** search.list costs 100 units — hoard the ~100/day (doc 04 §1: scouts never use this). */
export async function searchOnce(q: string): Promise<NormalizedItem[]> {
  if (fixtureMode("youtube")) return loadFixture("youtube-search");
  await spendQuota(100);
  const url = new URL(`${BASE}/search`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", q);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "25");
  const json = await ytJson<{ items: YtVideo[] }>(url);
  await logUsage({ service: "youtube", endpoint: "search.list", units: 100, costUsd: 0 });
  return json.items.map(normalize);
}

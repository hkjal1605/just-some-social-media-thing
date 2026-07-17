// Scouts (doc 04 §1): the every-15-min tick fans out one job per due source
// (singletonKey: sourceId); per-source handlers pull the platform feed through
// fixture-capable connectors, then a single shared persistence path upserts
// raw_items + appends item_snapshots and enqueues radar.score.

import { type NormalizedItem, reddit, tiktokData, x as xApi, youtube } from "@ve/connectors";
import {
  makeLogger,
  newId,
  type Platform,
  Q,
  type QueueName,
  STALE_ITEM_MAX_AGE_DAYS,
  YT_STATS_REFRESH_HOURS,
} from "@ve/core";
import {
  and,
  db,
  eq,
  getSetting,
  inArray,
  isNull,
  itemSnapshots,
  or,
  rawItems,
  setSetting,
  sources,
  sql,
} from "@ve/db";
import { type Enqueuer, enqueueAlert } from "../../harness";

const log = makeLogger("radar-scouts");

export const SCOUT_QUEUE_BY_PLATFORM: Record<Platform, QueueName> = {
  reddit: Q.scoutReddit,
  youtube: Q.scoutYoutube,
  x: Q.scoutX,
  tiktok: Q.scoutTiktok,
};

/** Tick: enqueue one scout job per due source of this platform (doc 04 §1). */
export async function scoutTick(
  platform: Platform,
  boss: Enqueuer,
): Promise<{ enqueued: number; skipped: string | null }> {
  // X reads are pay-per-use — skip the whole platform when over the monthly cap,
  // alerting at most once per day (doc 04 §1).
  if (platform === "x") {
    const [spent, cap] = await Promise.all([xApi.xReadSpendMtd(), xApi.xReadCapUsd()]);
    if (spent >= cap) {
      const today = new Date().toISOString().slice(0, 10);
      const alerted = await getSetting<string>("x_cap_alerted_on");
      if (alerted !== today) {
        await enqueueAlert(
          boss,
          `💸 X monthly read cap reached ($${spent.toFixed(2)} ≥ $${cap.toFixed(2)}) — X scouts paused until next month or cap raise.`,
          "x-read-cap",
        );
        await setSetting("x_cap_alerted_on", today);
      }
      return { enqueued: 0, skipped: "x-read-cap" };
    }
  }

  const due = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.platform, platform),
        eq(sources.active, true),
        or(
          isNull(sources.lastScoutedAt),
          sql`${sources.lastScoutedAt} < now() - make_interval(mins => ${sources.scoutIntervalMin})`,
        ),
      ),
    );

  for (const s of due) {
    await boss.send(SCOUT_QUEUE_BY_PLATFORM[platform], { sourceId: s.id }, { singletonKey: s.id });
  }
  if (due.length > 0) log.info({ platform, enqueued: due.length }, "scout tick fanned out");
  return { enqueued: due.length, skipped: null };
}

/** Fetch items for one source through its connector (doc 04 §1 per-platform behavior). */
export async function fetchSourceItems(
  source: typeof sources.$inferSelect,
): Promise<NormalizedItem[]> {
  switch (source.platform as Platform) {
    case "reddit": {
      const [hot, rising] = await Promise.all([
        reddit.fetchSubredditHot(source.value, 50),
        reddit.fetchRising(source.value, 25),
      ]);
      // one row per external id — hot wins over rising duplicates
      const seen = new Map<string, NormalizedItem>();
      for (const item of [...hot, ...rising]) {
        if (!seen.has(item.externalId)) seen.set(item.externalId, item);
      }
      return [...seen.values()];
    }
    case "youtube": {
      if (source.kind === "yt_chart") return youtube.fetchMostPopular(source.value);
      // yt_channel: new uploads since last scout + stats refresh for tracked videos <72h old
      const sinceISO = (
        source.lastScoutedAt ?? new Date(Date.now() - YT_STATS_REFRESH_HOURS * 3_600_000)
      ).toISOString();
      const uploads = await youtube.fetchChannelUploads(source.value, sinceISO);
      const tracked = await db
        .select({ externalId: rawItems.externalId })
        .from(rawItems)
        .where(
          and(
            eq(rawItems.platform, "youtube"),
            eq(rawItems.categoryId, source.categoryId),
            sql`${rawItems.publishedAt} >= now() - make_interval(hours => ${YT_STATS_REFRESH_HOURS})`,
          ),
        );
      const uploadIds = new Set(uploads.map((u) => u.externalId));
      const refreshIds = tracked.map((t) => t.externalId).filter((id) => !uploadIds.has(id));
      const refreshed = refreshIds.length > 0 ? await youtube.fetchVideoStats(refreshIds) : [];
      return [...uploads, ...refreshed];
    }
    case "x": {
      // NB: the paid-read cursor is advanced by scoutSource AFTER a successful persist (M11) —
      // advancing here would skip (and lose) this window's tweets if persistItems then failed.
      const sinceId = (await getSetting<string>(`x_cursor:${source.id}`)) ?? undefined;
      const { items } = await xApi.searchRecent(source.value, sinceId, 50);
      return items;
    }
    case "tiktok":
      return source.kind === "tiktok_creator"
        ? tiktokData.fetchCreatorRecent(source.value)
        : tiktokData.fetchHashtagTop(source.value, 30);
  }
}

/** Shared persistence path (doc 04 §1 steps 1–5). Returns touched raw_item ids. */
export async function persistItems(
  source: { id: string; categoryId: string; platform: string },
  items: NormalizedItem[],
  boss: Enqueuer,
): Promise<string[]> {
  const staleCutoff = new Date(Date.now() - STALE_ITEM_MAX_AGE_DAYS * 24 * 3_600_000);

  // stale backfill guard: old items only pass if we already track them
  const externalIds = items.map((i) => i.externalId);
  const existing =
    externalIds.length === 0
      ? []
      : await db
          .select({ externalId: rawItems.externalId })
          .from(rawItems)
          .where(
            and(eq(rawItems.platform, source.platform), inArray(rawItems.externalId, externalIds)),
          );
  const known = new Set(existing.map((e) => e.externalId));
  const fresh = items.filter(
    (i) => known.has(i.externalId) || !i.publishedAt || i.publishedAt >= staleCutoff,
  );

  const touched: string[] = [];
  for (const item of fresh) {
    const [row] = await db
      .insert(rawItems)
      .values({
        id: newId(),
        platform: item.platform,
        externalId: item.externalId,
        sourceId: source.id,
        categoryId: source.categoryId,
        url: item.url,
        author: item.author ?? null,
        title: item.title ?? null,
        text: item.text?.slice(0, 8000) ?? null,
        mediaType: item.mediaType ?? null,
        thumbnailUrl: item.thumbnailUrl ?? null,
        durationSec: item.durationSec ?? null,
        publishedAt: item.publishedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [rawItems.platform, rawItems.externalId],
        set: {
          // refresh mutable presentation fields; first_seen_at stays (doc 04 §1)
          title: item.title ?? null,
          text: item.text?.slice(0, 8000) ?? null,
          thumbnailUrl: item.thumbnailUrl ?? null,
        },
      })
      .returning({ id: rawItems.id });
    if (!row) continue;
    touched.push(row.id);
    await db.insert(itemSnapshots).values({
      id: newId(),
      rawItemId: row.id,
      views: item.metrics.views ?? null,
      likes: item.metrics.likes ?? null,
      comments: item.metrics.comments ?? null,
      shares: item.metrics.shares ?? null,
      score: item.metrics.score ?? null,
    });
  }

  await db.update(sources).set({ lastScoutedAt: new Date() }).where(eq(sources.id, source.id));

  if (touched.length > 0) {
    // singletonKey categoryId+quarterHour merges bursts (doc 04 §1); dropped batches
    // self-heal on the next scout pass since every pass re-touches live items
    const bucket = Math.floor(Date.now() / 900_000);
    await boss.send(
      Q.radarScore,
      { categoryId: source.categoryId, rawItemIds: touched },
      { singletonKey: `${source.categoryId}:${bucket}` },
    );
  }

  log.info(
    {
      sourceId: source.id,
      platform: source.platform,
      fetched: items.length,
      touched: touched.length,
    },
    "scout persisted",
  );
  return touched;
}

/** Per-source scout job (doc 04 §1). */
export async function scoutSource(sourceId: string, boss: Enqueuer): Promise<string[]> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source?.active) {
    log.warn({ sourceId }, "scout skipped: source missing or inactive");
    return [];
  }
  const items = await fetchSourceItems(source);
  const touched = await persistItems(source, items, boss);
  // Advance the X paid-read cursor only after a successful persist (M11): the newest tweet id in
  // this batch (snowflake ids compare numerically → BigInt max). A persist failure above throws
  // before this line, so the retry re-reads the same window instead of skipping it.
  if (source.platform === "x" && items.length > 0) {
    let newest = 0n;
    for (const i of items) {
      try {
        const id = BigInt(i.externalId);
        if (id > newest) newest = id;
      } catch {
        // non-numeric id (shouldn't happen for X) — ignore for cursor purposes
      }
    }
    if (newest > 0n) await setSetting(`x_cursor:${source.id}`, newest.toString());
  }
  return touched;
}

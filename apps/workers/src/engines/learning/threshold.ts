// Threshold tracker (doc 07 §5): keep settings.threshold_progress fresh. We auto-fill the
// view-based metrics Ayrshare/X analytics expose (tiktok views30d, youtube shortsViews90d,
// x impressions3mo) from our own snapshots and preserve the manually-entered fields
// (followers, subs, watch-hours, verified followers). Merge is pure + unit-tested.
import { makeLogger, THRESHOLD_PROGRESS_SETTING_KEY, type ThresholdProgress } from "@ve/core";
import { db, getSetting, setSetting, sql } from "@ve/db";

const log = makeLogger("learning-threshold");

export interface AutoThresholdMetrics {
  tiktokViews30d: number | null;
  youtubeShortsViews90d: number | null;
  xImpressions3mo: number | null;
}

/** Merge auto-computed view metrics into current progress, preserving manual fields. Pure. */
export function mergeThreshold(
  current: ThresholdProgress | null,
  auto: AutoThresholdMetrics,
  nowIso: string,
): ThresholdProgress {
  const c = current ?? {};
  return {
    tiktok: { ...(c.tiktok ?? {}), views30d: auto.tiktokViews30d },
    youtube: { ...(c.youtube ?? {}), shortsViews90d: auto.youtubeShortsViews90d },
    x: { ...(c.x ?? {}), impressions3mo: auto.xImpressions3mo },
    updatedAt: nowIso,
  };
}

/** Sum the latest snapshot views across published posts of one platform in a window. */
async function sumLatestViews(platform: string, days: number): Promise<number | null> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = (await db.execute(sql`
    select coalesce(sum(ls.views), 0)::bigint as total
    from posts p
    join lateral (
      select views from post_snapshots s
      where s.post_id = p.id and s.views is not null
      order by s.captured_at desc limit 1
    ) ls on true
    where p.status = 'published' and p.platform = ${platform}
      and p.published_at >= ${cutoff.toISOString()}::timestamptz
  `)) as unknown as { total: number | string }[];
  const total = rows[0]?.total;
  return total === undefined || total === null ? null : Number(total);
}

export async function updateThresholdProgress(): Promise<ThresholdProgress> {
  const auto: AutoThresholdMetrics = {
    tiktokViews30d: await sumLatestViews("tiktok", 30),
    youtubeShortsViews90d: await sumLatestViews("youtube", 90),
    xImpressions3mo: await sumLatestViews("x", 90),
  };
  const current = await getSetting<ThresholdProgress>(THRESHOLD_PROGRESS_SETTING_KEY);
  const merged = mergeThreshold(current, auto, new Date().toISOString());
  await setSetting(THRESHOLD_PROGRESS_SETTING_KEY, merged);
  log.info({ auto }, "threshold progress updated");
  return merged;
}

// Rolling category×platform velocity baseline, materialized in settings (doc 04 §2).
// Key: baseline:<categoryId>:<platform>. Self-healing: recomputed lazily when >24 h old
// (the doc hangs recompute off the daily costs.rollup step — that cron lands with doc 08;
// lazy refresh keeps the same materialized behavior meanwhile).
import { BASELINE_MAX_AGE_HOURS, BASELINE_WINDOW_DAYS } from "@ve/core";
import { db, getSetting, setSetting, sql } from "@ve/db";
import { type Baseline, meanStd, type SnapshotPoint, viewsPerHour } from "./stats";

export function baselineKey(categoryId: string, platform: string): string {
  return `baseline:${categoryId}:${platform}`;
}

interface SnapshotRow {
  rawItemId: string;
  capturedAt: Date | string; // raw db.execute rows may carry timestamps unparsed
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  score: number | null;
}

export async function recomputeBaseline(categoryId: string, platform: string): Promise<Baseline> {
  const rows = (await db.execute(sql`
    select s.raw_item_id as "rawItemId", s.captured_at as "capturedAt",
           s.views, s.likes, s.comments, s.shares, s.score
    from item_snapshots s
    join raw_items ri on ri.id = s.raw_item_id
    where ri.category_id = ${categoryId} and ri.platform = ${platform}
      and s.captured_at >= now() - make_interval(days => ${BASELINE_WINDOW_DAYS})
    order by s.raw_item_id, s.captured_at asc
  `)) as unknown as SnapshotRow[];

  const byItem = new Map<string, SnapshotPoint[]>();
  for (const r of rows) {
    const arr = byItem.get(r.rawItemId) ?? [];
    arr.push({ ...r, capturedAt: new Date(r.capturedAt) });
    byItem.set(r.rawItemId, arr);
  }
  const rates: number[] = [];
  for (const points of byItem.values()) {
    const vph = viewsPerHour(points);
    if (vph !== null) rates.push(vph);
  }
  const { mean, std } = meanStd(rates);
  const baseline: Baseline = { mean, std, n: rates.length, computedAt: new Date().toISOString() };
  await setSetting(baselineKey(categoryId, platform), baseline);
  return baseline;
}

/** Cached-in-settings baseline; recomputes when missing or older than 24 h. */
export async function ensureBaseline(categoryId: string, platform: string): Promise<Baseline> {
  const cached = await getSetting<Baseline>(baselineKey(categoryId, platform));
  if (
    cached &&
    Date.now() - new Date(cached.computedAt).getTime() < BASELINE_MAX_AGE_HOURS * 3_600_000
  ) {
    return cached;
  }
  return recomputeBaseline(categoryId, platform);
}

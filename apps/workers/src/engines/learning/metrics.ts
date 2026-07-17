// metrics.snapshot (doc 07 §1): +3h/+24h after publish (enqueued by publish.execute),
// then a daily 06:00 IST sweep of posts published in the last 30 days (weekly to 90d,
// then stop). Preserves the raw payload; guards views monotonicity; retries missing
// analytics silently ×3 then alerts. Cadence + guard are pure and unit-tested.
import {
  makeLogger,
  newId,
  type Platform,
  SNAPSHOT_ANOMALY_DROP_RATIO,
  SNAPSHOT_DAILY_MAX_AGE_DAYS,
  SNAPSHOT_DEDUPE_HOURS,
  SNAPSHOT_MISSING_RETRY_MAX,
  SNAPSHOT_WEEKLY_MAX_AGE_DAYS,
} from "@ve/core";
import { db, eq, getSetting, inArray, postSnapshots, posts, setSetting, sql } from "@ve/db";
import { type Enqueuer, enqueueAlert } from "../../harness";
import { learningDeps as L } from "./deps";

const log = makeLogger("learning-metrics");

export interface NormalizedMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  watchTimeSec: number | null;
  avgViewDurationSec: number | null;
  raw: Record<string, unknown>;
}

export interface SweepCandidate {
  postId: string;
  publishedAt: Date;
  lastSnapshotAt: Date | null;
}

/** Which posts the daily sweep snapshots this cycle (doc 07 §1 cadence). Pure. */
export function pickSweepPosts(cands: SweepCandidate[], now: Date): string[] {
  const out: string[] = [];
  for (const c of cands) {
    const ageDays = (now.getTime() - c.publishedAt.getTime()) / 86_400_000;
    if (ageDays > SNAPSHOT_WEEKLY_MAX_AGE_DAYS) continue; // >90d → stop
    const sinceSnapHours = c.lastSnapshotAt
      ? (now.getTime() - c.lastSnapshotAt.getTime()) / 3_600_000
      : Number.POSITIVE_INFINITY;
    if (sinceSnapHours < SNAPSHOT_DEDUPE_HOURS) continue; // deduped (a scheduled snap just ran)
    if (ageDays <= SNAPSHOT_DAILY_MAX_AGE_DAYS) {
      out.push(c.postId);
    } else if (sinceSnapHours >= 24 * 7) {
      out.push(c.postId); // 30–90d → weekly
    }
  }
  return out;
}

/** Views must be monotonic non-decreasing; a drop >5% is kept but flagged (doc 07 §1). */
export function monotonicViews(
  prev: number | null,
  next: number | null,
): { views: number | null; anomaly: boolean } {
  if (next === null) return { views: prev, anomaly: false };
  if (prev !== null && next < prev * (1 - SNAPSHOT_ANOMALY_DROP_RATIO)) {
    return { views: next, anomaly: true };
  }
  return { views: next, anomaly: false };
}

async function fetchMetrics(post: typeof posts.$inferSelect): Promise<NormalizedMetrics | null> {
  const platform = post.platform as Platform;
  if (platform === "x") {
    if (!post.externalId) return null;
    const map = await L.getOwnXMetrics([post.externalId]);
    const m = map.get(post.externalId);
    if (!m) return null;
    return {
      views: m.views ?? null,
      likes: m.likes ?? null,
      comments: m.comments ?? null,
      shares: m.shares ?? null,
      watchTimeSec: null,
      avgViewDurationSec: null,
      raw: { source: "x_own", ...m },
    };
  }
  if (!post.ayrsharePostId) return null;
  const a = await L.getPostAnalytics(post.ayrsharePostId);
  if (a.views === null && a.likes === null && a.comments === null && a.shares === null) return null;
  return {
    views: a.views,
    likes: a.likes,
    comments: a.comments,
    shares: a.shares,
    watchTimeSec: a.watchTimeSec,
    avgViewDurationSec: a.avgViewDurationSec,
    raw: a.raw,
  };
}

const missKey = (postId: string) => `snapshot_miss:${postId}`;

/** Snapshot one post: fetch, guard, insert (doc 07 §1). Returns whether a row was written. */
export async function snapshotOne(
  post: typeof posts.$inferSelect,
  boss: Enqueuer,
): Promise<{ written: boolean; missing: boolean }> {
  let metrics: NormalizedMetrics | null;
  try {
    metrics = await fetchMetrics(post);
  } catch (err) {
    log.warn({ err, postId: post.id }, "analytics fetch threw — treating as missing");
    metrics = null;
  }

  if (!metrics) {
    const misses = ((await getSetting<number>(missKey(post.id))) ?? 0) + 1;
    await setSetting(missKey(post.id), misses);
    if (misses > SNAPSHOT_MISSING_RETRY_MAX) {
      await enqueueAlert(
        boss,
        `🔥 metrics.snapshot: analytics missing ×${misses} | post:${post.id}`,
        `snapshot-miss:${post.id}`,
      );
    }
    return { written: false, missing: true };
  }
  await setSetting(missKey(post.id), 0);

  const [prev] = await db
    .select({ views: postSnapshots.views })
    .from(postSnapshots)
    .where(eq(postSnapshots.postId, post.id))
    .orderBy(sql`captured_at desc`)
    .limit(1);
  const guarded = monotonicViews(prev?.views ?? null, metrics.views);
  const raw = guarded.anomaly ? { ...metrics.raw, _anomaly: true } : metrics.raw;

  await db.insert(postSnapshots).values({
    id: newId(),
    postId: post.id,
    views: guarded.views,
    likes: metrics.likes,
    comments: metrics.comments,
    shares: metrics.shares,
    watchTimeSec: metrics.watchTimeSec,
    avgViewDurationSec:
      metrics.avgViewDurationSec !== null ? metrics.avgViewDurationSec.toFixed(2) : null,
    raw,
  });
  log.info({ postId: post.id, views: guarded.views, anomaly: guarded.anomaly }, "snapshot written");
  return { written: true, missing: false };
}

export async function metricsSnapshotHandler(
  payload: { postId?: string | undefined },
  boss: Enqueuer,
): Promise<{ written: number; missing: number }> {
  let targets: (typeof posts.$inferSelect)[];
  if (payload.postId) {
    const rows = await db.select().from(posts).where(eq(posts.id, payload.postId)).limit(1);
    // 2h dedupe for the scheduled +3h/+24h kinds (doc 08 §11)
    targets = [];
    for (const p of rows) {
      if (p.status !== "published") continue;
      const [recent] = await db
        .select({ at: postSnapshots.capturedAt })
        .from(postSnapshots)
        .where(eq(postSnapshots.postId, p.id))
        .orderBy(sql`captured_at desc`)
        .limit(1);
      const freshHours = recent ? (Date.now() - recent.at.getTime()) / 3_600_000 : Infinity;
      if (freshHours >= SNAPSHOT_DEDUPE_HOURS) targets.push(p);
    }
  } else {
    const now = new Date();
    const cutoff = new Date(now.getTime() - SNAPSHOT_WEEKLY_MAX_AGE_DAYS * 86_400_000);
    const cands = (await db.execute(sql`
      select p.id as "postId", p.published_at as "publishedAt", ls.at as "lastSnapshotAt"
      from posts p
      left join lateral (
        select max(captured_at) as at from post_snapshots s where s.post_id = p.id
      ) ls on true
      where p.status = 'published'
        and p.published_at >= ${cutoff.toISOString()}::timestamptz
    `)) as unknown as SweepCandidate[];
    const ids = pickSweepPosts(cands, now);
    targets = ids.length ? await db.select().from(posts).where(inArray(posts.id, ids)) : [];
  }

  let written = 0;
  let missing = 0;
  for (const post of targets) {
    const r = await snapshotOne(post, boss);
    if (r.written) written++;
    if (r.missing) missing++;
  }
  log.info({ targets: targets.length, written, missing }, "metrics.snapshot complete");
  return { written, missing };
}

import { asc, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { postSnapshots } from "../schema";

export interface PostsFilter {
  platform?: string;
  status?: string;
  categoryId?: string;
  q?: string; // matches brief angle / permalink
  limit?: number;
  /** keyset cursor: the last row's id (UUIDv7 — time-sortable + unique, no tie/precision loss) */
  cursor?: string;
}

export interface PostWithMetricsRow {
  id: string;
  briefId: string;
  renderId: string | null;
  categoryId: string;
  platform: string;
  status: string;
  scheduledFor: Date | null;
  publishedAt: Date | null;
  permalink: string | null;
  createdAt: Date;
  angle: string | null;
  categorySlug: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  snapshotAt: Date | null;
}

/** Posts joined to their lateral latest snapshot (doc 02 §7), keyset-paginated. */
export async function postsWithLatestMetrics(
  filter: PostsFilter = {},
): Promise<{ items: PostWithMetricsRow[]; nextCursor: string | null }> {
  const limit = Math.min(filter.limit ?? 50, 200);
  const rows = (await db.execute(sql`
    select
      p.id, p.brief_id as "briefId", p.render_id as "renderId", p.category_id as "categoryId",
      p.platform, p.status, p.scheduled_for as "scheduledFor", p.published_at as "publishedAt",
      p.permalink, p.created_at as "createdAt",
      b.angle, c.slug as "categorySlug",
      ls.views, ls.likes, ls.comments, ls.shares, ls.captured_at as "snapshotAt"
    from posts p
    join briefs b on b.id = p.brief_id
    join categories c on c.id = p.category_id
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.captured_at
      from post_snapshots s where s.post_id = p.id
      order by s.captured_at desc limit 1
    ) ls on true
    where true
      ${filter.platform ? sql`and p.platform = ${filter.platform}` : sql``}
      ${filter.status ? sql`and p.status = ${filter.status}` : sql``}
      ${filter.categoryId ? sql`and p.category_id = ${filter.categoryId}` : sql``}
      ${filter.q ? sql`and (b.angle ilike ${`%${filter.q}%`} or p.permalink ilike ${`%${filter.q}%`})` : sql``}
      ${filter.cursor ? sql`and p.id < ${filter.cursor}` : sql``}
    order by p.id desc
    limit ${limit + 1}
  `)) as unknown as PostWithMetricsRow[];

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  // raw db.execute returns bigint metrics as strings — coerce to numbers for the API
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const items = sliced.map((r) => ({
    ...r,
    views: num(r.views),
    likes: num(r.likes),
    comments: num(r.comments),
    shares: num(r.shares),
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? last.id : null,
  };
}

/** Snapshot series for one post, ascending — chart source (doc 02 §7). */
export async function postMetricsSeries(postId: string) {
  return db
    .select()
    .from(postSnapshots)
    .where(eq(postSnapshots.postId, postId))
    .orderBy(asc(postSnapshots.capturedAt));
}

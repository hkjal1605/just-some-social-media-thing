import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client";
import { itemSnapshots, rawItems, trends } from "../schema";

export interface TopTrendRow {
  id: string;
  categoryId: string;
  categorySlug: string;
  status: string;
  headline: string;
  summary: string;
  rightsClass: string;
  velocityScore: string | null;
  llmScore: number | null;
  longevity: string | null;
  formatArchetype: string | null;
  firstDetectedAt: Date;
  memberCount: number;
  totalViews: number;
}

/** Trends ordered by llm_score, velocity — with latest member snapshot aggregates (doc 02 §7). */
export async function topTrends(
  opts: { categoryId?: string; status?: string; limit?: number } = {},
): Promise<TopTrendRow[]> {
  const status = opts.status ?? "active";
  const limit = Math.min(opts.limit ?? 20, 100);
  const rows = await db.execute(sql`
    select
      t.id,
      t.category_id as "categoryId",
      c.slug as "categorySlug",
      t.status,
      t.headline,
      t.summary,
      t.rights_class as "rightsClass",
      t.velocity_score as "velocityScore",
      t.llm_score as "llmScore",
      t.longevity,
      t.format_archetype as "formatArchetype",
      t.first_detected_at as "firstDetectedAt",
      (select count(*)::int from trend_members tm where tm.trend_id = t.id) as "memberCount",
      coalesce((
        select sum(latest.views)
        from trend_members tm
        join lateral (
          select s.views from item_snapshots s
          where s.raw_item_id = tm.raw_item_id and s.views is not null
          order by s.captured_at desc limit 1
        ) latest on true
        where tm.trend_id = t.id
      ), 0)::bigint as "totalViews"
    from trends t
    join categories c on c.id = t.category_id
    where t.status = ${status}
      ${opts.categoryId ? sql`and t.category_id = ${opts.categoryId}` : sql``}
    order by t.llm_score desc nulls last, t.velocity_score desc nulls last, t.first_detected_at desc
    limit ${limit}
  `);
  // raw db.execute returns bigint (totalViews) + int (memberCount) as strings — coerce so the
  // number-typed fields are honestly numbers (arithmetic/sorting downstream would break otherwise).
  return (
    rows as unknown as (Omit<TopTrendRow, "totalViews" | "memberCount"> & {
      totalViews: string | number;
      memberCount: string | number;
    })[]
  ).map((r) => ({
    ...r,
    totalViews: Number(r.totalViews),
    memberCount: Number(r.memberCount),
  }));
}

export interface TrendDetail {
  trend: typeof trends.$inferSelect;
  members: {
    rawItemId: string;
    similarity: string | null;
    platform: string;
    url: string;
    title: string | null;
    author: string | null;
    thumbnailUrl: string | null;
    publishedAt: Date | null;
    latest: { views: number | null; likes: number | null; comments: number | null } | null;
  }[];
  /** per-member snapshot series, ascending — chart source (doc 10 §3.2) */
  series: {
    rawItemId: string;
    capturedAt: Date;
    views: number | null;
    likes: number | null;
    comments: number | null;
  }[];
}

/** Trend + members + snapshot series (doc 04 §6 dashboard contract). */
export async function trendDetail(trendId: string): Promise<TrendDetail | null> {
  const [trend] = await db.select().from(trends).where(eq(trends.id, trendId)).limit(1);
  if (!trend) return null;

  const members = (await db.execute(sql`
    select
      tm.raw_item_id as "rawItemId",
      tm.similarity,
      ri.platform, ri.url, ri.title, ri.author,
      ri.thumbnail_url as "thumbnailUrl", ri.published_at as "publishedAt",
      (
        select json_build_object('views', s.views, 'likes', s.likes, 'comments', s.comments)
        from item_snapshots s where s.raw_item_id = tm.raw_item_id
        order by s.captured_at desc limit 1
      ) as latest
    from trend_members tm
    join raw_items ri on ri.id = tm.raw_item_id
    where tm.trend_id = ${trendId}
    order by ri.first_seen_at asc
  `)) as unknown as TrendDetail["members"];

  const memberIds = members.map((m) => m.rawItemId);
  const series =
    memberIds.length === 0
      ? []
      : await db
          .select({
            rawItemId: itemSnapshots.rawItemId,
            capturedAt: itemSnapshots.capturedAt,
            views: itemSnapshots.views,
            likes: itemSnapshots.likes,
            comments: itemSnapshots.comments,
          })
          .from(itemSnapshots)
          .where(inArray(itemSnapshots.rawItemId, memberIds))
          .orderBy(asc(itemSnapshots.capturedAt));

  return { trend, members, series };
}

/** Member raw_items for embedding work (doc 04 §3.1). */
export async function rawItemsByIds(rawItemIds: string[]) {
  if (rawItemIds.length === 0) return [];
  return db.select().from(rawItems).where(inArray(rawItems.id, rawItemIds));
}

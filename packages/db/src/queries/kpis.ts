import { sql } from "drizzle-orm";
import { db } from "../client";

export interface DashboardKpis {
  posts7d: number;
  views7d: number;
  pendingApprovals: number;
  spendMtd: number;
  topPost7d: {
    id: string;
    platform: string;
    permalink: string | null;
    views: number;
    thumbR2Key: string | null;
  } | null;
}

/** Single round-trip KPI bundle for the dashboard Overview (doc 02 §7). */
export async function dashboardKpis(): Promise<DashboardKpis> {
  const rows = (await db.execute(sql`
    select
      (select count(*)::int from posts
        where status = 'published' and published_at >= now() - interval '7 days') as "posts7d",
      coalesce((
        select sum(ls.views) from posts p
        join lateral (
          select s.views from post_snapshots s
          where s.post_id = p.id and s.views is not null
          order by s.captured_at desc limit 1
        ) ls on true
        where p.published_at >= now() - interval '7 days'
      ), 0)::bigint as "views7d",
      (select count(*)::int from approvals where status = 'pending') as "pendingApprovals",
      (
        coalesce((select sum(cost_usd) from llm_usage
          where date_trunc('month', at) = date_trunc('month', now())), 0)
        + coalesce((select sum(cost_usd) from api_usage
          where date_trunc('month', at) = date_trunc('month', now())), 0)
      )::float as "spendMtd",
      (
        select json_build_object(
          'id', p.id, 'platform', p.platform, 'permalink', p.permalink,
          'views', ls.views, 'thumbR2Key', r.thumb_r2_key
        )
        from posts p
        join lateral (
          select s.views from post_snapshots s
          where s.post_id = p.id and s.views is not null
          order by s.captured_at desc limit 1
        ) ls on true
        left join renders r on r.id = p.render_id
        where p.published_at >= now() - interval '7 days'
        order by ls.views desc nulls last limit 1
      ) as "topPost7d"
  `)) as unknown as (Omit<DashboardKpis, "views7d" | "topPost7d"> & {
    views7d: number | string;
    topPost7d: DashboardKpis["topPost7d"] | null;
  })[];

  const r = rows[0];
  if (!r) throw new Error("dashboardKpis returned no row");
  return {
    posts7d: r.posts7d,
    views7d: Number(r.views7d),
    pendingApprovals: r.pendingApprovals,
    spendMtd: r.spendMtd,
    topPost7d: r.topPost7d ?? null,
  };
}

export interface DashboardTimeseries {
  /** snapshot views captured per IST day, per platform (doc 10 §3.1 "views over time"). */
  viewsByDay: { day: string; platform: string; views: number }[];
  /** posts created per IST day, per status (doc 10 §3.1 "posts by status"). */
  postsByDay: { day: string; status: string; n: number }[];
}

/** Overview time series (doc 10 §3.1). Days are IST calendar days. */
export async function dashboardTimeseries(days = 14): Promise<DashboardTimeseries> {
  // views GAINED per IST day (doc 10 §3.1) — the delta between consecutive snapshots of each post,
  // not the cumulative counter summed (which double-counts posts snapshotted twice/day and only ever
  // rises). greatest(0, …) drops platform-correction dips; the +2-day buffer gives the first window
  // day a prior-snapshot baseline. (M13)
  const viewsByDay = (await db.execute(sql`
    with deltas as (
      select p.platform, s.captured_at, s.views,
             lag(s.views) over (partition by s.post_id order by s.captured_at) as prev_views
      from post_snapshots s
      join posts p on p.id = s.post_id
      where s.views is not null
        and s.captured_at >= now() - make_interval(days => ${days} + 2)
    )
    select to_char(captured_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day,
           platform, sum(greatest(0, views - prev_views))::bigint as views
    from deltas
    where prev_views is not null
      and captured_at >= now() - make_interval(days => ${days})
    group by day, platform
    order by day asc
  `)) as unknown as { day: string; platform: string; views: number | string }[];

  const postsByDay = (await db.execute(sql`
    select to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day,
           status, count(*)::int as n
    from posts
    where created_at >= now() - make_interval(days => ${days})
    group by day, status
    order by day asc
  `)) as unknown as { day: string; status: string; n: number }[];

  return {
    viewsByDay: viewsByDay.map((r) => ({ ...r, views: Number(r.views) })),
    postsByDay,
  };
}

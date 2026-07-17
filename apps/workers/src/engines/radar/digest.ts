// radar.digest (doc 04 §5): 08:00 & 20:00 IST markdown to the approval chat —
// top trends per category with rights chips, briefs since last digest, pending
// approvals, yesterday's post one-liner.
import { makeLogger, toDisplay } from "@ve/core";
import { db, getSetting, setSetting, sql, type TopTrendRow, topTrends } from "@ve/db";
import { sendDigest } from "@ve/telegram";

const log = makeLogger("radar-digest");

const RIGHTS_CHIP: Record<string, string> = { green: "🟢", amber: "🟡", red: "🔴" };

export interface DigestData {
  generatedAt: Date;
  categories: {
    slug: string;
    trends: (TopTrendRow & { topUrls: string[] })[];
  }[];
  briefsSinceLast: { angle: string; categorySlug: string; formatSlug: string }[];
  pendingApprovals: number;
  postsYesterday: { published: number; topViews: number | null };
}

/** Pure renderer — unit-tested without a bot. */
const DIGEST_MAX_CHARS = 3900; // Telegram message ceiling (4096) with headroom

export function buildDigestMarkdown(d: DigestData): string {
  const header = `*📡 Radar digest* — ${toDisplay(d.generatedAt)}`;

  const trendLines: string[] = [];
  for (const cat of d.categories) {
    if (cat.trends.length === 0) continue;
    trendLines.push(`*${cat.slug}*`);
    for (const t of cat.trends) {
      const chip = RIGHTS_CHIP[t.rightsClass] ?? "⚪";
      const vel = t.velocityScore !== null ? ` · v${Number(t.velocityScore).toFixed(1)}` : "";
      trendLines.push(`${chip} *${t.llmScore ?? "–"}*${vel} ${t.headline}`);
      for (const url of t.topUrls.slice(0, 2)) trendLines.push(`   ${url}`);
    }
    trendLines.push("");
  }
  if (d.categories.every((c) => c.trends.length === 0)) {
    trendLines.push("_No live trends yet — scouts run every 30–60 min._", "");
  }

  // The footer is the operator summary (briefs / pending approvals / yesterday) — always keep it,
  // and truncate the trends BODY to fit instead. Slicing the whole message dropped this footer once
  // there were enough trends to blow the Telegram ceiling.
  const footer = [
    `*Briefs since last digest:* ${d.briefsSinceLast.length}`,
    ...d.briefsSinceLast
      .slice(0, 5)
      .map((b) => `• [${b.categorySlug}] ${b.formatSlug} — ${b.angle}`),
    "",
    `*Pending approvals:* ${d.pendingApprovals}`,
    `*Yesterday:* ${d.postsYesterday.published} posts published` +
      (d.postsYesterday.topViews !== null ? ` · top ${d.postsYesterday.topViews} views` : ""),
  ].join("\n");

  const head = `${header}\n\n`;
  const room = Math.max(0, DIGEST_MAX_CHARS - head.length - footer.length - 2);
  const body = trendLines.join("\n").slice(0, room);
  return `${head}${body}\n${footer}`;
}

export async function gatherDigestData(): Promise<DigestData> {
  const cats = (await db.execute(
    sql`select id, slug from categories where active = true order by slug`,
  )) as unknown as { id: string; slug: string }[];

  const categoriesData: DigestData["categories"] = [];
  for (const c of cats) {
    const trends = await topTrends({ categoryId: c.id, status: "active", limit: 10 });
    const withUrls = [];
    for (const t of trends) {
      const urls = (await db.execute(sql`
        select ri.url from trend_members tm
        join raw_items ri on ri.id = tm.raw_item_id
        where tm.trend_id = ${t.id}
        order by tm.similarity desc nulls last limit 2
      `)) as unknown as { url: string }[];
      withUrls.push({ ...t, topUrls: urls.map((u) => u.url) });
    }
    categoriesData.push({ slug: c.slug, trends: withUrls });
  }

  const lastDigestAt =
    (await getSetting<string>("last_digest_at")) ??
    new Date(Date.now() - 12 * 3_600_000).toISOString();

  const briefsSinceLast = (await db.execute(sql`
    select b.angle, c.slug as "categorySlug", b.format_slug as "formatSlug"
    from briefs b join categories c on c.id = b.category_id
    where b.created_at >= ${new Date(lastDigestAt).toISOString()}::timestamptz
    order by b.created_at desc limit 20
  `)) as unknown as DigestData["briefsSinceLast"];

  const pending = (await db.execute(
    sql`select count(*)::int as n from approvals where status = 'pending'`,
  )) as unknown as { n: number }[];

  const yesterday = (await db.execute(sql`
    select count(*)::int as published,
      max(ls.views)::bigint as "topViews"
    from posts p
    left join lateral (
      select s.views from post_snapshots s where s.post_id = p.id
      order by s.captured_at desc limit 1
    ) ls on true
    where p.published_at >= date_trunc('day', now()) - interval '1 day'
      and p.published_at < date_trunc('day', now())
  `)) as unknown as { published: number; topViews: number | null }[];

  return {
    generatedAt: new Date(),
    categories: categoriesData,
    briefsSinceLast,
    pendingApprovals: pending[0]?.n ?? 0,
    postsYesterday: {
      published: yesterday[0]?.published ?? 0,
      topViews: yesterday[0]?.topViews !== null ? Number(yesterday[0]?.topViews) : null,
    },
  };
}

export async function digestHandler(): Promise<string> {
  const data = await gatherDigestData();
  const md = buildDigestMarkdown(data);
  await sendDigest(md);
  await setSetting("last_digest_at", data.generatedAt.toISOString());
  log.info(
    { categories: data.categories.length, briefs: data.briefsSinceLast.length },
    "digest sent",
  );
  return md;
}

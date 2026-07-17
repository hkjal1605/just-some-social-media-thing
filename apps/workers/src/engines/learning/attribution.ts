// learn.attribute (doc 07 §2, Mondays 07:00 IST): assemble a feature vector per post,
// compute DETERMINISTIC tables (bucket medians, Spearman correlations, deciles, WoW deltas),
// hand them to the performance-analyst agent, store the report to R2, then kick off the
// playbook update + weekly digest. computeTables is pure and unit-tested.
import {
  ATTRIBUTION_MIN_AGE_DAYS,
  ATTRIBUTION_MIN_BUCKET_N,
  ATTRIBUTION_WINDOW_WEEKS,
  type AttributionReport,
  AttributionReportSchema,
  istParts,
  makeLogger,
  type PostFeatureVector,
  Q,
} from "@ve/core";
import { db, sql } from "@ve/db";
import { type AnalystTables, PERFORMANCE_ANALYST_SYSTEM, performanceAnalystUser } from "@ve/llm";
import { putObject, r2Key } from "@ve/storage";
import type { Enqueuer } from "../../harness";
import { learningDeps as L } from "./deps";
import { bucketize, extremeItems, leadingTrue, median, round, spearman, weeksAgo } from "./stats";

const log = makeLogger("learning-attribution");

/** A feature vector plus the fields the WoW math needs (not in the stored artifact). */
export interface FeatureRow extends PostFeatureVector {
  publishedAt: Date;
  weeksAgo: number;
}

// ── deterministic tables (doc 07 §2) — pure, so tests hand-compute the same numbers ──

const NUMERIC_FEATURES: { key: string; of: (r: FeatureRow) => number | null }[] = [
  { key: "hookTextLength", of: (r) => r.hookTextLength },
  { key: "estDurationSec", of: (r) => r.estDurationSec },
  { key: "actualDurationSec", of: (r) => r.actualDurationSec },
  { key: "sceneCount", of: (r) => r.sceneCount },
  { key: "publishHourLocal", of: (r) => r.publishHourLocal },
  { key: "timeFromTrendDetectionToPublishMin", of: (r) => r.timeFromTrendDetectionToPublishMin },
  { key: "trendLlmScore", of: (r) => r.trendLlmScore },
  { key: "trendVelocityScore", of: (r) => r.trendVelocityScore },
];

const CATEGORICAL_FEATURES: { key: string; of: (r: FeatureRow) => string | null }[] = [
  { key: "platform", of: (r) => r.platform },
  { key: "formatSlug", of: (r) => r.formatSlug },
  { key: "formatArchetype", of: (r) => r.formatArchetype },
  { key: "hookVariantChosen", of: (r) => r.hookVariantChosen },
  { key: "aiDisclosure", of: (r) => (r.aiDisclosure ? "ai" : "no-ai") },
  { key: "publishDow", of: (r) => (r.publishDow === null ? null : String(r.publishDow)) },
  {
    key: "publishHourBucket",
    of: (r) =>
      r.publishHourLocal === null
        ? null
        : `${Math.floor(r.publishHourLocal / 3) * 3}-${Math.floor(r.publishHourLocal / 3) * 3 + 2}`,
  },
];

const OUTCOME = (r: FeatureRow): number | null => r.views7d;

/** Per-format leading consecutive weeks below the category's weekly median (doc 07 §3). */
export function formatsUnderMedianWeeks(rows: FeatureRow[]): Record<string, number> {
  if (rows.length === 0) return {};
  const maxWeek = Math.max(...rows.map((r) => r.weeksAgo));
  const catMedByWeek = new Map<number, number | null>();
  for (let w = 0; w <= maxWeek; w++) {
    const vals = rows
      .filter((r) => r.weeksAgo === w)
      .map(OUTCOME)
      .filter((v): v is number => v !== null);
    catMedByWeek.set(w, median(vals));
  }
  const out: Record<string, number> = {};
  for (const f of [...new Set(rows.map((r) => r.formatSlug))]) {
    const flags: boolean[] = [];
    for (let w = 0; w <= maxWeek; w++) {
      const fvals = rows
        .filter((r) => r.formatSlug === f && r.weeksAgo === w)
        .map(OUTCOME)
        .filter((v): v is number => v !== null);
      if (fvals.length === 0) continue; // no posts that week — not counted
      const fMed = median(fvals) as number;
      const cMed = catMedByWeek.get(w);
      flags.push(cMed !== null && cMed !== undefined && fMed < cMed);
    }
    out[f] = leadingTrue(flags);
  }
  return out;
}

function decileSnapshot(r: FeatureRow) {
  return {
    postId: r.postId,
    platform: r.platform,
    formatSlug: r.formatSlug,
    hookTextLength: r.hookTextLength,
    publishHourLocal: r.publishHourLocal,
    views7d: r.views7d,
    engagementRate7d: r.engagementRate7d,
  };
}

/** Compute all attribution tables for one category (doc 07 §2). Pure. */
export function computeCategoryTables(categorySlug: string, rows: FeatureRow[]): AnalystTables {
  const bucketMedians: Record<string, unknown> = {};
  for (const f of CATEGORICAL_FEATURES) {
    bucketMedians[f.key] = bucketize(rows, f.of, OUTCOME, ATTRIBUTION_MIN_BUCKET_N).map((b) => ({
      bucket: b.bucket,
      n: b.n,
      median: b.median,
      insufficient: b.insufficient,
    }));
  }
  const numericCorrelations: Record<string, number | null> = {};
  for (const f of NUMERIC_FEATURES) {
    const pairs = rows
      .map((r) => [f.of(r), OUTCOME(r)] as [number | null, number | null])
      .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
    numericCorrelations[f.key] = round(spearman(pairs));
  }
  const { top, bottom } = extremeItems(rows, OUTCOME, 0.1);

  const maxWeek = rows.length ? Math.max(...rows.map((r) => r.weeksAgo)) : 0;
  const weekOverWeek: Record<string, Record<number, number | null>> = {};
  for (const fmt of [...new Set(rows.map((r) => r.formatSlug))]) {
    const perWeek: Record<number, number | null> = {};
    for (let w = 0; w <= maxWeek; w++) {
      const vals = rows
        .filter((r) => r.formatSlug === fmt && r.weeksAgo === w)
        .map(OUTCOME)
        .filter((v): v is number => v !== null);
      if (vals.length > 0) perWeek[w] = round(median(vals));
    }
    weekOverWeek[fmt] = perWeek;
  }

  return {
    categorySlug,
    postCount: rows.length,
    bucketMedians,
    numericCorrelations,
    topDecile: top.map(decileSnapshot),
    bottomDecile: bottom.map(decileSnapshot),
    weekOverWeek,
    formatsUnderMedianWeeks: formatsUnderMedianWeeks(rows),
  };
}

/** Group feature rows by category and compute tables for each. Pure. */
export function computeTables(rows: FeatureRow[]): AnalystTables[] {
  const byCat = new Map<string, FeatureRow[]>();
  for (const r of rows) {
    const arr = byCat.get(r.categorySlug);
    if (arr) arr.push(r);
    else byCat.set(r.categorySlug, [r]);
  }
  return [...byCat.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slug, rs]) => computeCategoryTables(slug, rs));
}

// ── feature-vector assembly (SQL + code) ─────────────────────────────

export async function buildFeatureRows(now: Date): Promise<FeatureRow[]> {
  const windowStart = new Date(now.getTime() - ATTRIBUTION_WINDOW_WEEKS * 7 * 86_400_000);
  const maturedBefore = new Date(now.getTime() - ATTRIBUTION_MIN_AGE_DAYS * 86_400_000);

  const rows = (await db.execute(sql`
    select
      p.id as "postId", p.platform, p.published_at as "publishedAt",
      c.slug as "categorySlug",
      b.format_slug as "formatSlug", b.created_at as "briefCreatedAt",
      t.llm_score as "trendLlmScore", t.velocity_score as "trendVelocityScore",
      t.first_detected_at as "trendDetectedAt",
      t.format_archetype as "trendArchetype", t.emotions as "emotions",
      s.chosen_hook as "chosenHook", s.hook_variants as "hookVariants",
      s.scene_count as "sceneCount", s.est_duration_sec as "estDurationSec",
      s.ai_disclosure as "aiDisclosure",
      r.duration_sec as "actualDurationSec",
      s24.views as "views24h",
      s7.views as "views7d", s7.likes as "likes7d", s7.comments as "comments7d",
      s7.shares as "shares7d", s7.avg_view_duration_sec as "avgViewDurationSec"
    from posts p
    join briefs b on b.id = p.brief_id
    join categories c on c.id = p.category_id
    left join trends t on t.id = b.trend_id
    left join lateral (
      select * from scripts sc where sc.brief_id = b.id order by sc.version desc limit 1
    ) s on true
    left join renders r on r.id = p.render_id
    left join lateral (
      select views from post_snapshots ps where ps.post_id = p.id
      order by abs(extract(epoch from (ps.captured_at - (p.published_at + interval '24 hours')))) asc
      limit 1
    ) s24 on true
    left join lateral (
      select views, likes, comments, shares, avg_view_duration_sec from post_snapshots ps
      where ps.post_id = p.id
      order by abs(extract(epoch from (ps.captured_at - (p.published_at + interval '7 days')))) asc
      limit 1
    ) s7 on true
    where p.status = 'published'
      and p.published_at >= ${windowStart.toISOString()}::timestamptz
      and p.published_at <= ${maturedBefore.toISOString()}::timestamptz
  `)) as unknown as Record<string, unknown>[];

  return rows.map((raw) => {
    const publishedAt = new Date(raw.publishedAt as string);
    const ist = istParts(publishedAt);
    const hookVariants = (raw.hookVariants as { id: string; text: string }[] | null) ?? [];
    const chosen = (raw.chosenHook as string | null) ?? "a";
    const hookText =
      hookVariants.find((h) => h.id === chosen)?.text ?? hookVariants[0]?.text ?? null;
    const views7d = num(raw.views7d);
    const eng =
      views7d && views7d > 0
        ? ((num(raw.likes7d) ?? 0) + (num(raw.comments7d) ?? 0) + (num(raw.shares7d) ?? 0)) /
          views7d
        : null;
    const detected = raw.trendDetectedAt ? new Date(raw.trendDetectedAt as string) : null;
    return {
      postId: raw.postId as string,
      categorySlug: raw.categorySlug as string,
      platform: raw.platform as string,
      formatSlug: raw.formatSlug as string,
      hookVariantChosen: chosen,
      hookTextLength: hookText ? hookText.length : null,
      estDurationSec: num(raw.estDurationSec),
      actualDurationSec: num(raw.actualDurationSec),
      sceneCount: num(raw.sceneCount),
      emotions: (raw.emotions as string[] | null) ?? [],
      formatArchetype: (raw.trendArchetype as string | null) ?? null,
      publishHourLocal: ist.hour,
      publishDow: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(ist.weekday),
      timeFromTrendDetectionToPublishMin: detected
        ? Math.round((publishedAt.getTime() - detected.getTime()) / 60_000)
        : null,
      aiDisclosure: raw.aiDisclosure === true,
      trendLlmScore: num(raw.trendLlmScore),
      trendVelocityScore: num(raw.trendVelocityScore),
      views24h: num(raw.views24h),
      views7d,
      engagementRate7d: eng !== null ? round(eng, 4) : null,
      avgViewDurationSec: num(raw.avgViewDurationSec),
      publishedAt,
      weeksAgo: weeksAgo(publishedAt, now),
    };
  });
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── report artifact ──────────────────────────────────────────────────

export function renderReportMarkdown(
  report: AttributionReport,
  tables: AnalystTables[],
  dateIso: string,
): string {
  const lines: string[] = [
    `# Attribution report — ${dateIso}`,
    "",
    `**${report.headline}**`,
    "",
    "## Wins",
    ...(report.wins.length
      ? report.wins.map((w) => `- (${w.confidence}) ${w.finding} — _${w.evidence}_`)
      : ["- none"]),
    "",
    "## Losses",
    ...(report.losses.length
      ? report.losses.map((l) => `- ${l.finding} — _${l.evidence}_`)
      : ["- none"]),
    "",
    "## Playbook edits",
    ...(report.playbookEdits.length
      ? report.playbookEdits.map(
          (e) => `- [${e.categorySlug} · ${e.section}] ${e.edit} (${e.rationale})`,
        )
      : ["- none"]),
    "",
    "## Kill list",
    ...(report.killList.length
      ? report.killList.map((k) => `- ${k.categorySlug} · ${k.formatSlug} — ${k.reason}`)
      : ["- none"]),
    "",
    "## Experiments",
    ...(report.experiments.length
      ? report.experiments.map((x) => `- ${x.hypothesis} → ${x.change} (watch: ${x.metric})`)
      : ["- none"]),
    "",
    "## Computed tables (evidence)",
    "```json",
    JSON.stringify(tables, null, 1),
    "```",
  ];
  return lines.join("\n");
}

/** learn.attribute handler (doc 07 §2). */
export async function attributionHandler(
  _payload: Record<string, never>,
  boss: Enqueuer,
): Promise<{ report: AttributionReport; reportKey: string; postCount: number }> {
  const now = new Date();
  const rows = await buildFeatureRows(now);
  const tables = computeTables(rows);

  // quiet week: no matured posts to attribute → skip the LLM call (wasted spend on empty tables)
  // and emit an empty report; the chain (playbook.update + weekly digest) still runs (M16).
  const report: AttributionReport =
    rows.length === 0
      ? {
          headline: "No posts matured this week — nothing to attribute.",
          wins: [],
          losses: [],
          playbookEdits: [],
          killList: [],
          experiments: [],
        }
      : await L.runStructured({
          agent: "performance-analyst",
          system: PERFORMANCE_ANALYST_SYSTEM,
          user: performanceAnalystUser({ windowWeeks: ATTRIBUTION_WINDOW_WEEKS, tables }),
          schema: AttributionReportSchema,
        });

  const dateIso = `${istParts(now).year}-${String(istParts(now).month).padStart(2, "0")}-${String(istParts(now).day).padStart(2, "0")}`;
  const reportKey = r2Key.attributionReport(dateIso);
  const md = renderReportMarkdown(report, tables, dateIso);
  await putObject(reportKey, new TextEncoder().encode(md), "text/markdown");
  // structured report alongside the markdown — playbook.update reads it back (doc 07 §3)
  await putObject(
    reportKey.replace(/\.md$/, ".json"),
    new TextEncoder().encode(JSON.stringify(report)),
    "application/json",
  );

  // hand off to the playbook updater, then the weekly digest tail step (doc 07 §3/§4)
  await boss.send(Q.playbookUpdate, { attributionReportKey: reportKey });
  log.info(
    { reportKey, postCount: rows.length, killList: report.killList.length },
    "attribution done",
  );
  return { report, reportKey, postCount: rows.length };
}

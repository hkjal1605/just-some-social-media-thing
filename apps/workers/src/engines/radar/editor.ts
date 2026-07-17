// Editor-in-chief (doc 04 §4): hourly, picks green/amber trends with llmScore ≥ 70,
// creates briefs within hard caps. Amber → commentary formats and the per-hour/cadence
// caps are enforced in code, not just the prompt.
import {
  AMBER_ALLOWED_FORMATS,
  EDITOR_FORMAT_SLUGS,
  EDITOR_MIN_LLM_SCORE,
  type EditorDecision,
  EditorDecisionSchema,
  FORMATS,
  type FormatSlug,
  KILL_LIST_SETTING_KEY,
  type KillList,
  MAX_BRIEFS_PER_HOUR_PER_CATEGORY,
  makeLogger,
  newId,
  PLATFORM,
  type Platform,
  Q,
} from "@ve/core";
import {
  and,
  briefs,
  categories,
  db,
  desc,
  eq,
  getSetting,
  gte,
  inArray,
  playbookVersions,
  sql,
  transitionTrend,
  trends,
} from "@ve/db";
import { EDITOR_SYSTEM, editorUser } from "@ve/llm";
import type { Enqueuer } from "../../harness";
import { radarDeps } from "./deps";

const log = makeLogger("radar-editor");

type Decision = EditorDecision["decisions"][number];
type BriefDecision = Extract<Decision, { act: "brief" }>;

/** Formats the learning loop killed for a category (doc 07 §3) — the editor excludes them. */
export function killedFormatsFor(killList: KillList | null, categorySlug: string): Set<string> {
  return new Set(Object.keys(killList?.[categorySlug] ?? {}));
}

/** Amber trends may only ship commentary formats — coerce in code (doc 04 §4). */
export function enforceAmberFormat(decision: BriefDecision, rightsClass: string): BriefDecision {
  if (rightsClass !== "amber") return decision;
  if ((AMBER_ALLOWED_FORMATS as readonly string[]).includes(decision.formatSlug)) return decision;
  return { ...decision, formatSlug: "faceless-explainer-60s" };
}

/** Target platforms must be a subset of the format's platforms with slots left. */
export function resolveTargetPlatforms(
  decision: BriefDecision,
  remainingSlots: Record<Platform, number>,
): Platform[] {
  const formatPlatforms: readonly Platform[] = FORMATS[decision.formatSlug as FormatSlug].platforms;
  const wanted: readonly Platform[] =
    decision.targetPlatforms.length > 0 ? decision.targetPlatforms : formatPlatforms;
  return wanted.filter((p) => formatPlatforms.includes(p) && (remainingSlots[p] ?? 0) > 0);
}

async function remainingSlotsToday(
  category: typeof categories.$inferSelect,
): Promise<Record<Platform, number>> {
  const caps = category.cadenceCaps as Record<Platform, number>;
  const counts = (await db.execute(sql`
    select platform, count(*)::int as n from posts
    where category_id = ${category.id}
      and status not in ('deleted', 'failed', 'draft')
      and coalesce(scheduled_for, published_at, created_at) >= date_trunc('day', now())
    group by platform
  `)) as unknown as { platform: Platform; n: number }[];
  const used = new Map(counts.map((c) => [c.platform, c.n]));
  const out = {} as Record<Platform, number>;
  for (const p of PLATFORM) out[p] = Math.max(0, (caps[p] ?? 0) - (used.get(p) ?? 0));
  return out;
}

export async function editorTickForCategory(
  category: typeof categories.$inferSelect,
  boss: Enqueuer,
): Promise<{ briefed: number; skipped: number }> {
  // radar_only categories (music) never reach the editor (doc 00 §2, doc 04 §7)
  if (category.mode === "radar_only" || !category.active) return { briefed: 0, skipped: 0 };

  const candidates = await db
    .select()
    .from(trends)
    .where(
      and(
        eq(trends.categoryId, category.id),
        eq(trends.status, "active"),
        inArray(trends.rightsClass, ["green", "amber"]),
        gte(trends.llmScore, EDITOR_MIN_LLM_SCORE),
      ),
    )
    .orderBy(desc(trends.llmScore))
    .limit(12);
  if (candidates.length === 0) return { briefed: 0, skipped: 0 };

  // per-hour cap counts briefs already created this hour (doc 04 §4)
  const recentCount = (await db.execute(sql`
    select count(*)::int as n from briefs
    where category_id = ${category.id} and created_at >= now() - interval '1 hour'
  `)) as unknown as { n: number }[];
  let briefBudget = Math.max(0, MAX_BRIEFS_PER_HOUR_PER_CATEGORY - (recentCount[0]?.n ?? 0));
  if (briefBudget === 0) return { briefed: 0, skipped: candidates.length };

  const remainingSlots = await remainingSlotsToday(category);
  if (Object.values(remainingSlots).every((n) => n === 0)) {
    log.info({ category: category.slug }, "editor: no cadence slots left today");
    return { briefed: 0, skipped: candidates.length };
  }

  // learning loop's kill list — killed (category, format) pairs are never chosen (doc 07 §3)
  const killedFormats = killedFormatsFor(
    await getSetting<KillList>(KILL_LIST_SETTING_KEY),
    category.slug,
  );

  const [playbook] = await db
    .select()
    .from(playbookVersions)
    .where(and(eq(playbookVersions.categoryId, category.id), sql`approved_at is not null`))
    .orderBy(desc(playbookVersions.version))
    .limit(1);

  const recentAngles = (
    await db
      .select({ angle: briefs.angle })
      .from(briefs)
      .where(and(eq(briefs.categoryId, category.id), sql`created_at >= now() - interval '7 days'`))
      .orderBy(desc(briefs.createdAt))
      .limit(20)
  ).map((b) => b.angle);

  const decision = await radarDeps.runStructured({
    agent: "editor-in-chief",
    system: EDITOR_SYSTEM,
    user: editorUser({
      categorySlug: category.slug,
      playbookMarkdown: playbook?.markdown ?? "",
      candidates: candidates.map((t) => ({
        trendId: t.id,
        headline: t.headline,
        summary: t.summary,
        rightsClass: t.rightsClass,
        llmScore: t.llmScore,
        velocityScore: t.velocityScore,
        longevity: t.longevity,
        transferability: t.transferability,
      })),
      remainingSlots,
      recentAngles,
    }),
    schema: EditorDecisionSchema,
    entity: { kind: "category", id: category.id },
  });

  const byTrend = new Map(candidates.map((t) => [t.id, t]));
  let briefed = 0;
  let skipped = 0;
  for (const raw of decision.decisions) {
    const trend = byTrend.get(raw.trendId);
    if (!trend) {
      log.warn({ trendId: raw.trendId }, "editor hallucinated a trendId — ignored");
      continue;
    }
    if (raw.act === "skip") {
      skipped++;
      continue;
    }
    if (briefBudget === 0) {
      skipped++;
      continue;
    }
    // clip-vertical (and any clip-captions format) needs a promoted source clip that a trend brief
    // has no way to produce — reject it here so the editor never mints an unrenderable brief (doc 05 §5).
    if (!(EDITOR_FORMAT_SLUGS as readonly string[]).includes(raw.formatSlug)) {
      log.warn(
        { trendId: trend.id, format: raw.formatSlug },
        "editor picked a clip-only format for a trend — skipped",
      );
      skipped++;
      continue;
    }
    const d = enforceAmberFormat(raw, trend.rightsClass);
    if (killedFormats.has(d.formatSlug)) {
      log.info(
        { trendId: trend.id, format: d.formatSlug },
        "editor: format on kill list — skipped",
      );
      skipped++;
      continue;
    }
    const targetPlatforms = resolveTargetPlatforms(d, remainingSlots);
    if (targetPlatforms.length === 0) {
      log.info({ trendId: trend.id }, "editor decision dropped: no platforms with slots");
      skipped++;
      continue;
    }

    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      trendId: trend.id,
      categoryId: category.id,
      originKind: "trend",
      status: "draft",
      angle: d.angle,
      formatSlug: d.formatSlug,
      targetPlatforms,
      playbookVersionId: playbook?.id ?? null,
    });
    await transitionTrend(db, trend.id, "briefed");
    await boss.send(Q.factoryScript, { briefId });
    for (const p of targetPlatforms) remainingSlots[p] = Math.max(0, remainingSlots[p] - 1);
    briefBudget--;
    briefed++;
    log.info(
      { briefId, trendId: trend.id, format: d.formatSlug, platforms: targetPlatforms },
      "brief created",
    );
  }
  return { briefed, skipped };
}

/** factory.brief hourly tick (doc 04 §4). */
export async function editorTick(boss: Enqueuer): Promise<{ briefed: number }> {
  const cats = await db.select().from(categories).where(eq(categories.active, true));
  let briefed = 0;
  for (const c of cats) {
    try {
      const res = await editorTickForCategory(c, boss);
      briefed += res.briefed;
    } catch (err) {
      // isolate per-category failures (e.g. an intermittent LLM structured-output miss): one
      // category must not starve the others of briefs for the hour, nor make the retry re-run the
      // categories that already succeeded. It simply gets no briefs this tick and retries next hour.
      log.error({ err, category: c.slug }, "editor failed for category — skipped, others continue");
    }
  }
  return { briefed };
}

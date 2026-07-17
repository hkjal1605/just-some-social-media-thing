// playbook.update (doc 07 §3, right after learn.attribute): apply the report's edits,
// kill-list, and experiments to each affected category's playbook via the playbook-editor
// agent → a new unapproved playbook_versions draft (human approves in the dashboard).
// Kill-list enforcement is mechanical: write settings.kill_list (the editor-in-chief reads
// it) and revoke auto-approve for the killed (category, format). Then the weekly digest.
import {
  type AttributionReport,
  AttributionReportSchema,
  type CategoriesAutoApproveFormats,
  emptyPlaybookMarkdown,
  KILL_LIST_SETTING_KEY,
  type KillList,
  makeLogger,
  newId,
  PLAYBOOK_DRAFT_STALE_DAYS,
  PlaybookRewriteSchema,
} from "@ve/core";
import { categories, db, desc, eq, getSetting, playbookVersions, setSetting, sql } from "@ve/db";
import { PLAYBOOK_EDITOR_SYSTEM, playbookEditorUser } from "@ve/llm";
import { getObjectBytes } from "@ve/storage";
import { type Enqueuer, enqueueAlert } from "../../harness";
import { learningDeps as L } from "./deps";
import { sendWeeklyDigest } from "./digest";

const log = makeLogger("learning-playbook");

/** Load the AttributionReport JSON that attribution stored next to the markdown. */
async function loadReport(mdKey: string): Promise<AttributionReport | null> {
  const jsonKey = mdKey.replace(/\.md$/, ".json");
  try {
    const bytes = await getObjectBytes(jsonKey);
    return AttributionReportSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (err) {
    log.warn({ err, jsonKey }, "playbook.update: could not load report json");
    return null;
  }
}

/** Apply the report to one category's playbook → new draft version. Returns the new version. */
export async function applyPlaybookForCategory(
  categorySlug: string,
  report: AttributionReport,
): Promise<number | null> {
  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, categorySlug))
    .limit(1);
  if (!category) {
    log.warn({ categorySlug }, "playbook.update: unknown category — skipped");
    return null;
  }

  const [latest] = await db
    .select()
    .from(playbookVersions)
    .where(eq(playbookVersions.categoryId, category.id))
    .orderBy(desc(playbookVersions.version))
    .limit(1);
  const currentMarkdown = latest?.markdown ?? emptyPlaybookMarkdown(categorySlug);

  const edits = report.playbookEdits.filter((e) => e.categorySlug === categorySlug);
  const killList = report.killList
    .filter((k) => k.categorySlug === categorySlug)
    .map((k) => ({ formatSlug: k.formatSlug, reason: k.reason }));
  const experiments = report.experiments; // experiments aren't category-scoped in the schema
  if (edits.length === 0 && killList.length === 0 && experiments.length === 0) return null;

  const rewrite = await L.runStructured({
    agent: "playbook-editor",
    system: PLAYBOOK_EDITOR_SYSTEM,
    user: playbookEditorUser({ categorySlug, currentMarkdown, edits, killList, experiments }),
    schema: PlaybookRewriteSchema,
    entity: { kind: "category", id: category.id },
  });

  const nextVersion = (latest?.version ?? 0) + 1;
  await db.insert(playbookVersions).values({
    id: newId(),
    categoryId: category.id,
    version: nextVersion,
    markdown: rewrite.markdown,
    changeSummary: rewrite.changeSummary,
    createdBy: "system",
    approvedAt: null,
  });
  log.info({ categorySlug, version: nextVersion }, "playbook draft created");
  return nextVersion;
}

/** Mechanical kill-list enforcement (doc 07 §3): settings.kill_list + revoke auto-approve. */
export async function enforceKillList(report: AttributionReport, boss: Enqueuer): Promise<number> {
  if (report.killList.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const killList = ((await getSetting<KillList>(KILL_LIST_SETTING_KEY)) ?? {}) as KillList;

  for (const k of report.killList) {
    killList[k.categorySlug] ??= {};
    (killList[k.categorySlug] as Record<string, { reason: string; addedAt: string }>)[
      k.formatSlug
    ] = {
      reason: k.reason,
      addedAt: nowIso,
    };
    // revoke any earned auto-approval for the killed (category, format)
    const [category] = await db
      .select()
      .from(categories)
      .where(eq(categories.slug, k.categorySlug))
      .limit(1);
    if (category) {
      const earned = (category.autoApproveFormats ?? []) as CategoriesAutoApproveFormats;
      if (earned.includes(k.formatSlug)) {
        await db
          .update(categories)
          .set({
            autoApproveFormats: earned.filter((f) => f !== k.formatSlug),
            updatedAt: new Date(),
          })
          .where(eq(categories.id, category.id));
        await enqueueAlert(
          boss,
          `🛑 auto-approve revoked (kill list) | ${k.categorySlug} · ${k.formatSlug} | ${k.reason}`,
          `killlist:${k.categorySlug}:${k.formatSlug}`,
        );
      }
    }
  }
  await setSetting(KILL_LIST_SETTING_KEY, killList);
  return report.killList.length;
}

export async function playbookUpdateHandler(
  payload: { attributionReportKey?: string | undefined },
  boss: Enqueuer,
): Promise<{ drafts: number; killed: number }> {
  if (!payload.attributionReportKey) {
    log.warn("playbook.update: no attributionReportKey — nothing to apply");
    return { drafts: 0, killed: 0 };
  }
  const report = await loadReport(payload.attributionReportKey);
  if (!report) return { drafts: 0, killed: 0 };

  const slugs = new Set<string>([
    ...report.playbookEdits.map((e) => e.categorySlug),
    ...report.killList.map((k) => k.categorySlug),
  ]);
  let drafts = 0;
  for (const slug of slugs) {
    const v = await applyPlaybookForCategory(slug, report);
    if (v !== null) drafts++;
  }

  const killed = await enforceKillList(report, boss);

  // unapproved drafts older than the SLA get an alert so they don't rot unreviewed (doc 07 §3, M16)
  const stale = (await db.execute(sql`
    select count(*)::int as n from playbook_versions
    where approved_at is null
      and created_at < now() - make_interval(days => ${PLAYBOOK_DRAFT_STALE_DAYS})
  `)) as unknown as { n: number }[];
  const staleCount = stale[0]?.n ?? 0;
  if (staleCount > 0) {
    await enqueueAlert(
      boss,
      `📝 ${staleCount} playbook draft(s) awaiting approval >${PLAYBOOK_DRAFT_STALE_DAYS}d — review in the dashboard`,
      "playbook-drafts-stale",
    );
  }

  // weekly digest tail step (doc 07 §4)
  await sendWeeklyDigest(report, payload.attributionReportKey).catch((err) =>
    log.warn({ err }, "weekly digest send failed"),
  );

  log.info({ drafts, killed }, "playbook.update complete");
  return { drafts, killed };
}

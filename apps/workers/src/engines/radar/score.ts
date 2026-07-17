// radar.score (doc 04 §2): Layer A statistics on every batch, Layer B LLM rubric
// only for survivors — cheap-first. Results ride the radar.cluster payload.
import {
  ITEM_AGE_LLM_CUTOFF_HOURS,
  makeLogger,
  Q,
  type RubricResult,
  RubricResultSchema,
  type ScoredItem,
  VELOCITY_MIN_FOR_LLM,
} from "@ve/core";
import { asc, categories, db, eq, inArray, itemSnapshots, rawItems, trends } from "@ve/db";
import { RADAR_RUBRIC_PROMPT } from "@ve/llm";
import type { Enqueuer } from "../../harness";
import { ensureBaseline } from "./baseline";
import { radarDeps } from "./deps";
import { engagementRate, type SnapshotPoint, velocityZ, viewsPerHour } from "./stats";

const log = makeLogger("radar-score");

interface ItemStats {
  rawItemId: string;
  velocityScore: number | null;
}

/** Layer A for one item: velocity z-score vs the category×platform baseline. */
export async function layerAVelocity(
  categoryId: string,
  platform: string,
  snapshots: SnapshotPoint[],
): Promise<number | null> {
  const vph = viewsPerHour(snapshots);
  if (vph === null) return null;
  const baseline = await ensureBaseline(categoryId, platform);
  return velocityZ(vph, baseline);
}

function metricsSummary(latest: SnapshotPoint | undefined): string {
  if (!latest) return "no metrics yet";
  const er = engagementRate(latest);
  return [
    latest.views !== null ? `views:${latest.views}` : null,
    latest.likes !== null ? `likes:${latest.likes}` : null,
    latest.comments !== null ? `comments:${latest.comments}` : null,
    latest.shares !== null ? `shares:${latest.shares}` : null,
    latest.score !== null ? `score:${latest.score}` : null,
    er !== null ? `engagement:${(er * 100).toFixed(1)}%` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function scoreHandler(
  payload: { categoryId: string; rawItemIds: string[] },
  boss: Enqueuer,
): Promise<{ scored: ScoredItem[]; velocityOnly: ScoredItem[] }> {
  const empty = { scored: [], velocityOnly: [] };
  if (payload.rawItemIds.length === 0) return empty;

  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, payload.categoryId))
    .limit(1);
  if (!category) {
    log.warn({ categoryId: payload.categoryId }, "score skipped: category missing");
    return empty;
  }

  const items = await db.select().from(rawItems).where(inArray(rawItems.id, payload.rawItemIds));
  if (items.length === 0) return empty;

  const snapshotRows = await db
    .select()
    .from(itemSnapshots)
    .where(inArray(itemSnapshots.rawItemId, payload.rawItemIds))
    .orderBy(asc(itemSnapshots.capturedAt));
  const snapsByItem = new Map<string, SnapshotPoint[]>();
  for (const s of snapshotRows) {
    const arr = snapsByItem.get(s.rawItemId) ?? [];
    arr.push(s);
    snapsByItem.set(s.rawItemId, arr);
  }

  // items already clustered: 'briefed' trends stop here entirely (doc 04 §2);
  // members of live trends skip Layer B (their trend keeps its rubric) but still
  // contribute a velocity refresh to the rollup.
  const trendIds = [...new Set(items.map((i) => i.trendId).filter((t): t is string => t !== null))];
  const trendStatus = new Map<string, string>(
    trendIds.length === 0
      ? []
      : (await db.select().from(trends).where(inArray(trends.id, trendIds))).map((t) => [
          t.id,
          t.status,
        ]),
  );

  const stats = new Map<string, ItemStats>();
  const survivors: typeof items = [];
  const velocityOnly: ScoredItem[] = [];

  for (const item of items) {
    const snaps = snapsByItem.get(item.id) ?? [];
    const velocity = await layerAVelocity(payload.categoryId, item.platform, snaps);
    stats.set(item.id, { rawItemId: item.id, velocityScore: velocity });

    if (item.trendId) {
      if (trendStatus.get(item.trendId) === "briefed") continue; // stop (doc 04 §2)
      velocityOnly.push({ rawItemId: item.id, velocityScore: velocity });
      continue;
    }

    const ageHours = item.publishedAt
      ? (Date.now() - item.publishedAt.getTime()) / 3_600_000
      : (Date.now() - item.firstSeenAt.getTime()) / 3_600_000;
    const lowVelocity = velocity !== null && velocity < VELOCITY_MIN_FOR_LLM;
    if (lowVelocity && ageHours > ITEM_AGE_LLM_CUTOFF_HOURS) continue; // no LLM spend (doc 04 §2)
    survivors.push(item);
  }

  let scored: ScoredItem[] = [];
  if (survivors.length > 0) {
    const rubricInput = survivors.map((item) => ({
      id: item.id,
      text: [
        `platform: ${item.platform}`,
        `category: ${category.slug}`,
        `content: ${item.title ?? ""} ${item.text ?? ""}`.slice(0, 600),
        `metrics: ${metricsSummary(snapsByItem.get(item.id)?.at(-1))}`,
      ].join("\n"),
    }));
    const rubricResults = await radarDeps.scoreBatch<RubricResult>({
      agent: "radar-rubric",
      items: rubricInput,
      rubricPrompt: RADAR_RUBRIC_PROMPT,
      schema: RubricResultSchema,
    });

    scored = survivors.flatMap((item) => {
      const rubric = rubricResults.get(item.id);
      if (!rubric) return [];
      // category music → always red, enforced in code not just prompt (doc 04 §2)
      const safeRubric =
        category.slug === "music" && rubric.rightsClass !== "red"
          ? { ...rubric, rightsClass: "red" as const, rightsNote: "music category is radar-only" }
          : rubric;
      return [
        {
          rawItemId: item.id,
          velocityScore: stats.get(item.id)?.velocityScore ?? null,
          rubric: safeRubric,
        },
      ];
    });
  }

  const clusterItems = [...scored, ...velocityOnly];
  if (clusterItems.length > 0) {
    await boss.send(Q.radarCluster, { categoryId: payload.categoryId, items: clusterItems });
  }
  log.info(
    {
      categoryId: payload.categoryId,
      batch: items.length,
      survivors: survivors.length,
      scored: scored.length,
      velocityOnly: velocityOnly.length,
    },
    "score complete",
  );
  return { scored, velocityOnly };
}

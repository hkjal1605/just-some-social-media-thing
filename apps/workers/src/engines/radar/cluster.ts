// radar.cluster (doc 04 §3): one trend per underlying story across platforms.
// Embed new items, attach at cosine ≥ 0.82 to a live trend centroid, else create a
// trend (headline via one short LLM call). Red trends are suppressed immediately.
// The maintenance tick expires trends with no snapshot growth.
import {
  EMBED_TEXT_MAX_CHARS,
  makeLogger,
  newId,
  type RightsClass,
  type RubricResult,
  type ScoredItem,
  SIMILARITY_ATTACH_THRESHOLD,
  TREND_CANDIDATE_WINDOW_HOURS,
  TREND_EXPIRE_DEFAULT_DAYS,
  TREND_EXPIRE_FLASH_HOURS,
  TrendHeadlineSchema,
  worstRights,
} from "@ve/core";
import { and, db, eq, inArray, rawItems, sql, transitionTrend, trendMembers, trends } from "@ve/db";
import { TREND_HEADLINE_SYSTEM, trendHeadlineUser } from "@ve/llm";
import { radarDeps } from "./deps";
import {
  cosineSimilarity,
  maxTransferability,
  type Transferability,
  updateCentroid,
} from "./stats";

const log = makeLogger("radar-cluster");

interface CandidateTrend {
  id: string;
  centroid: number[];
  memberCount: number;
  rightsClass: RightsClass;
}

function embedText(item: { title: string | null; text: string | null }): string {
  return `${item.title ?? ""}\n${item.text ?? ""}`.slice(0, EMBED_TEXT_MAX_CHARS).trim();
}

async function loadCandidates(categoryId: string): Promise<CandidateTrend[]> {
  const rows = await db
    .select()
    .from(trends)
    .where(
      and(
        eq(trends.categoryId, categoryId),
        eq(trends.status, "active"),
        sql`${trends.updatedAt} >= now() - make_interval(hours => ${TREND_CANDIDATE_WINDOW_HOURS})`,
      ),
    );
  const out: CandidateTrend[] = [];
  for (const t of rows) {
    if (!Array.isArray(t.centroid)) continue;
    const members = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(trendMembers)
      .where(eq(trendMembers.trendId, t.id));
    out.push({
      id: t.id,
      centroid: t.centroid as number[],
      memberCount: members[0]?.n ?? 1,
      rightsClass: t.rightsClass as RightsClass,
    });
  }
  return out;
}

async function attachToTrend(
  candidate: CandidateTrend,
  item: { id: string; embedding: number[]; velocityScore: number | null; rubric: RubricResult },
  similarity: number,
): Promise<void> {
  await db
    .insert(trendMembers)
    .values({
      trendId: candidate.id,
      rawItemId: item.id,
      similarity: similarity.toFixed(4),
    })
    .onConflictDoNothing();
  await db.update(rawItems).set({ trendId: candidate.id }).where(eq(rawItems.id, item.id));

  const [trend] = await db.select().from(trends).where(eq(trends.id, candidate.id)).limit(1);
  if (!trend) return;
  const newRights = worstRights(trend.rightsClass as RightsClass, item.rubric.rightsClass);
  const newCentroid = updateCentroid(candidate.centroid, candidate.memberCount, item.embedding);
  await db
    .update(trends)
    .set({
      centroid: newCentroid,
      llmScore: Math.max(trend.llmScore ?? 0, Math.round(item.rubric.llmScore)),
      velocityScore:
        item.velocityScore !== null
          ? Math.max(
              Number(trend.velocityScore ?? Number.NEGATIVE_INFINITY),
              item.velocityScore,
            ).toFixed(3)
          : trend.velocityScore,
      rightsClass: newRights,
      rightsNote:
        newRights !== trend.rightsClass && item.rubric.rightsNote
          ? item.rubric.rightsNote
          : trend.rightsNote,
      transferability: maxTransferability(
        trend.transferability as Transferability | null,
        item.rubric.transferability,
      ),
      updatedAt: new Date(),
    })
    .where(eq(trends.id, candidate.id));

  // rights rollup turned the trend red → suppress it (worst-of, doc 04 §3.4 + §3.5)
  if (newRights === "red" && trend.status === "active") {
    await transitionTrend(db, candidate.id, "suppressed");
  }
  candidate.centroid = newCentroid;
  candidate.memberCount += 1;
  candidate.rightsClass = newRights;
}

async function createTrend(
  categoryId: string,
  item: {
    id: string;
    title: string | null;
    text: string | null;
    platform: string;
    embedding: number[];
    velocityScore: number | null;
    rubric: RubricResult;
  },
): Promise<CandidateTrend> {
  let headline = (item.title ?? item.text ?? "untitled trend").slice(0, 140);
  let summary = item.rubric.whyViral;
  try {
    const named = await radarDeps.runStructured({
      agent: "trend-headline",
      system: TREND_HEADLINE_SYSTEM,
      user: trendHeadlineUser([
        {
          platform: item.platform,
          title: item.title,
          text: item.text,
          whyViral: item.rubric.whyViral,
        },
      ]),
      schema: TrendHeadlineSchema,
      maxTokens: 500,
    });
    headline = named.headline;
    summary = named.summary;
  } catch (err) {
    log.warn({ err, rawItemId: item.id }, "trend-headline agent failed — using item title");
  }

  const trendId = newId();
  await db.insert(trends).values({
    id: trendId,
    categoryId,
    status: "active",
    headline,
    summary,
    formatArchetype: item.rubric.formatArchetype,
    emotions: item.rubric.emotions,
    rightsClass: item.rubric.rightsClass,
    rightsNote: item.rubric.rightsNote || null,
    velocityScore: item.velocityScore !== null ? item.velocityScore.toFixed(3) : null,
    llmScore: Math.round(item.rubric.llmScore),
    transferability: item.rubric.transferability,
    centroid: item.embedding,
    longevity: item.rubric.longevity,
  });
  await db.insert(trendMembers).values({
    trendId,
    rawItemId: item.id,
    similarity: "1.0000",
  });
  await db.update(rawItems).set({ trendId }).where(eq(rawItems.id, item.id));

  // red trends → suppressed immediately after creation, kept for intelligence (doc 04 §3.5)
  if (item.rubric.rightsClass === "red") {
    await transitionTrend(db, trendId, "suppressed");
  }
  return {
    id: trendId,
    centroid: item.embedding,
    memberCount: 1,
    rightsClass: item.rubric.rightsClass,
  };
}

export async function clusterHandler(payload: {
  categoryId?: string | undefined;
  items: ScoredItem[];
  maintenance: boolean;
}): Promise<{ attached: number; created: number; expired: number }> {
  if (payload.maintenance) {
    const expired = await expireTrends();
    return { attached: 0, created: 0, expired };
  }
  const categoryId = payload.categoryId;
  if (!categoryId || payload.items.length === 0) return { attached: 0, created: 0, expired: 0 };

  const byId = new Map(payload.items.map((i) => [i.rawItemId, i]));
  const rows = await db
    .select()
    .from(rawItems)
    .where(inArray(rawItems.id, [...byId.keys()]));

  // 1 · velocity-only refresh for existing members (doc 04 §3.4)
  for (const row of rows) {
    const scored = byId.get(row.id);
    if (!scored || scored.rubric || !row.trendId || scored.velocityScore === null) continue;
    await db
      .update(trends)
      .set({
        velocityScore: sql`greatest(coalesce(${trends.velocityScore}, '-999'), ${scored.velocityScore.toFixed(3)})`,
        updatedAt: new Date(),
      })
      .where(eq(trends.id, row.trendId));
  }

  // 2 · embed new items missing a vector (doc 04 §3.1)
  const fresh = rows.filter((r) => byId.get(r.id)?.rubric && !r.trendId);
  const needEmbed = fresh.filter((r) => !Array.isArray(r.embedding));
  if (needEmbed.length > 0) {
    const vectors = await radarDeps.embed(needEmbed.map(embedText));
    for (let i = 0; i < needEmbed.length; i++) {
      const row = needEmbed[i];
      const vec = vectors[i];
      if (!row || !vec) continue;
      await db.update(rawItems).set({ embedding: vec }).where(eq(rawItems.id, row.id));
      row.embedding = vec;
    }
  }

  // 3 · attach-or-create against live candidates (newly created trends join the pool,
  //     so same-story items within one batch cluster together)
  const candidates = await loadCandidates(categoryId);
  let attached = 0;
  let created = 0;
  for (const row of fresh) {
    const scored = byId.get(row.id);
    if (!scored?.rubric || !Array.isArray(row.embedding)) continue;
    const embedding = row.embedding as number[];
    let best: { candidate: CandidateTrend; sim: number } | null = null;
    for (const c of candidates) {
      const sim = cosineSimilarity(c.centroid, embedding);
      if (!best || sim > best.sim) best = { candidate: c, sim };
    }
    if (best && best.sim >= SIMILARITY_ATTACH_THRESHOLD) {
      await attachToTrend(
        best.candidate,
        {
          id: row.id,
          embedding,
          velocityScore: scored.velocityScore,
          rubric: scored.rubric,
        },
        best.sim,
      );
      attached++;
    } else {
      const candidate = await createTrend(categoryId, {
        id: row.id,
        title: row.title,
        text: row.text,
        platform: row.platform,
        embedding,
        velocityScore: scored.velocityScore,
        rubric: scored.rubric,
      });
      // suppressed (red) trends never join the attach pool (doc 04 §3.5)
      if (candidate.rightsClass !== "red") candidates.push(candidate);
      created++;
    }
  }

  log.info({ categoryId, attached, created }, "cluster complete");
  return { attached, created, expired: 0 };
}

/** Maintenance tick (doc 04 §3.5): expire trends with no snapshot growth. */
export async function expireTrends(): Promise<number> {
  const stale = (await db.execute(sql`
    select t.id, t.status from trends t
    where t.status in ('active', 'briefed')
      and coalesce((
        select max(s.captured_at) from trend_members tm
        join item_snapshots s on s.raw_item_id = tm.raw_item_id
        where tm.trend_id = t.id
      ), t.first_detected_at) <
        case when t.longevity = 'flash'
          then now() - make_interval(hours => ${TREND_EXPIRE_FLASH_HOURS})
          else now() - make_interval(days => ${TREND_EXPIRE_DEFAULT_DAYS})
        end
  `)) as unknown as { id: string; status: string }[];

  for (const t of stale) {
    await transitionTrend(db, t.id, "expired");
  }
  if (stale.length > 0) log.info({ expired: stale.length }, "trends expired");
  return stale.length;
}

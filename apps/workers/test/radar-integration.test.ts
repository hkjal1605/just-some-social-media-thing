// Radar end-to-end against real Postgres (doc 04 §7 acceptance criteria):
// fixture connectors (zero credentials), offline LLM deps, real persistence,
// scout → score → cluster → editor → digest. Skips when PG is unreachable.
import { describe, expect, test } from "bun:test";
import {
  CADENCE_CAPS_DEFAULT,
  newId,
  type Platform,
  RadarClusterPayload,
  RadarScorePayload,
  type SourceKind,
} from "@ve/core";
import {
  and,
  briefs,
  categories,
  db,
  eq,
  getSetting,
  inArray,
  itemSnapshots,
  rawItems,
  runMigrations,
  seed,
  sources,
  sql,
  sqlClient,
  trendMembers,
  trends,
} from "@ve/db";
import type PgBoss from "pg-boss";
import { clusterHandler, expireTrends } from "../src/engines/radar/cluster";
import { setRadarDeps } from "../src/engines/radar/deps";
import { buildDigestMarkdown, digestHandler, gatherDigestData } from "../src/engines/radar/digest";
import { editorTickForCategory } from "../src/engines/radar/editor";
import { offlineRadarDeps } from "../src/engines/radar/offline";
import { scoreHandler } from "../src/engines/radar/score";
import { scoutSource, scoutTick } from "../src/engines/radar/scouts";
import { type Enqueuer, enqueueAlert } from "../src/harness";
import { alertHandler } from "../src/registrations";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("radar.integration: postgres unreachable — suite skipped");

if (reachable) {
  await runMigrations();
  await seed();
  setRadarDeps(offlineRadarDeps);
}
// no afterAll(closeDb): the pool is shared across test files in one process

const run = newId().slice(-8);

interface Sent {
  name: string;
  data: object;
  options?: PgBoss.SendOptions;
}
function stubBoss(): Enqueuer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (name, data, options) => {
      // simulate pg-boss JSON round-trip so payload schemas stay honest
      sent.push({ name, data: JSON.parse(JSON.stringify(data)), ...(options ? { options } : {}) });
      return newId();
    },
  };
}

async function makeCategory(slug: string, mode = "full_auto_candidate") {
  const id = newId();
  await db.insert(categories).values({
    id,
    slug,
    name: slug,
    mode,
    autoApproveFormats: [],
    cadenceCaps: CADENCE_CAPS_DEFAULT,
  });
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  if (!row) throw new Error("category insert failed");
  return row;
}

async function makeSource(categoryId: string, platform: Platform, kind: SourceKind, value: string) {
  const id = newId();
  await db.insert(sources).values({ id, categoryId, platform, kind, value, scoutIntervalMin: 30 });
  return id;
}

async function insertItem(categoryId: string, text: string, opts: { platform?: Platform } = {}) {
  const id = newId();
  await db.insert(rawItems).values({
    id,
    platform: opts.platform ?? "reddit",
    externalId: `t3_${run}_${id.slice(-12)}`,
    categoryId,
    url: `https://example.com/${id}`,
    title: text.slice(0, 80),
    text,
    mediaType: "text",
    publishedAt: new Date(),
  });
  return id;
}

describe("scouts (doc 04 §1)", () => {
  t("scoutSource persists fixture items for all four platforms, idempotently", async () => {
    // NOTE: fixture external ids are static — earlier suite runs may already own the
    // raw_items rows (first-seen category wins on upsert). Assert via touched ids and
    // snapshot deltas so the test is rerun-proof.
    const cat = await makeCategory(`test-scout-${run}`);
    const redditSrc = await makeSource(cat.id, "reddit", "subreddit", "r/artificial");
    const ytSrc = await makeSource(cat.id, "youtube", "yt_chart", "US");
    const xSrc = await makeSource(cat.id, "x", "x_query", "(AI) min_faves:500");
    const ttSrc = await makeSource(cat.id, "tiktok", "tiktok_hashtag", "ai");

    const boss = stubBoss();
    const touchedReddit = await scoutSource(redditSrc, boss);
    expect(touchedReddit.length).toBe(5); // hot 3 + rising 2
    const touchedAll = [
      ...touchedReddit,
      ...(await scoutSource(ytSrc, boss)),
      ...(await scoutSource(xSrc, boss)),
      ...(await scoutSource(ttSrc, boss)),
    ];
    expect(touchedAll.length).toBe(11); // 5 reddit + 2 yt + 2 x + 2 tiktok
    const rows = await db.select().from(rawItems).where(inArray(rawItems.id, touchedAll));
    expect(rows.length).toBe(11);
    expect(new Set(rows.map((r) => r.platform))).toEqual(
      new Set(["reddit", "youtube", "x", "tiktok"]),
    );

    // x cursor stored per source (doc 04 §1)
    expect(await getSetting<string>(`x_cursor:${xSrc}`)).toBe("1946000000000000002");

    // re-scout: same raw_items rows return (no duplicates), snapshots accrue (doc 04 §7)
    const snapsBefore = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(itemSnapshots)
      .where(inArray(itemSnapshots.rawItemId, touchedReddit));
    const touchedReddit2 = await scoutSource(redditSrc, boss);
    expect(new Set(touchedReddit2)).toEqual(new Set(touchedReddit)); // identical rows, not new ones
    const snapsAfter = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(itemSnapshots)
      .where(inArray(itemSnapshots.rawItemId, touchedReddit));
    expect((snapsAfter[0]?.n ?? 0) - (snapsBefore[0]?.n ?? 0)).toBe(5);

    // radar.score enqueued with the category batch + quarter-hour singleton key
    const scoreSends = boss.sent.filter((s) => s.name === "radar.score");
    expect(scoreSends.length).toBe(5);
    const first = RadarScorePayload.parse(scoreSends[0]?.data);
    expect(first.categoryId).toBe(cat.id);
    expect(scoreSends[0]?.options?.singletonKey).toStartWith(cat.id);

    // sources.last_scouted_at set → tick no longer sees them as due
    const tick = await scoutTick("reddit", stubBoss());
    const stillDue = await db
      .select()
      .from(sources)
      .where(and(eq(sources.id, redditSrc), sql`last_scouted_at is null`));
    expect(stillDue.length).toBe(0);
    expect(tick.enqueued).toBeGreaterThanOrEqual(0); // other categories' sources may be due
  });

  t("scoutTick fans out due sources with singletonKey=sourceId", async () => {
    const cat = await makeCategory(`test-tick-${run}`);
    const srcId = await makeSource(cat.id, "reddit", "subreddit", `r/tick-${run}`);
    const boss = stubBoss();
    const { enqueued } = await scoutTick("reddit", boss);
    expect(enqueued).toBeGreaterThanOrEqual(1);
    const mine = boss.sent.find((s) => (s.data as { sourceId?: string }).sourceId === srcId);
    expect(mine).toBeDefined();
    expect(mine?.options?.singletonKey).toBe(srcId);
  });
});

describe("score → cluster (doc 04 §2-§3)", () => {
  t(
    "identical-story items cluster into one trend; distinct stories separate; rollups apply",
    async () => {
      const cat = await makeCategory(`test-cluster-${run}`);
      const storyA = "open source 32b model tops swe-bench verified agents benchmark weights";
      const a1 = await insertItem(cat.id, storyA);
      const a2 = await insertItem(cat.id, storyA);
      const b1 = await insertItem(cat.id, "voice api prices dropped threefold for realtime calls");

      const boss = stubBoss();
      const result = await scoreHandler({ categoryId: cat.id, rawItemIds: [a1, a2, b1] }, boss);
      expect(result.scored.length).toBe(3); // all fresh → all survive to Layer B

      const clusterSend = boss.sent.find((s) => s.name === "radar.cluster");
      expect(clusterSend).toBeDefined();
      const payload = RadarClusterPayload.parse(clusterSend?.data);
      const outcome = await clusterHandler(payload);
      expect(outcome.created).toBe(2); // story A (2 items) + story B
      expect(outcome.attached).toBe(1); // a2 attached to a1's trend within the batch

      const catTrends = await db.select().from(trends).where(eq(trends.categoryId, cat.id));
      expect(catTrends.length).toBe(2);
      const big = catTrends.find((tr) => tr.headline.length > 0 && tr.status === "active");
      expect(big).toBeDefined();
      const members = await db
        .select()
        .from(trendMembers)
        .where(
          inArray(
            trendMembers.trendId,
            catTrends.map((tr) => tr.id),
          ),
        );
      expect(members.length).toBe(3);

      // second batch: another identical item attaches to the existing trend
      const a3 = await insertItem(cat.id, storyA);
      const boss2 = stubBoss();
      await scoreHandler({ categoryId: cat.id, rawItemIds: [a3] }, boss2);
      const p2 = RadarClusterPayload.parse(
        boss2.sent.find((s) => s.name === "radar.cluster")?.data,
      );
      const outcome2 = await clusterHandler(p2);
      expect(outcome2.attached).toBe(1);
      expect(outcome2.created).toBe(0);

      const storyTrend = catTrends
        .map((tr) => tr.id)
        .filter((id) => members.filter((m) => m.trendId === id).length === 2)[0];
      const finalMembers = await db
        .select()
        .from(trendMembers)
        .where(eq(trendMembers.trendId, storyTrend ?? ""));
      expect(finalMembers.length).toBe(3);
    },
  );

  t("red-rights items create suppressed trends (kept for intelligence)", async () => {
    const cat = await makeCategory(`test-red-${run}`);
    const item = await insertItem(cat.id, "verbatim match footage from the broadcast going viral");
    const boss = stubBoss();
    await scoreHandler({ categoryId: cat.id, rawItemIds: [item] }, boss);
    const payload = RadarClusterPayload.parse(
      boss.sent.find((s) => s.name === "radar.cluster")?.data,
    );
    await clusterHandler(payload);
    const [trend] = await db.select().from(trends).where(eq(trends.categoryId, cat.id));
    expect(trend?.status).toBe("suppressed");
    expect(trend?.rightsClass).toBe("red");
  });

  t("music category is force-red in code → every trend ends suppressed (doc 04 §7)", async () => {
    const [music] = await db.select().from(categories).where(eq(categories.slug, "music"));
    expect(music).toBeDefined();
    if (!music) return;
    const item = await insertItem(
      music.id,
      `brand new chart-topping single breaks streaming records ${run}`,
    );
    const boss = stubBoss();
    const { scored } = await scoreHandler({ categoryId: music.id, rawItemIds: [item] }, boss);
    expect(scored[0]?.rubric?.rightsClass).toBe("red"); // offline heuristic said green — code forced red
    const payload = RadarClusterPayload.parse(
      boss.sent.find((s) => s.name === "radar.cluster")?.data,
    );
    await clusterHandler(payload);
    // the pipeline-created trend for THIS item must end suppressed (rerun-proof:
    // other tests hand-insert music trends outside the pipeline)
    const [itemRow] = await db.select().from(rawItems).where(eq(rawItems.id, item));
    expect(itemRow?.trendId).toBeString();
    const [musicTrend] = await db
      .select()
      .from(trends)
      .where(eq(trends.id, itemRow?.trendId ?? ""));
    expect(musicTrend?.status).toBe("suppressed");
    expect(musicTrend?.rightsClass).toBe("red");
  });

  t("briefed-trend members stop at Layer A (no re-scoring)", async () => {
    const cat = await makeCategory(`test-briefed-${run}`);
    const item = await insertItem(cat.id, `agents rewrite their own playbooks weekly ${run}`);
    const boss = stubBoss();
    await scoreHandler({ categoryId: cat.id, rawItemIds: [item] }, boss);
    const payload = RadarClusterPayload.parse(
      boss.sent.find((s) => s.name === "radar.cluster")?.data,
    );
    await clusterHandler(payload);
    const [trend] = await db.select().from(trends).where(eq(trends.categoryId, cat.id));
    if (!trend) throw new Error("no trend created");
    await db.update(trends).set({ status: "briefed" }).where(eq(trends.id, trend.id));

    const boss2 = stubBoss();
    const res = await scoreHandler({ categoryId: cat.id, rawItemIds: [item] }, boss2);
    expect(res.scored.length).toBe(0);
    expect(res.velocityOnly.length).toBe(0); // briefed → full stop (doc 04 §2)
    expect(boss2.sent.filter((s) => s.name === "radar.cluster").length).toBe(0);
  });
});

describe("editor-in-chief (doc 04 §4)", () => {
  async function seedTrend(categoryId: string, headline: string, llmScore = 85, rights = "green") {
    const id = newId();
    await db.insert(trends).values({
      id,
      categoryId,
      status: "active",
      headline,
      summary: "s",
      rightsClass: rights,
      llmScore,
      transferability: { tiktok: 80, youtube: 70, x: 60, reddit: 50 },
      emotions: ["curiosity"],
      longevity: "days",
    });
    return id;
  }

  t(
    "briefs the top candidate, transitions trend, enqueues factory.script, respects hourly cap",
    async () => {
      const cat = await makeCategory(`test-editor-${run}`);
      await seedTrend(cat.id, `Editor trend one ${run}`, 90);
      await seedTrend(cat.id, `Editor trend two ${run}`, 85);
      await seedTrend(cat.id, `Editor trend three ${run}`, 80);

      const boss = stubBoss();
      const first = await editorTickForCategory(cat, boss);
      expect(first.briefed).toBe(1); // offline editor briefs exactly one per run
      const briefRows = await db.select().from(briefs).where(eq(briefs.categoryId, cat.id));
      expect(briefRows.length).toBe(1);
      const brief = briefRows[0];
      if (!brief) throw new Error("brief missing");
      expect(brief.formatSlug).toBe("faceless-explainer-60s");
      expect(brief.targetPlatforms).toEqual(["tiktok", "youtube"]);
      expect(brief.angle.toLowerCase()).toContain("original take");
      const [briefedTrend] = await db
        .select()
        .from(trends)
        .where(eq(trends.id, brief.trendId ?? ""));
      expect(briefedTrend?.status).toBe("briefed");
      expect(
        boss.sent.find(
          (s) =>
            s.name === "factory.script" && (s.data as { briefId?: string }).briefId === brief.id,
        ),
      ).toBeDefined();

      // hourly cap = 2 briefs/category (doc 04 §4): second run briefs, third refuses
      const second = await editorTickForCategory(cat, stubBoss());
      expect(second.briefed).toBe(1);
      const third = await editorTickForCategory(cat, stubBoss());
      expect(third.briefed).toBe(0);
      const allBriefs = await db.select().from(briefs).where(eq(briefs.categoryId, cat.id));
      expect(allBriefs.length).toBe(2);
    },
  );

  t(
    "radar_only category (music) never reaches the editor — no brief possible (doc 04 §7)",
    async () => {
      const [music] = await db.select().from(categories).where(eq(categories.slug, "music"));
      if (!music) throw new Error("music category missing");
      const seeded = await seedTrend(music.id, `Music trend that must never brief ${run}`, 99);
      const res = await editorTickForCategory(music, stubBoss());
      expect(res.briefed).toBe(0);
      const musicBriefs = await db.select().from(briefs).where(eq(briefs.categoryId, music.id));
      expect(musicBriefs.length).toBe(0);
      // tidy up so reruns of the pipeline test never see a stray active music trend
      await db.update(trends).set({ status: "suppressed" }).where(eq(trends.id, seeded));
    },
  );

  t("exhausted daily cadence blocks new briefs", async () => {
    const cat = await makeCategory(`test-cadence-${run}`);
    await db
      .update(categories)
      .set({ cadenceCaps: { tiktok: 0, youtube: 0, x: 0, reddit: 0 } })
      .where(eq(categories.id, cat.id));
    const [updated] = await db.select().from(categories).where(eq(categories.id, cat.id));
    if (!updated) throw new Error("category missing");
    await seedTrend(cat.id, `Cadence-blocked trend ${run}`, 95);
    const res = await editorTickForCategory(updated, stubBoss());
    expect(res.briefed).toBe(0);
  });
});

describe("trend expiry (doc 04 §3.5)", () => {
  t("flash expires after 48h, days after 7d of no growth; fresh stays active", async () => {
    const cat = await makeCategory(`test-expire-${run}`);
    const mk = async (longevity: string, ageDays: number) => {
      const id = newId();
      await db.insert(trends).values({
        id,
        categoryId: cat.id,
        status: "active",
        headline: `${longevity} ${ageDays}d ${run}`,
        summary: "s",
        rightsClass: "green",
        longevity,
        firstDetectedAt: new Date(Date.now() - ageDays * 24 * 3_600_000),
      });
      return id;
    };
    const flashOld = await mk("flash", 3);
    const daysOld = await mk("days", 10);
    const daysFresh = await mk("days", 1);

    await expireTrends();

    const status = new Map(
      (await db.select().from(trends).where(eq(trends.categoryId, cat.id))).map((tr) => [
        tr.id,
        tr.status,
      ]),
    );
    expect(status.get(flashOld)).toBe("expired");
    expect(status.get(daysOld)).toBe("expired");
    expect(status.get(daysFresh)).toBe("active");
  });
});

describe("digest (doc 04 §5)", () => {
  t(
    "gathers real data and sends (telegram no-ops without token), stores last_digest_at",
    async () => {
      const data = await gatherDigestData();
      const md = buildDigestMarkdown(data);
      expect(md).toContain("Radar digest");
      expect(md).toContain("Pending approvals");

      const sent = await digestHandler();
      expect(sent).toContain("Radar digest");
      expect(await getSetting<string>("last_digest_at")).toBeString();
    },
  );
});

describe("ops alerts (doc 08 §9)", () => {
  t("enqueueAlert sends to alert.telegram; alertHandler dedupes within the hour", async () => {
    const boss = stubBoss();
    await enqueueAlert(boss, "🔥 test alert", `test-${run}`);
    expect(boss.sent[0]?.name).toBe("alert.telegram");

    const key = `dedupe-${run}`;
    await alertHandler({ text: "first", key });
    const stamp1 = await getSetting<string>(`alert_sent:${key}`);
    expect(stamp1).toBeString();
    await alertHandler({ text: "second (deduped)", key });
    const stamp2 = await getSetting<string>(`alert_sent:${key}`);
    expect(stamp2).toBe(stamp1); // second send skipped
  });
});

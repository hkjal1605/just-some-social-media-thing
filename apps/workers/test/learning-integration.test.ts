// Learning integration (doc 07 §6 acceptance) against real Postgres + in-memory R2.
// Seeds 60 fixture posts with synthetic snapshot curves, then asserts: deterministic tables
// match hand-computed medians; the analyst kills a format 3 weeks under median; playbook v2
// draft appears with a real diff; approving it makes the editor read v2; the killed format
// stops being chosen. Plus the metrics monotonic guard + missing-analytics retry.
import { describe, expect, test } from "bun:test";
import { type EditorDecision, KILL_LIST_SETTING_KEY, type KillList, newId } from "@ve/core";
import {
  and,
  briefs,
  categories,
  db,
  eq,
  getSetting,
  playbookVersions,
  postSnapshots,
  posts,
  seed,
  sqlClient,
  trends,
} from "@ve/db";
import { getObjectBytes } from "@ve/storage";
import {
  attributionHandler,
  buildFeatureRows,
  computeTables,
} from "../src/engines/learning/attribution";
import { setLearningDeps } from "../src/engines/learning/deps";
import { snapshotOne } from "../src/engines/learning/metrics";
import { offlineLearningDeps } from "../src/engines/learning/offline";
import { playbookUpdateHandler } from "../src/engines/learning/playbook";
import { setRadarDeps } from "../src/engines/radar/deps";
import { editorTickForCategory } from "../src/engines/radar/editor";
import { offlineRadarDeps } from "../src/engines/radar/offline";
import type { Enqueuer } from "../src/harness";
import { need } from "./helpers";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("learning.integration: postgres unavailable — suite skipped");
if (reachable) {
  await seed();
  setLearningDeps(offlineLearningDeps());
  setRadarDeps(offlineRadarDeps);
}

const run = newId().slice(-8);
const GOOD = "faceless-explainer-60s";
const BAD = "demo-screencast";
const V1_MARKER = "V1-BASELINE-PLAYBOOK";

interface Sent {
  name: string;
  data: Record<string, unknown>;
}
function stubBoss(): Enqueuer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (name, data) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      return newId();
    },
  };
}

// shared seed
let categoryId = "";
let categorySlug = "";
let reportKey = "";

async function seedFixtures() {
  categoryId = newId();
  categorySlug = `learn-${run}`;
  await db.insert(categories).values({
    id: categoryId,
    slug: categorySlug,
    name: categorySlug,
    mode: "full_auto_candidate",
    autoApproveFormats: [BAD], // earned auto-approve that the kill list must revoke
    cadenceCaps: { tiktok: 5, youtube: 5, x: 5, reddit: 5 },
    active: true,
  });
  // one brief per format; 30 posts each across weeksAgo 1,2,3 (all matured ≥7d, ≤8w)
  const now = Date.now();
  for (const [format, views] of [
    [GOOD, 300],
    [BAD, 100],
  ] as const) {
    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      categoryId,
      originKind: "trend",
      status: "ready",
      angle: `${format} angle`,
      formatSlug: format,
      targetPlatforms: ["tiktok"],
      // backdate beyond the 1h brief cap window so the editor test isn't rate-limited
      createdAt: new Date(now - 2 * 3_600_000),
    });
    for (const w of [1, 2, 3]) {
      for (let i = 0; i < 10; i++) {
        const publishedAt = new Date(now - (w * 7 + 2) * 86_400_000);
        const postId = newId();
        await db.insert(posts).values({
          id: postId,
          briefId,
          categoryId,
          platform: "tiktok",
          status: "published",
          publishedAt,
          ayrsharePostId: `ayr_${postId.slice(-8)}`,
        });
        // one snapshot at publish + 7d carrying the deterministic views7d
        await db.insert(postSnapshots).values({
          id: newId(),
          postId,
          capturedAt: new Date(publishedAt.getTime() + 7 * 86_400_000),
          views,
          likes: Math.round(views * 0.1),
          comments: Math.round(views * 0.02),
          shares: Math.round(views * 0.01),
        });
      }
    }
  }
  // an approved v1 playbook so the update produces v2 (with a visible diff)
  await db.insert(playbookVersions).values({
    id: newId(),
    categoryId,
    version: 1,
    markdown: `# Voice\n${V1_MARKER}\n# Hooks that work\n- start strong\n# Formats\n# Timing\n# Hashtags/keywords\n# Kill list\n_None._\n# Experiments running`,
    createdBy: "human",
    approvedAt: new Date(),
  });
}

if (reachable) await seedFixtures();

describe("attribution (doc 07 §2/§6)", () => {
  t("deterministic tables match hand-computed medians for the seeded category", async () => {
    const rows = (await buildFeatureRows(new Date())).filter(
      (r) => r.categorySlug === categorySlug,
    );
    expect(rows.length).toBe(60);
    const tables = computeTables(rows);
    const mine = need(tables.find((x) => x.categorySlug === categorySlug));
    expect(mine.postCount).toBe(60);
    const formatBuckets =
      (
        mine.bucketMedians as Record<
          string,
          { bucket: string; median: number | null; insufficient: boolean }[]
        >
      ).formatSlug ?? [];
    expect(formatBuckets.find((b) => b.bucket === GOOD)?.median).toBe(300);
    expect(formatBuckets.find((b) => b.bucket === BAD)?.median).toBe(100);
    expect(formatBuckets.find((b) => b.bucket === GOOD)?.insufficient).toBe(false); // n=30
    // the bad format is below the weekly category median for all 3 weeks
    expect((mine.formatsUnderMedianWeeks as Record<string, number>)[BAD]).toBe(3);
    expect((mine.formatsUnderMedianWeeks as Record<string, number>)[GOOD]).toBe(0);
  });

  t("learn.attribute writes the report to R2 and kills the chronic underperformer", async () => {
    const boss = stubBoss();
    const { report, reportKey: key } = await attributionHandler({}, boss);
    reportKey = key;
    // markdown + structured json both persisted (doc 07 §2)
    expect((await getObjectBytes(key)).byteLength).toBeGreaterThan(10);
    expect((await getObjectBytes(key.replace(/\.md$/, ".json"))).byteLength).toBeGreaterThan(10);
    // kill list contains our bad format for our category
    expect(
      report.killList.some((k) => k.categorySlug === categorySlug && k.formatSlug === BAD),
    ).toBe(true);
    // and it enqueued the playbook update
    expect(boss.sent.some((s) => s.name === "playbook.update")).toBe(true);
  });
});

describe("playbook update (doc 07 §3/§6)", () => {
  t("creates a v2 draft with a diff, writes the kill list, revokes auto-approve", async () => {
    const boss = stubBoss();
    const res = await playbookUpdateHandler({ attributionReportKey: reportKey }, boss);
    expect(res.drafts).toBeGreaterThanOrEqual(1);
    expect(res.killed).toBeGreaterThanOrEqual(1);

    const versions = await db
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.categoryId, categoryId))
      .orderBy(playbookVersions.version);
    const v2 = versions.find((v) => v.version === 2);
    expect(v2).toBeTruthy();
    expect(v2?.approvedAt).toBeNull(); // draft — human approves
    expect(v2?.markdown).toContain(BAD); // kill folded in (visible diff vs v1)
    expect(v2?.markdown).not.toBe(versions.find((v) => v.version === 1)?.markdown);

    // kill_list setting written + auto-approve revoked (doc 07 §3)
    const killList = (await getSetting<KillList>(KILL_LIST_SETTING_KEY)) ?? {};
    expect(Object.keys(killList[categorySlug] ?? {})).toContain(BAD);
    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
    expect(((cat?.autoApproveFormats ?? []) as string[]).includes(BAD)).toBe(false);
    expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(true);
  });
});

describe("editor reads approved v2 + kill list enforced (doc 07 §6)", () => {
  t("approving v2 makes editor read it; the killed format is never chosen", async () => {
    // approve exactly v2 → the editor must now read it (doc 07 §3)
    await db
      .update(playbookVersions)
      .set({ approvedAt: new Date() })
      .where(and(eq(playbookVersions.categoryId, categoryId), eq(playbookVersions.version, 2)));

    // two active candidate trends: editor picks BAD (killed) for one, GOOD for the other
    const trendBad = newId();
    const trendGood = newId();
    for (const [id, hl] of [
      [trendBad, "bad-format trend"],
      [trendGood, "good-format trend"],
    ] as const) {
      await db.insert(trends).values({
        id,
        categoryId,
        status: "active",
        headline: hl,
        summary: "summary",
        rightsClass: "green",
        llmScore: 90,
        emotions: [],
      });
    }

    // capture the playbook markdown the editor feeds the agent, and force the decisions
    let capturedUser = "";
    setRadarDeps({
      runStructured: (async <T>(opts: {
        user: string;
        schema: { parse: (v: unknown) => T };
      }): Promise<T> => {
        capturedUser = opts.user;
        const decision: EditorDecision = {
          decisions: [
            {
              trendId: trendBad,
              act: "brief",
              reason: "r",
              formatSlug: BAD,
              targetPlatforms: ["tiktok"],
              angle: "a1",
            },
            {
              trendId: trendGood,
              act: "brief",
              reason: "r",
              formatSlug: GOOD,
              targetPlatforms: ["tiktok"],
              angle: "a2",
            },
          ],
        };
        return opts.schema.parse(decision);
      }) as never,
    });

    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
    const boss = stubBoss();
    const res = await editorTickForCategory(need(cat), boss);
    // editor read the APPROVED v2: the kill fold is only in v2's playbook markdown, never v1's
    expect(capturedUser).toContain("consecutive weeks below category median");
    // only the GOOD-format trend was briefed; the killed format was skipped (doc 07 §3)
    expect(res.briefed).toBe(1);
    const briefRows = await db.select().from(briefs).where(eq(briefs.trendId, trendGood));
    expect(briefRows[0]?.formatSlug).toBe(GOOD);
    const killedBriefs = await db.select().from(briefs).where(eq(briefs.trendId, trendBad));
    expect(killedBriefs.length).toBe(0);

    setRadarDeps(offlineRadarDeps); // restore
  });
});

describe("metrics.snapshot guards (doc 07 §1)", () => {
  t("monotonic anomaly flag + missing-analytics retry counter", async () => {
    // a published post to snapshot
    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      categoryId,
      originKind: "trend",
      status: "ready",
      angle: "a",
      formatSlug: GOOD,
      targetPlatforms: ["tiktok"],
    });
    const postId = newId();
    await db.insert(posts).values({
      id: postId,
      briefId,
      categoryId,
      platform: "tiktok",
      status: "published",
      publishedAt: new Date(),
      ayrsharePostId: `ayr_guard_${run}`,
    });

    // first snapshot: 5000 views; second call returns a >5% drop → kept + flagged
    let call = 0;
    setLearningDeps(
      offlineLearningDeps({
        getPostAnalytics: async (id) => ({
          views: call++ === 0 ? 5000 : 4000,
          likes: 10,
          comments: 1,
          shares: 0,
          watchTimeSec: 100,
          avgViewDurationSec: 12,
          raw: { id },
        }),
      }),
    );
    const [post] = await db.select().from(posts).where(eq(posts.id, postId));
    await snapshotOne(need(post), stubBoss());
    await snapshotOne(need(post), stubBoss());
    const snaps = await db
      .select()
      .from(postSnapshots)
      .where(eq(postSnapshots.postId, postId))
      .orderBy(postSnapshots.capturedAt);
    expect(snaps.length).toBe(2);
    expect(((snaps[1]?.raw ?? {}) as { _anomaly?: boolean })._anomaly).toBe(true);

    // missing analytics → no row written, miss counter increments
    setLearningDeps(
      offlineLearningDeps({
        getPostAnalytics: async (id) => ({
          views: null,
          likes: null,
          comments: null,
          shares: null,
          watchTimeSec: null,
          avgViewDurationSec: null,
          raw: { id },
        }),
      }),
    );
    const missPostId = newId();
    await db.insert(posts).values({
      id: missPostId,
      briefId,
      categoryId,
      platform: "tiktok",
      status: "published",
      publishedAt: new Date(),
      ayrsharePostId: `ayr_miss_${run}`,
    });
    const [missPost] = await db.select().from(posts).where(eq(posts.id, missPostId));
    const r = await snapshotOne(need(missPost), stubBoss());
    expect(r.written).toBe(false);
    expect(r.missing).toBe(true);
    expect(await getSetting<number>(`snapshot_miss:${missPostId}`)).toBe(1);

    setLearningDeps(offlineLearningDeps()); // restore
  });
});

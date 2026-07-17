// Learning pure-logic unit tests (doc 07 §1/§2/§3/§5) — hand-computed, no DB, no network.
import { describe, expect, test } from "bun:test";
import {
  computeCategoryTables,
  type FeatureRow,
  formatsUnderMedianWeeks,
} from "../src/engines/learning/attribution";
import { buildWeeklyDigestMarkdown } from "../src/engines/learning/digest";
import {
  monotonicViews,
  pickSweepPosts,
  type SweepCandidate,
} from "../src/engines/learning/metrics";
import { offlineApplyPlaybook } from "../src/engines/learning/offline";
import {
  averageRanks,
  bucketize,
  extremeItems,
  leadingTrue,
  mean,
  median,
  round,
  spearman,
  weeksAgo,
} from "../src/engines/learning/stats";
import { mergeThreshold } from "../src/engines/learning/threshold";
import { killedFormatsFor } from "../src/engines/radar/editor";

describe("stats (doc 07 §2) — hand-computed", () => {
  test("median", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  test("mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBeNull();
  });

  test("averageRanks assigns tied values their mean rank", () => {
    expect(averageRanks([10, 10, 20])).toEqual([1.5, 1.5, 3]);
    expect(averageRanks([5, 1, 3])).toEqual([3, 1, 2]);
  });

  test("spearman: perfect monotone = ±1, and a known 0.8 case", () => {
    expect(
      spearman([
        [1, 10],
        [2, 20],
        [3, 30],
      ]),
    ).toBe(1);
    expect(
      spearman([
        [1, 30],
        [2, 20],
        [3, 10],
      ]),
    ).toBe(-1);
    // ranks x=[1,2,3,4], y=[1,3,2,4] → 1 - 6·2/(4·15) = 0.8
    expect(
      round(
        spearman([
          [1, 1],
          [2, 3],
          [3, 2],
          [4, 4],
        ]),
      ),
    ).toBe(0.8);
    expect(spearman([[1, 1]])).toBeNull(); // n<3
  });

  test("bucketize groups + medians + flags small buckets", () => {
    const items = [
      { g: "a", v: 10 },
      { g: "a", v: 20 },
      { g: "b", v: 100 },
    ];
    const buckets = bucketize(
      items,
      (i) => i.g,
      (i) => i.v,
      5,
    );
    expect(buckets.find((b) => b.bucket === "a")?.median).toBe(15);
    expect(buckets.find((b) => b.bucket === "b")?.median).toBe(100);
    expect(buckets.every((b) => b.insufficient)).toBe(true); // all n<5
  });

  test("extremeItems returns top/bottom decile", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, v: i }));
    const { top, bottom } = extremeItems(items, (i) => i.v, 0.1);
    expect(top[0]?.id).toBe(9);
    expect(bottom[0]?.id).toBe(0);
  });

  test("weeksAgo + leadingTrue", () => {
    const now = new Date("2026-07-14T00:00:00Z");
    expect(weeksAgo(new Date("2026-07-13T00:00:00Z"), now)).toBe(0);
    expect(weeksAgo(new Date("2026-07-01T00:00:00Z"), now)).toBe(1);
    expect(leadingTrue([true, true, false, true])).toBe(2);
    expect(leadingTrue([false, true])).toBe(0);
  });
});

// ── feature tables + kill-list flagging (doc 07 §2/§3) ──
function fr(over: Partial<FeatureRow>): FeatureRow {
  return {
    postId: "p",
    categorySlug: "ai-tech",
    platform: "tiktok",
    formatSlug: "faceless-explainer-60s",
    hookVariantChosen: "a",
    hookTextLength: null,
    estDurationSec: null,
    actualDurationSec: null,
    sceneCount: null,
    emotions: [],
    formatArchetype: null,
    publishHourLocal: 20,
    publishDow: 2,
    timeFromTrendDetectionToPublishMin: null,
    aiDisclosure: false,
    trendLlmScore: null,
    trendVelocityScore: null,
    views24h: null,
    views7d: null,
    engagementRate7d: null,
    avgViewDurationSec: null,
    publishedAt: new Date("2026-07-13T00:00:00Z"),
    weeksAgo: 0,
    ...over,
  };
}

describe("computeCategoryTables + kill list (doc 07 §2/§3)", () => {
  // format A is always below the category's weekly median, B always above, 3 weeks running
  const rows: FeatureRow[] = [];
  for (const w of [0, 1, 2]) {
    rows.push(fr({ postId: `a${w}`, formatSlug: "A", views7d: 100 + w * 10, weeksAgo: w }));
    rows.push(fr({ postId: `b${w}`, formatSlug: "B", views7d: 300 + w * 10, weeksAgo: w }));
  }

  test("formatsUnderMedianWeeks flags the chronic underperformer", () => {
    const under = formatsUnderMedianWeeks(rows);
    expect(under.A).toBe(3);
    expect(under.B).toBe(0);
  });

  test("bucket medians by format match hand-computed", () => {
    const tables = computeCategoryTables("ai-tech", rows);
    const byFormat = tables.bucketMedians as Record<
      string,
      { bucket: string; median: number | null }[]
    >;
    const formatBuckets = byFormat.formatSlug ?? [];
    expect(formatBuckets.find((b) => b.bucket === "A")?.median).toBe(110); // median(100,110,120)
    expect(formatBuckets.find((b) => b.bucket === "B")?.median).toBe(310);
    expect(tables.postCount).toBe(6);
  });

  test("numeric correlation: trendLlmScore rank-correlates with views", () => {
    const scored = rows.map((r, i) => fr({ ...r, trendLlmScore: (r.views7d ?? 0) + i }));
    const tables = computeCategoryTables("ai-tech", scored);
    const corr = tables.numericCorrelations as Record<string, number | null>;
    expect(corr.trendLlmScore).toBeGreaterThan(0.9); // monotone with views7d
  });
});

describe("metrics cadence + monotonic guard (doc 07 §1)", () => {
  const now = new Date("2026-07-14T00:00:00Z");
  const cand = (over: Partial<SweepCandidate>): SweepCandidate => ({
    postId: "p",
    publishedAt: now,
    lastSnapshotAt: null,
    ...over,
  });

  test("pickSweepPosts cadence: daily ≤30d, weekly 30–90d, stop >90d, 2h dedupe", () => {
    const d = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const picked = pickSweepPosts(
      [
        cand({ postId: "fresh", publishedAt: d(5), lastSnapshotAt: null }), // daily → in
        cand({
          postId: "justsnapped",
          publishedAt: d(5),
          lastSnapshotAt: new Date(now.getTime() - 3_600_000),
        }), // <2h → out
        cand({ postId: "weekly-due", publishedAt: d(45), lastSnapshotAt: d(10) }), // weekly, >7d → in
        cand({ postId: "weekly-recent", publishedAt: d(45), lastSnapshotAt: d(2) }), // weekly, <7d → out
        cand({ postId: "old", publishedAt: d(100), lastSnapshotAt: null }), // >90d → out
      ],
      now,
    );
    expect(new Set(picked)).toEqual(new Set(["fresh", "weekly-due"]));
  });

  test("monotonicViews keeps values non-decreasing and flags >5% drops", () => {
    expect(monotonicViews(100, 120)).toEqual({ views: 120, anomaly: false });
    expect(monotonicViews(100, 90)).toEqual({ views: 90, anomaly: true }); // >5% drop
    expect(monotonicViews(100, 98)).toEqual({ views: 98, anomaly: false }); // within tolerance
    expect(monotonicViews(null, 50)).toEqual({ views: 50, anomaly: false });
    expect(monotonicViews(100, null)).toEqual({ views: 100, anomaly: false });
  });
});

describe("threshold merge (doc 07 §5)", () => {
  test("auto-fills view metrics but preserves manually-entered fields", () => {
    const merged = mergeThreshold(
      { tiktok: { followers: 5000 }, youtube: { subs: 200 }, x: { verifiedFollowers: 10 } },
      { tiktokViews30d: 120_000, youtubeShortsViews90d: 900_000, xImpressions3mo: 2_000_000 },
      "2026-07-14T00:00:00Z",
    );
    expect(merged.tiktok?.followers).toBe(5000); // manual preserved
    expect(merged.tiktok?.views30d).toBe(120_000); // auto filled
    expect(merged.youtube?.subs).toBe(200);
    expect(merged.x?.impressions3mo).toBe(2_000_000);
    expect(merged.updatedAt).toBe("2026-07-14T00:00:00Z");
  });
});

describe("weekly digest markdown (doc 07 §4)", () => {
  test("renders headline, spend/budget, revenue, thresholds, drafts", () => {
    const md = buildWeeklyDigestMarkdown({
      headline: "Big week for explainers",
      wins: [{ finding: "hooks under 60 chars win", evidence: "n=40", confidence: "strong" }],
      losses: [{ finding: "screencasts flat", evidence: "n=10" }],
      spendMtd: 45.5,
      budget: 150,
      revenueMtd: 12.25,
      thresholds: { tiktok: { followers: 5000, views30d: 50_000 } },
      pendingPlaybookDrafts: 2,
      autoApproveCandidates: [
        { categorySlug: "ai-tech", formatSlug: "faceless-explainer-60s", streak: 12 },
      ],
      dashboardUrl: "https://dash",
    });
    expect(md).toContain("Big week for explainers");
    expect(md).toContain("$45.50 / $150 (30%)");
    expect(md).toContain("Revenue MTD:* $12.25");
    expect(md).toContain("tiktok views30d: 50%"); // 50k / 100k gate
    expect(md).toContain("awaiting approval:* 2");
    expect(md).toContain("Auto-approve candidates"); // doc 09 §5 proposal surfaced
    expect(md).toContain("ai-tech · faceless-explainer-60s");
  });
});

describe("offline playbook editor + kill list read (doc 07 §3)", () => {
  test("offlineApplyPlaybook folds edits + kills into the right sections", () => {
    const current = ["# Hooks that work", "- open on a number", "# Kill list", "_None._"].join(
      "\n",
    );
    const out = offlineApplyPlaybook({
      currentMarkdown: current,
      edits: [{ section: "Hooks that work", edit: "lead with a stat" }],
      killList: [{ formatSlug: "demo-screencast", reason: "3 weeks under median" }],
    });
    expect(out.markdown).toContain("lead with a stat");
    expect(out.markdown).toContain("demo-screencast — 3 weeks under median");
    expect(out.markdown).toContain("# Hooks that work");
  });

  test("killedFormatsFor reads the settings kill list for a category", () => {
    const killed = killedFormatsFor(
      { "ai-tech": { "x-thread": { reason: "meh", addedAt: "2026-07-14" } } },
      "ai-tech",
    );
    expect(killed.has("x-thread")).toBe(true);
    expect(killedFormatsFor(null, "ai-tech").size).toBe(0);
  });
});

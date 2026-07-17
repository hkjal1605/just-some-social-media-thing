import { describe, expect, test } from "bun:test";
import { newId, worstRights } from "@ve/core";
import { buildDigestMarkdown, type DigestData } from "../src/engines/radar/digest";
import { enforceAmberFormat, resolveTargetPlatforms } from "../src/engines/radar/editor";
import { offlineEmbed, offlineRubricFor } from "../src/engines/radar/offline";
import { cosineSimilarity } from "../src/engines/radar/stats";
import { queueBlockedByKillSwitch } from "../src/harness";

describe("kill-switch queue gate (doc 08 §6)", () => {
  test("blocks publish/factory/engage.reply/approval.request", () => {
    expect(queueBlockedByKillSwitch("publish.execute")).toBe(true);
    expect(queueBlockedByKillSwitch("factory.brief")).toBe(true);
    expect(queueBlockedByKillSwitch("engage.reply")).toBe(true);
    expect(queueBlockedByKillSwitch("approval.request")).toBe(true);
  });
  test("radar + metrics keep running — eyes stay open", () => {
    expect(queueBlockedByKillSwitch("scout.reddit")).toBe(false);
    expect(queueBlockedByKillSwitch("radar.score")).toBe(false);
    expect(queueBlockedByKillSwitch("radar.cluster")).toBe(false);
    expect(queueBlockedByKillSwitch("metrics.snapshot")).toBe(false);
    expect(queueBlockedByKillSwitch("alert.telegram")).toBe(false);
    expect(queueBlockedByKillSwitch("engage.scan")).toBe(false);
  });
});

describe("rights rollup (doc 04 §3.4)", () => {
  test("red beats amber beats green", () => {
    expect(worstRights("green", "amber")).toBe("amber");
    expect(worstRights("amber", "red")).toBe("red");
    expect(worstRights("green", "green")).toBe("green");
    expect(worstRights("red", "green")).toBe("red");
  });
});

describe("editor code rails (doc 04 §4)", () => {
  const decision = {
    trendId: newId(),
    act: "brief" as const,
    reason: "test",
    formatSlug: "clip-vertical" as const,
    targetPlatforms: ["tiktok" as const, "x" as const],
    angle: "test angle",
  };

  test("amber forces commentary formats", () => {
    expect(enforceAmberFormat(decision, "amber").formatSlug).toBe("faceless-explainer-60s");
    expect(enforceAmberFormat(decision, "green").formatSlug).toBe("clip-vertical");
    expect(enforceAmberFormat({ ...decision, formatSlug: "x-thread" }, "amber").formatSlug).toBe(
      "x-thread",
    ); // already commentary-class
  });

  test("target platforms intersect format platforms and remaining slots", () => {
    const slots = { tiktok: 1, youtube: 1, x: 0, reddit: 1 };
    // clip-vertical supports tiktok/youtube/x; x has 0 slots → only tiktok survives
    expect(resolveTargetPlatforms(decision, slots)).toEqual(["tiktok"]);
    // empty wanted list defaults to the format's platforms with slots
    expect(resolveTargetPlatforms({ ...decision, targetPlatforms: [] }, slots)).toEqual([
      "tiktok",
      "youtube",
    ]);
    // reddit not in clip-vertical's platforms → dropped even with slots
    expect(resolveTargetPlatforms({ ...decision, targetPlatforms: ["reddit"] }, slots)).toEqual([]);
  });
});

describe("offline deps (test/demo determinism)", () => {
  test("similar texts embed close, different far", async () => {
    const [a, b, c] = await offlineEmbed([
      "open source model beats frontier benchmark agents",
      "open source model beats frontier benchmark tools",
      "premier league transfer window gossip round-up",
    ]);
    expect(cosineSimilarity(a as number[], b as number[])).toBeGreaterThan(0.82);
    expect(cosineSimilarity(a as number[], c as number[])).toBeLessThan(0.5);
  });
  test("rubric heuristics: rights classes + score range", () => {
    expect(offlineRubricFor("verbatim match footage from the broadcast").rightsClass).toBe("red");
    expect(offlineRubricFor("a striking quote from the CEO").rightsClass).toBe("amber");
    const green = offlineRubricFor("new open-source model released with big benchmarks");
    expect(green.rightsClass).toBe("green");
    expect(green.llmScore).toBeGreaterThanOrEqual(70);
    expect(green.llmScore).toBeLessThanOrEqual(90);
  });
});

describe("digest markdown (doc 04 §5)", () => {
  const data: DigestData = {
    generatedAt: new Date("2026-07-12T14:30:00Z"),
    categories: [
      {
        slug: "ai-tech",
        trends: [
          {
            id: "t1",
            categoryId: "c1",
            categorySlug: "ai-tech",
            status: "active",
            headline: "OSS 32B tops SWE-bench",
            summary: "s",
            rightsClass: "green",
            velocityScore: "3.100",
            llmScore: 88,
            longevity: "days",
            formatArchetype: "news",
            firstDetectedAt: new Date(),
            memberCount: 3,
            totalViews: 120000,
            topUrls: ["https://reddit.com/x", "https://x.com/y"],
          },
        ],
      },
      { slug: "music", trends: [] },
    ],
    briefsSinceLast: [
      { angle: "Why this matters", categorySlug: "ai-tech", formatSlug: "x-thread" },
    ],
    pendingApprovals: 2,
    postsYesterday: { published: 1, topViews: 5400 },
  };

  test("contains chips, scores, links, briefs and counters", () => {
    const md = buildDigestMarkdown(data);
    expect(md).toContain("📡 Radar digest");
    expect(md).toContain("*ai-tech*");
    expect(md).toContain("🟢 *88* · v3.1 OSS 32B tops SWE-bench".replace(" · ", " ").slice(0, 8)); // chip+score present
    expect(md).toContain("OSS 32B tops SWE-bench");
    expect(md).toContain("https://reddit.com/x");
    expect(md).toContain("*Briefs since last digest:* 1");
    expect(md).toContain("[ai-tech] x-thread — Why this matters");
    expect(md).toContain("*Pending approvals:* 2");
    expect(md).toContain("1 posts published · top 5400 views");
  });

  test("empty radar renders the empty state", () => {
    const md = buildDigestMarkdown({
      ...data,
      categories: [{ slug: "ai-tech", trends: [] }],
      briefsSinceLast: [],
      postsYesterday: { published: 0, topViews: null },
    });
    expect(md).toContain("No live trends yet");
    expect(md).toContain("*Briefs since last digest:* 0");
  });
});

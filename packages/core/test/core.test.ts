import { describe, expect, test } from "bun:test";
import {
  ALL_QUEUES,
  AlertTelegramPayload,
  CategoriesCadenceCapsSchema,
  EditorDecisionSchema,
  FactoryCompliancePayload,
  FORMATS,
  FormatSlugSchema,
  istHourToUtc,
  newId,
  PLATFORM,
  PlatformSchema,
  Q,
  QueuePayloadSchemas,
  RadarScorePayload,
  ScoutPayload,
  toDisplay,
} from "../src";

describe("enums", () => {
  test("platform schema accepts registry values and rejects junk", () => {
    for (const p of PLATFORM) expect(PlatformSchema.parse(p)).toBe(p);
    expect(() => PlatformSchema.parse("instagram")).toThrow();
  });
});

describe("ids", () => {
  test("newId returns uuidv7, time-ordered", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true); // uuidv7 is lexicographically time-sortable
  });
});

describe("queues", () => {
  test("all 30 registry queues have a payload schema", () => {
    expect(ALL_QUEUES).toHaveLength(32);
    for (const q of ALL_QUEUES) expect(QueuePayloadSchemas[q]).toBeDefined();
  });

  test("payload schemas validate", () => {
    const id = newId();
    expect(ScoutPayload.parse({ sourceId: id }).sourceId).toBe(id);
    // {} is the scout cron tick (doc 04 §1); junk ids still refuse
    expect(ScoutPayload.parse({}).sourceId).toBeUndefined();
    expect(() => ScoutPayload.parse({ sourceId: "not-a-uuid" })).toThrow();
    expect(RadarScorePayload.parse({ categoryId: id, rawItemIds: [id] }).rawItemIds).toHaveLength(
      1,
    );
    expect(FactoryCompliancePayload.parse({ briefId: id, stage: "pre_render" }).stage).toBe(
      "pre_render",
    );
    expect(() => FactoryCompliancePayload.parse({ briefId: id, stage: "post_render" })).toThrow();
    expect(AlertTelegramPayload.parse({ text: "boom" }).text).toBe("boom");
  });

  test("queue names match the doc 00 §5.1 dotted convention", () => {
    for (const q of ALL_QUEUES) expect(q).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    expect(Q.publishExecute).toBe("publish.execute");
  });
});

describe("formats", () => {
  test("registry entries are platform-consistent", () => {
    for (const [slug, spec] of Object.entries(FORMATS) as [
      keyof typeof FORMATS,
      (typeof FORMATS)[keyof typeof FORMATS],
    ][]) {
      expect(FormatSlugSchema.parse(slug)).toBe(slug);
      expect(spec.platforms.length).toBeGreaterThan(0);
      if (spec.render === "text-only") expect(spec.durationSec).toBeNull();
      else expect(spec.durationSec).not.toBeNull();
    }
    // TikTok Rewards needs >60s — the faceless explainer floor must be ≥61
    expect(FORMATS["faceless-explainer-60s"].durationSec[0]).toBeGreaterThanOrEqual(61);
  });
});

describe("time", () => {
  test("istHourToUtc maps IST wall-clock to UTC", () => {
    expect(istHourToUtc(5.5)).toBe(0);
    expect(istHourToUtc(0)).toBe(18.5);
    expect(istHourToUtc(19)).toBe(13.5);
  });

  test("toDisplay renders in IST", () => {
    // 2026-07-12T00:00Z = 05:30 IST
    const s = toDisplay(new Date("2026-07-12T00:00:00Z"));
    expect(s).toContain("2026");
    expect(s.toLowerCase()).toContain("5:30");
  });
});

describe("editor decision schema (doc 04 §4)", () => {
  test("brief: over-long reason/angle are TRUNCATED, not rejected", () => {
    const parsed = EditorDecisionSchema.parse({
      decisions: [
        {
          trendId: "t1",
          act: "brief",
          reason: "x".repeat(500),
          formatSlug: "faceless-explainer-60s",
          targetPlatforms: ["tiktok", "youtube"],
          angle: "y".repeat(800),
        },
      ],
    });
    const d = parsed.decisions[0];
    if (d?.act !== "brief") throw new Error("expected a brief decision");
    expect(d.reason.length).toBe(200);
    expect(d.angle.length).toBe(300);
    expect(d.targetPlatforms).toEqual(["tiktok", "youtube"]);
  });

  test("skip: needs only trendId/act/reason — formatSlug/targetPlatforms/angle may be omitted", () => {
    // this is the fix for the editor's structured-output retry loop: the model routinely omits the
    // brief-only fields on a skip, and that must validate instead of failing the whole batch.
    const parsed = EditorDecisionSchema.parse({
      decisions: [{ trendId: "t", act: "skip", reason: "too short a window to clip" }],
    });
    const d = parsed.decisions[0];
    expect(d?.act).toBe("skip");
    expect(d?.reason).toBe("too short a window to clip");
  });
});

describe("jsonb schemas", () => {
  test("cadence caps schema", () => {
    expect(CategoriesCadenceCapsSchema.parse({ tiktok: 2, youtube: 1, x: 5, reddit: 1 }).x).toBe(5);
    expect(() =>
      CategoriesCadenceCapsSchema.parse({ tiktok: -1, youtube: 1, x: 5, reddit: 1 }),
    ).toThrow();
  });
});

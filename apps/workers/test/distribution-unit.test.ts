// Distribution pure-logic unit tests (doc 06 §4/§7 rails, §2 payloads) — no DB, no network.
import { describe, expect, test } from "bun:test";
import {
  istParts,
  MIN_SAME_PLATFORM_GAP_HOURS,
  type PerPlatformCaptions,
  type SettingsPostingWindows,
  SLOT_JITTER_MINUTES,
  toAyrsharePlatform,
} from "@ve/core";
import { offlineClassifyComment } from "../src/engines/distribution/offline";
import { buildAyrsharePayload, splitThread } from "../src/engines/distribution/publish";
import {
  defaultJitter,
  type PlanPost,
  planSchedule,
  windowSlots,
} from "../src/engines/distribution/scheduler";
import { need } from "./helpers";

const WINDOWS: SettingsPostingWindows = {
  tiktok: [
    { days: ["*"], start: "19:00", end: "23:00" },
    { days: ["sat", "sun"], start: "09:00", end: "11:00", flag: "tiktok_weekend_am" },
  ],
  youtube: [{ days: ["*"], start: "16:00", end: "18:00" }],
  x: [
    { days: ["tue", "wed", "thu"], start: "09:00", end: "12:00" },
    { days: ["*"], start: "20:00", end: "21:30" },
  ],
  reddit: [{ days: ["*"], start: "16:30", end: "19:30" }],
};

const NOW = new Date("2026-07-14T00:00:00Z"); // 05:30 IST, Tue 14 Jul
const CAT = "11111111-1111-1111-1111-111111111111";
const GAP_MS = MIN_SAME_PLATFORM_GAP_HOURS * 3_600_000;
const noJitter = () => 0;

function post(id: string, over: Partial<PlanPost> = {}): PlanPost {
  return {
    postId: id,
    categoryId: CAT,
    platform: "tiktok",
    briefId: `brief-${id}`,
    orderKey: 0,
    longevity: "days",
    ...over,
  };
}

const capOf = (n: number) => () => n;
const istDay = (d: Date) => {
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}`;
};

describe("windowSlots (doc 06 §4)", () => {
  test("tiktok 19:00–23:00 daily → slots at IST 19:00 and 22:00", () => {
    const slots = windowSlots(WINDOWS.tiktok, NOW, 0, new Set());
    const hours = slots.map((s) => istParts(s).hour);
    expect(hours).toEqual([19, 22]);
  });

  test("flagged weekend window only appears when its flag is active", () => {
    const sat = new Date("2026-07-18T00:00:00Z"); // Sat 18 Jul IST
    const without = windowSlots(WINDOWS.tiktok, sat, 0, new Set());
    const withFlag = windowSlots(WINDOWS.tiktok, sat, 0, new Set(["tiktok_weekend_am"]));
    expect(withFlag.length).toBeGreaterThan(without.length);
    expect(withFlag.some((s) => istParts(s).hour === 9)).toBe(true);
  });
});

describe("planSchedule (doc 06 §4/§7)", () => {
  test("schedules a post inside a real window, in the future", () => {
    const plan = planSchedule({
      now: NOW,
      posts: [post("p1")],
      windows: WINDOWS,
      capFor: capOf(2),
      existingByLane: new Map(),
      jitterFn: noJitter,
    });
    expect(plan).toHaveLength(1);
    expect(need(plan[0]).scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
    expect([19, 22]).toContain(istParts(need(plan[0]).scheduledFor).hour);
  });

  test("cadence cap: 3 tiktok posts with cap 2 → no IST day holds more than 2 (third rolls over)", () => {
    const plan = planSchedule({
      now: NOW,
      posts: [post("a"), post("b"), post("c")],
      windows: WINDOWS,
      capFor: capOf(2),
      existingByLane: new Map(),
      jitterFn: noJitter,
    });
    expect(plan).toHaveLength(3);
    const perDay = new Map<string, number>();
    for (const r of plan)
      perDay.set(istDay(r.scheduledFor), (perDay.get(istDay(r.scheduledFor)) ?? 0) + 1);
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(2);
    // and the third genuinely lands on a later day than the first two
    expect(perDay.size).toBeGreaterThanOrEqual(2);
  });

  test("respects the ≥3h same-lane gap", () => {
    const plan = planSchedule({
      now: NOW,
      posts: [post("a"), post("b")],
      windows: WINDOWS,
      capFor: capOf(5),
      existingByLane: new Map(),
      jitterFn: noJitter,
    });
    expect(plan).toHaveLength(2);
    const [t1, t2] = plan.map((r) => r.scheduledFor.getTime()).sort((x, y) => x - y);
    expect(need(t2) - need(t1)).toBeGreaterThanOrEqual(GAP_MS);
  });

  test("existing scheduled times count against the gap and daily cap", () => {
    const existing = new Map([[`${CAT}:tiktok`, [new Date("2026-07-14T13:30:00Z")]]]); // 19:00 IST
    const plan = planSchedule({
      now: NOW,
      posts: [post("a")],
      windows: WINDOWS,
      capFor: capOf(2),
      existingByLane: existing,
      jitterFn: noJitter,
    });
    // 19:00 IST is taken → the only other slot today (22:00) must be chosen (≥3h from 19:00)
    expect(istParts(need(plan[0]).scheduledFor).hour).toBe(22);
  });

  test("flash trend fast-path schedules ~10 min out", () => {
    const plan = planSchedule({
      now: NOW,
      posts: [post("f", { longevity: "flash", briefId: "hot" })],
      windows: WINDOWS,
      capFor: capOf(2),
      existingByLane: new Map(),
      fastPathBriefId: "hot",
      jitterFn: noJitter,
    });
    expect(need(plan[0]).fastPath).toBe(true);
    expect(need(plan[0]).scheduledFor.getTime() - NOW.getTime()).toBe(10 * 60_000);
  });

  test("warm-up cap of 1 keeps at most one post per IST day", () => {
    const plan = planSchedule({
      now: NOW,
      posts: [post("a"), post("b")],
      windows: WINDOWS,
      capFor: capOf(1),
      existingByLane: new Map(),
      jitterFn: noJitter,
    });
    const perDay = new Map<string, number>();
    for (const r of plan)
      perDay.set(istDay(r.scheduledFor), (perDay.get(istDay(r.scheduledFor)) ?? 0) + 1);
    for (const n of perDay.values()) expect(n).toBe(1);
  });

  test("cross-platform same-brief posts stagger ≥30 min, tiktok first (doc 06 §7)", () => {
    const plan = planSchedule({
      now: NOW,
      posts: [
        post("tt", { platform: "tiktok", briefId: "same" }),
        post("yt", { platform: "youtube", briefId: "same" }),
      ],
      windows: WINDOWS,
      capFor: capOf(2),
      existingByLane: new Map(),
      jitterFn: noJitter,
    });
    const tt = need(plan.find((r) => r.postId === "tt"));
    const yt = need(plan.find((r) => r.postId === "yt"));
    expect(tt.scheduledFor.getTime()).toBeLessThan(yt.scheduledFor.getTime());
    expect(yt.scheduledFor.getTime() - tt.scheduledFor.getTime()).toBeGreaterThanOrEqual(
      30 * 60_000,
    );
  });

  test("defaultJitter is deterministic and within ±SLOT_JITTER_MINUTES", () => {
    for (const id of ["a", "b", "c", "deadbeef", "post-123"]) {
      const j = defaultJitter(id);
      expect(j).toBe(defaultJitter(id));
      expect(Math.abs(j)).toBeLessThanOrEqual(SLOT_JITTER_MINUTES);
    }
  });
});

describe("buildAyrsharePayload (doc 06 §2)", () => {
  const captions: PerPlatformCaptions = {
    tiktok: { caption: "the math flipped", hashtags: ["ai", "#tech"] },
    youtube: { title: "AI cost math", description: "what changed", tags: ["ai"] },
    x: { text: "single tweet body" },
    reddit: { title: "Anyone else?", subreddit: "r/artificial", body: "discuss" },
  };

  test("tiktok payload carries PUBLIC privacy + AI flag + normalized hashtags", () => {
    const p = buildAyrsharePayload({
      platform: "tiktok",
      captions,
      scriptBody: "",
      formatSlug: "faceless-explainer-60s",
      aiDisclosure: true,
      mediaUrl: "https://x/v.mp4",
    });
    expect(p.platforms).toEqual(["tiktok"]);
    expect(p.mediaUrls).toEqual(["https://x/v.mp4"]);
    expect(p.tikTokOptions?.privacyLevel).toBe("PUBLIC_TO_EVERYONE");
    expect(p.tikTokOptions?.isAiGenerated).toBe(true);
    expect(p.post).toContain("#ai");
    expect(p.post).toContain("#tech");
    expect(p.post).not.toContain("##");
  });

  test("youtube maps to twitter-free shorts payload with synthetic-media flag", () => {
    const p = buildAyrsharePayload({
      platform: "youtube",
      captions,
      scriptBody: "",
      formatSlug: "faceless-explainer-60s",
      aiDisclosure: false,
      mediaUrl: "https://x/v.mp4",
    });
    expect(p.youTubeOptions?.title).toBe("AI cost math");
    expect(p.youTubeOptions?.shorts).toBe(true);
    expect(p.youTubeOptions?.madeForKids).toBe(false);
    expect(p.youTubeOptions?.containsSyntheticMedia).toBe(false);
  });

  test("x-thread splits the body into post + twitterOptions.thread", () => {
    const p = buildAyrsharePayload({
      platform: "x",
      captions,
      scriptBody: "hook tweet\n---\nsecond\n---\nthird",
      formatSlug: "x-thread",
      aiDisclosure: false,
      mediaUrl: null,
    });
    expect(p.platforms).toEqual(["twitter"]);
    expect(p.post).toBe("hook tweet");
    expect(p.twitterOptions?.thread).toEqual(["second", "third"]);
    expect(p.mediaUrls).toBeUndefined();
  });

  test("reddit strips the r/ prefix from the subreddit", () => {
    const p = buildAyrsharePayload({
      platform: "reddit",
      captions,
      scriptBody: "",
      formatSlug: "reddit-discussion",
      aiDisclosure: false,
      mediaUrl: null,
    });
    expect(p.redditOptions?.subreddit).toBe("artificial");
    expect(p.redditOptions?.title).toBe("Anyone else?");
  });

  test("missing a platform caption throws (never publish an empty post)", () => {
    expect(() =>
      buildAyrsharePayload({
        platform: "tiktok",
        captions: {},
        scriptBody: "",
        formatSlug: "faceless-explainer-60s",
        aiDisclosure: false,
        mediaUrl: null,
      }),
    ).toThrow();
  });

  test("toAyrsharePlatform maps x → twitter", () => {
    expect(toAyrsharePlatform("x")).toBe("twitter");
    expect(toAyrsharePlatform("tiktok")).toBe("tiktok");
  });

  test("splitThread trims and drops empty tweets", () => {
    expect(splitThread("a\n---\n b \n---\n\n---\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("comment classification routing (doc 06 §6)", () => {
  test("praise gets a draft; criticism needs a human; risky questions escalate", () => {
    expect(offlineClassifyComment("this is amazing 🔥").kind).toBe("praise");
    expect(offlineClassifyComment("this is amazing 🔥").draftReply).toBeTruthy();
    expect(offlineClassifyComment("this is a scam").needsHuman).toBe(true);
    expect(offlineClassifyComment("what's the price?").needsHuman).toBe(true);
    const q = offlineClassifyComment("how did you make this?");
    expect(q.kind).toBe("question");
    expect(q.draftReply).toBeTruthy();
  });
});

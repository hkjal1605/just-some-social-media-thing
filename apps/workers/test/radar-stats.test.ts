import { describe, expect, test } from "bun:test";
import {
  acceleration,
  cosineSimilarity,
  engagementRate,
  maxTransferability,
  meanStd,
  primaryMetric,
  type SnapshotPoint,
  updateCentroid,
  velocityZ,
  viewsPerHour,
} from "../src/engines/radar/stats";

const snap = (
  hoursAgo: number,
  views: number | null,
  extra: Partial<SnapshotPoint> = {},
): SnapshotPoint => ({
  capturedAt: new Date(Date.now() - hoursAgo * 3_600_000),
  views,
  likes: null,
  comments: null,
  shares: null,
  score: null,
  ...extra,
});

describe("viewsPerHour (doc 04 §2 Layer A)", () => {
  test("growth across span", () => {
    // 1000 → 7000 over 2h = 3000/h
    expect(viewsPerHour([snap(2, 1000), snap(0, 7000)])).toBeCloseTo(3000);
  });
  test("needs ≥2 snapshots", () => {
    expect(viewsPerHour([snap(0, 500)])).toBeNull();
    expect(viewsPerHour([])).toBeNull();
  });
  test("reddit uses score as the primary metric", () => {
    const points = [snap(1, null, { score: 100 }), snap(0, null, { score: 400 })];
    expect(viewsPerHour(points)).toBeCloseTo(300);
    expect(primaryMetric(points[1] as SnapshotPoint)).toBe(400);
  });
  test("near-simultaneous snapshots can't explode the rate (span floor)", () => {
    const rate = viewsPerHour([snap(0.001, 0), snap(0, 10_000)]);
    expect(rate).not.toBeNull();
    expect(rate as number).toBeLessThanOrEqual(40_000); // floored at 0.25h span
  });
});

describe("acceleration (2nd derivative over last 3 snapshots)", () => {
  test("speeding up is positive", () => {
    // rates: 1000/h then 5000/h → accel 4000
    expect(acceleration([snap(2, 0), snap(1, 1000), snap(0, 6000)])).toBeCloseTo(4000);
  });
  test("slowing down is negative", () => {
    expect(acceleration([snap(2, 0), snap(1, 5000), snap(0, 6000)])).toBeCloseTo(-4000);
  });
  test("needs 3 snapshots", () => {
    expect(acceleration([snap(1, 0), snap(0, 100)])).toBeNull();
  });
});

describe("engagementRate", () => {
  test("(likes+comments+shares)/views", () => {
    expect(engagementRate(snap(0, 1000, { likes: 50, comments: 30, shares: 20 }))).toBeCloseTo(0.1);
  });
  test("null without views", () => {
    expect(engagementRate(snap(0, null, { likes: 50 }))).toBeNull();
    expect(engagementRate(undefined)).toBeNull();
  });
});

describe("baseline math", () => {
  test("meanStd", () => {
    const { mean, std } = meanStd([100, 200, 300]);
    expect(mean).toBeCloseTo(200);
    expect(std).toBeCloseTo(Math.sqrt(20000 / 3));
  });
  test("empty series → neutral baseline", () => {
    expect(meanStd([])).toEqual({ mean: 0, std: 1 });
  });
  test("velocityZ floors σ at 1", () => {
    expect(velocityZ(500, { mean: 100, std: 200 })).toBeCloseTo(2);
    expect(velocityZ(5, { mean: 2, std: 0.0001 })).toBeCloseTo(3); // σ→1
  });
});

describe("vector math (doc 04 §3)", () => {
  test("cosineSimilarity identical=1, orthogonal=0", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0); // length mismatch
  });
  test("updateCentroid is the incremental mean", () => {
    // centroid of [1,1] with n=2, add [4,4] → [2,2]
    expect(updateCentroid([1, 1], 2, [4, 4])).toEqual([2, 2]);
    // degenerate n → new vector wins
    expect(updateCentroid([9, 9], 0, [1, 2])).toEqual([1, 2]);
  });
  test("maxTransferability element-wise (doc 04 §3.4)", () => {
    expect(
      maxTransferability(
        { tiktok: 10, youtube: 90, x: 50, reddit: 20 },
        { tiktok: 80, youtube: 30, x: 50, reddit: 60 },
      ),
    ).toEqual({ tiktok: 80, youtube: 90, x: 50, reddit: 60 });
    expect(maxTransferability(null, { tiktok: 1, youtube: 2, x: 3, reddit: 4 })).toEqual({
      tiktok: 1,
      youtube: 2,
      x: 3,
      reddit: 4,
    });
  });
});

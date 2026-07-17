import { describe, expect, test } from "bun:test";
import type { PostStatus } from "../src";
import {
  APPROVAL_TRANSITIONS,
  BRIEF_TRANSITIONS,
  canTransition,
  POST_STATUS,
  POST_TRANSITIONS,
  RENDER_TRANSITIONS,
  TREND_TRANSITIONS,
} from "../src";

describe("POST_TRANSITIONS (doc 02 §5)", () => {
  const allowed: [PostStatus, PostStatus][] = [
    ["draft", "awaiting_approval"],
    ["draft", "deleted"],
    ["awaiting_approval", "approved"],
    ["awaiting_approval", "draft"],
    ["approved", "scheduled"],
    ["scheduled", "publishing"],
    ["scheduled", "approved"],
    ["publishing", "published"],
    ["publishing", "failed"],
    ["published", "failed"], // platform rejected after an optimistic 200 (publish.verify)
    ["published", "deleted"],
    ["failed", "scheduled"],
  ];
  test.each(allowed)("allows %s → %s", (from, to) => {
    expect(canTransition(POST_TRANSITIONS, from, to)).toBe(true);
  });

  const blocked: [PostStatus, PostStatus][] = [
    ["draft", "published"],
    ["draft", "scheduled"],
    ["approved", "published"],
    ["published", "draft"],
    ["deleted", "draft"],
    ["failed", "published"],
    ["publishing", "scheduled"],
  ];
  test.each(blocked)("blocks %s → %s", (from, to) => {
    expect(canTransition(POST_TRANSITIONS, from, to)).toBe(false);
  });

  test("every status is covered and terminal states are truly terminal", () => {
    for (const s of POST_STATUS) expect(POST_TRANSITIONS[s]).toBeDefined();
    expect(POST_TRANSITIONS.deleted).toHaveLength(0);
  });
});

describe("other transition maps", () => {
  test("brief: ready → scripted (edit flow) allowed; abandoned terminal", () => {
    expect(canTransition(BRIEF_TRANSITIONS, "ready", "scripted")).toBe(true);
    expect(canTransition(BRIEF_TRANSITIONS, "abandoned", "draft")).toBe(false);
    expect(canTransition(BRIEF_TRANSITIONS, "draft", "ready")).toBe(false);
  });

  test("approval: pending decides once; expired can renew to pending", () => {
    expect(canTransition(APPROVAL_TRANSITIONS, "pending", "approved")).toBe(true);
    expect(canTransition(APPROVAL_TRANSITIONS, "expired", "pending")).toBe(true);
    expect(canTransition(APPROVAL_TRANSITIONS, "approved", "rejected")).toBe(false);
    expect(canTransition(APPROVAL_TRANSITIONS, "auto_approved", "pending")).toBe(false);
  });

  test("render: retry from failed only; done terminal", () => {
    expect(canTransition(RENDER_TRANSITIONS, "failed", "rendering")).toBe(true);
    expect(canTransition(RENDER_TRANSITIONS, "done", "rendering")).toBe(false);
    expect(canTransition(RENDER_TRANSITIONS, "pending", "done")).toBe(false);
  });

  test("trend: suppressed and expired are terminal", () => {
    expect(canTransition(TREND_TRANSITIONS, "active", "suppressed")).toBe(true);
    expect(canTransition(TREND_TRANSITIONS, "suppressed", "active")).toBe(false);
    expect(canTransition(TREND_TRANSITIONS, "expired", "active")).toBe(false);
  });
});

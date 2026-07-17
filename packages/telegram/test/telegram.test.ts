import { describe, expect, test } from "bun:test";
import {
  buildApprovalCaption,
  esc,
  isAdminUser,
  isApprovalChat,
  parseApprovalCallback,
} from "../src";

describe("esc (HTML escaping for TG captions)", () => {
  test("escapes &, <, >", () => {
    expect(esc('<b>"AI & you" > hype</b>')).toBe('&lt;b&gt;"AI &amp; you" &gt; hype&lt;/b&gt;');
  });
});

describe("guards", () => {
  test("isAdminUser only allows listed ids", () => {
    expect(isAdminUser(42, [42, 7])).toBe(true);
    expect(isAdminUser(43, [42, 7])).toBe(false);
    expect(isAdminUser(undefined, [42])).toBe(false);
  });
  test("isApprovalChat matches the configured group only", () => {
    expect(isApprovalChat(-100123, -100123)).toBe(true);
    expect(isApprovalChat(-100124, -100123)).toBe(false);
    expect(isApprovalChat(undefined, -100123)).toBe(false);
  });
});

describe("parseApprovalCallback", () => {
  test("parses apr|id|action", () => {
    expect(parseApprovalCallback("apr|abc-123|approve")).toEqual({
      approvalId: "abc-123",
      action: "approve",
    });
    expect(parseApprovalCallback("apr|abc-123|reject")?.action).toBe("reject");
    expect(parseApprovalCallback("apr|abc-123|edit")?.action).toBe("edit");
  });
  test("rejects foreign or malformed callback data", () => {
    expect(parseApprovalCallback("other|abc|approve")).toBeNull();
    expect(parseApprovalCallback("apr|abc|nuke")).toBeNull();
    expect(parseApprovalCallback("apr")).toBeNull();
  });
});

describe("buildApprovalCaption", () => {
  const card = {
    id: "a1",
    categoryName: "AI / Tech",
    formatSlug: "faceless-explainer-60s",
    angle: "Open-source model < frontier & catching up",
    hook: "This free model just beat the $200/mo one",
    platforms: ["tiktok", "youtube"],
    plannedSlotDisplay: "12 Jul, 7:30 pm IST",
    aiDisclosure: true,
    trendHeadline: "OSS 32B tops SWE-bench",
    dashboardUrl: "http://localhost:3000/briefs/b1",
  };

  test("includes escaped fields, AI badge, dashboard link", () => {
    const caption = buildApprovalCaption(card);
    expect(caption).toContain("AI / Tech · faceless-explainer-60s");
    expect(caption).toContain("&lt; frontier &amp; catching up"); // escaped
    expect(caption).toContain("🏷 AI-disclosure will be set");
    expect(caption).toContain('href="http://localhost:3000/briefs/b1"');
    expect(caption).toContain("tiktok, youtube");
  });

  test("omits AI badge and trend line when absent", () => {
    const caption = buildApprovalCaption({
      ...card,
      aiDisclosure: false,
      trendHeadline: undefined as unknown as string,
    });
    expect(caption).not.toContain("AI-disclosure");
    expect(caption).not.toContain("Trend:");
  });
});

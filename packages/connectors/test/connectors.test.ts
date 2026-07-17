// Fixture-mode contract tests (doc 03 §6): with zero credentials every connector
// returns normalized, schema-valid items — the whole pipeline stays runnable.
import { describe, expect, test } from "bun:test";
import {
  createPost,
  getComments,
  getHistory,
  getPostAnalytics,
  NormalizedItemSchema,
  pexels,
  reddit,
  tiktokData,
  x,
  youtube,
} from "../src";

function expectNormalized(items: unknown[], platform: string) {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    const parsed = NormalizedItemSchema.parse(item);
    expect(parsed.platform).toBe(platform as never);
    expect(parsed.publishedAt).toBeInstanceOf(Date);
  }
}

describe("reddit (fixture mode)", () => {
  test("fetchSubredditHot returns normalized items", async () => {
    expectNormalized(await reddit.fetchSubredditHot("r/artificial"), "reddit");
  });
  test("fetchRising returns normalized items", async () => {
    expectNormalized(await reddit.fetchRising("r/artificial"), "reddit");
  });
  test("fetchComments returns comments with dates", async () => {
    const comments = await reddit.fetchComments("t3_fx10001");
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]?.createdAt).toBeInstanceOf(Date);
    expect(comments[0]?.externalCommentId).toStartWith("t1_");
  });
});

describe("youtube (fixture mode)", () => {
  test("fetchMostPopular normalized", async () => {
    expectNormalized(await youtube.fetchMostPopular("US"), "youtube");
  });
  test("fetchChannelUploads normalized", async () => {
    expectNormalized(
      await youtube.fetchChannelUploads("UCfixture", "2026-07-01T00:00:00Z"),
      "youtube",
    );
  });
  test("fetchVideoStats normalized", async () => {
    expectNormalized(await youtube.fetchVideoStats(["yt_fixture11"]), "youtube");
  });
});

describe("x (fixture mode)", () => {
  test("searchRecent returns items + newestId cursor", async () => {
    const { items, newestId } = await x.searchRecent("(AI OR LLM) min_faves:500");
    expectNormalized(items, "x");
    expect(newestId).toBeString();
  });
  test("getOwnPostsMetrics maps ids", async () => {
    const m = await x.getOwnPostsMetrics(["123", "456"]);
    expect(m.size).toBe(2);
  });
});

describe("tiktok data provider (fixture mode)", () => {
  test("fetchHashtagTop normalized", async () => {
    expectNormalized(await tiktokData.fetchHashtagTop("ai", 30), "tiktok");
  });
  test("fetchCreatorRecent normalized", async () => {
    expectNormalized(await tiktokData.fetchCreatorRecent("@aidailydemo"), "tiktok");
  });
});

describe("ayrshare (fixture mode)", () => {
  test("createPost returns id + postIds", async () => {
    const res = await createPost({ post: "hello", platforms: ["tiktok"] });
    expect(res.id).toBeString();
    expect(res.postIds?.[0]?.postUrl).toContain("tiktok.com");
  });
  test("analytics normalized shape (doc 06 §2)", async () => {
    const a = await getPostAnalytics("ayr-fixture-post-001");
    expect(a.views).toBeGreaterThan(0);
    expect(a.raw).toBeDefined();
  });
  test("history + comments", async () => {
    expect((await getHistory()).length).toBeGreaterThan(0);
    const comments = await getComments("ayr-fixture-post-001");
    expect(comments[0]?.commentId).toBeString();
  });
});

describe("pexels (fixture mode)", () => {
  test("searchVideos returns portrait stock with download URLs", async () => {
    const videos = await pexels.searchVideos("technology", "portrait");
    expect(videos.length).toBeGreaterThan(0);
    expect(videos[0]?.downloadUrl).toStartWith("https://");
    expect(videos[0]?.id).toBeNumber();
  });
  test("searchPhotos returns photos", async () => {
    const photos = await pexels.searchPhotos("circuit board");
    expect(photos[0]?.downloadUrl).toStartWith("https://");
  });
});

// Distribution integration (doc 06 §8 acceptance) against real Postgres + a live Bun.serve
// Ayrshare stub the REAL connector talks to (via setAyrshareBaseUrl). Covers: approved →
// plan → execute → published + verify permalink; kill-switch mid-flight revert; cadence
// overflow; publish-failure retry policy; engagement scan + gated reply.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAyrshareBaseUrl } from "@ve/connectors";
import { CADENCE_CAPS_DEFAULT, CommentClassificationSchema, newId } from "@ve/core";
import {
  approvals,
  briefs,
  bustSettingsCache,
  categories,
  complianceChecks,
  db,
  engagements,
  eq,
  postSnapshots,
  posts,
  renders,
  scripts,
  seed,
  setSetting,
  sql,
  sqlClient,
} from "@ve/db";
import type PgBoss from "pg-boss";
import { setDistributionDeps } from "../src/engines/distribution/deps";
import { engageReplyHandler, engageScanForPost } from "../src/engines/distribution/engagement";
import { offlineClassifyComment } from "../src/engines/distribution/offline";
import { publishExecuteHandler, publishVerifyHandler } from "../src/engines/distribution/publish";
import { publishPlanHandler } from "../src/engines/distribution/scheduler";
import { metricsSnapshotHandler } from "../src/engines/learning/metrics";
import type { Enqueuer } from "../src/harness";
import { need } from "./helpers";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("distribution.integration: postgres unavailable — suite skipped");
if (reachable) {
  await seed();
  // The scheduler's ≥3h gap is account-wide (one shared brand account per platform), so these
  // scheduling tests need a clean account — the shared test DB accumulates posts across runs.
  // Clear posts not referenced by a campaign_clip (FK) once, before any test in this file.
  await db.execute(sql`delete from posts where id not in (select post_id from campaign_clips)`);
}

const run = newId().slice(-8);

interface Sent {
  name: string;
  data: Record<string, unknown>;
  options?: PgBoss.SendOptions;
}
function stubBoss(): Enqueuer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (name, data, options) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)), ...(options ? { options } : {}) });
      return newId();
    },
  };
}

// ── live Ayrshare stub server ────────────────────────────────────────
const stubState = {
  seq: 0,
  posts: new Map<string, { platform: string }>(),
  comments: [] as { commentId: string; comment: string; userName?: string }[],
  replies: [] as { id: string; comment: string }[],
  failStatus: 0,
  rejectHistory: false, // when true, /history reports the platform rejected the post (H8)
};
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  if (!reachable) return;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api/, "");
      if (req.method === "POST" && path === "/post") {
        if (stubState.failStatus) {
          return new Response(JSON.stringify({ error: "stub failure" }), {
            status: stubState.failStatus,
          });
        }
        stubState.seq++;
        const body = (await req.json()) as { platforms: string[] };
        const platform = body.platforms[0] ?? "tiktok";
        const id = `ayr_${run}_${stubState.seq}`;
        stubState.posts.set(id, { platform });
        return Response.json({
          id,
          status: "success",
          postIds: [
            {
              platform,
              id: `ext_${stubState.seq}`,
              postUrl: `https://example.test/${platform}/${stubState.seq}`,
              status: "success",
            },
          ],
        });
      }
      if (req.method === "POST" && path === "/analytics/post") {
        return Response.json({
          tiktok: { analytics: { views: 5000, likes: 400, comments: 20, shares: 10 } },
        });
      }
      if (req.method === "GET" && path === "/history") {
        const status = stubState.rejectHistory ? "error" : "success";
        return Response.json(
          [...stubState.posts.entries()].map(([id, p]) => ({
            id,
            status,
            postIds: [
              {
                platform: p.platform,
                id: "extX",
                postUrl: `https://example.test/live/${id}`,
                status,
              },
            ],
          })),
        );
      }
      if (req.method === "GET" && path.startsWith("/comments/")) {
        return Response.json({ tiktok: stubState.comments });
      }
      if (req.method === "POST" && path.startsWith("/comments/reply/")) {
        const id = path.split("/").pop() ?? "";
        stubState.replies.push({
          id,
          comment: ((await req.json()) as { comment: string }).comment,
        });
        return Response.json({ status: "success" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  setAyrshareBaseUrl(`http://localhost:${server.port}/api`);
  // classify comments deterministically without hitting Gemini
  setDistributionDeps({
    scoreBatch: async (opts) => {
      const m = new Map();
      for (const it of opts.items)
        m.set(it.id, CommentClassificationSchema.parse(offlineClassifyComment(it.text)));
      return m;
    },
  });
});

afterAll(() => {
  setAyrshareBaseUrl(null);
  server?.stop(true);
});

async function makePublishable(
  status: string,
  opts: { platform?: string; slug?: string } = {},
): Promise<{ categoryId: string; briefId: string; postId: string; slug: string }> {
  const platform = opts.platform ?? "tiktok";
  const categoryId = newId();
  const slug = opts.slug ?? `dist-${run}-${categoryId.slice(-6)}`;
  await db.insert(categories).values({
    id: categoryId,
    slug,
    name: slug,
    mode: "full_auto_candidate",
    autoApproveFormats: [],
    cadenceCaps: CADENCE_CAPS_DEFAULT,
    active: true,
  });
  const briefId = newId();
  await db.insert(briefs).values({
    id: briefId,
    categoryId,
    originKind: "trend",
    status: "ready",
    angle: "original angle",
    formatSlug: "faceless-explainer-60s",
    targetPlatforms: [platform],
  });
  const scriptId = newId();
  await db.insert(scripts).values({
    id: scriptId,
    briefId,
    version: 1,
    hookVariants: [{ id: "a", text: "hook" }],
    body: "[SCENE 1] narration",
    sceneCount: 1,
    estDurationSec: 66,
    perPlatformCaptions: {
      tiktok: { caption: "the math flipped", hashtags: ["ai", "tech"] },
      youtube: { title: "AI cost math", description: "what changed", tags: ["ai"] },
      x: { text: "the math flipped — video inside" },
      reddit: { title: "Anyone else?", subreddit: "r/artificial", body: "discuss" },
    },
    sceneVisuals: [{ scene: 1, want: "server room" }],
    aiDisclosure: true,
  });
  const renderId = newId();
  await db.insert(renders).values({
    id: renderId,
    briefId,
    scriptId,
    platform,
    status: "done",
    r2Key: `renders/${briefId}/${renderId}_${platform}.mp4`,
    thumbR2Key: `thumbs/${renderId}.jpg`,
    width: 1080,
    height: 1920,
    durationSec: "66.00",
    bytes: 2_000_000,
  });
  const postId = newId();
  await db.insert(posts).values({
    id: postId,
    briefId,
    renderId,
    categoryId,
    platform,
    status,
    ...(status === "scheduled" ? { scheduledFor: new Date(Date.now() - 60_000) } : {}),
  });
  await db.insert(approvals).values({
    id: newId(),
    briefId,
    status: "auto_approved",
    decidedVia: "auto",
    decidedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(complianceChecks).values({
    id: newId(),
    briefId,
    stage: "pre_publish",
    pass: true,
    results: [],
  });
  return { categoryId, briefId, postId, slug };
}

describe("publish.execute → verify (doc 06 §5/§8)", () => {
  t(
    "scheduled post publishes to the mock Ayrshare server, lands published, verify fills permalink",
    async () => {
      const { postId } = await makePublishable("scheduled");
      const boss = stubBoss();

      const res = await publishExecuteHandler({ postId }, boss);
      expect(res.status).toBe("published");

      const [published] = await db.select().from(posts).where(eq(posts.id, postId));
      expect(published?.status).toBe("published");
      expect(published?.publishedAt).not.toBeNull();
      expect(published?.ayrsharePostId).toContain("ayr_");
      expect(published?.permalink).toContain("https://example.test/");
      expect(published?.captionUsed).toBeTruthy();

      // verify (+3h, +24h) metric snapshots + a verify job were scheduled
      expect(boss.sent.filter((s) => s.name === "metrics.snapshot").length).toBe(2);
      expect(boss.sent.some((s) => s.name === "publish.verify")).toBe(true);

      // publish.verify confirms live and refreshes the permalink from /history
      const vres = await publishVerifyHandler({ postId }, boss);
      expect(vres.verified).toBe(true);
      const [verified] = await db.select().from(posts).where(eq(posts.id, postId));
      expect(verified?.permalink).toContain("https://example.test/live/");
    },
  );

  t(
    "kill-switch flipped mid-flight → publish refuses, post returns to approved, alert sent (doc 06 §8)",
    async () => {
      const { postId } = await makePublishable("scheduled");
      const boss = stubBoss();
      await setSetting("kill_switch", true);
      bustSettingsCache();
      try {
        const res = await publishExecuteHandler({ postId }, boss);
        expect(res.status).toBe("reverted");
        const [reverted] = await db.select().from(posts).where(eq(posts.id, postId));
        expect(reverted?.status).toBe("approved");
        expect(reverted?.scheduledFor).toBeNull();
        expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(true);
      } finally {
        await setSetting("kill_switch", false);
        bustSettingsCache();
      }
    },
  );

  t(
    "kill-switch defers gated jobs at the harness (no retry-budget burn, no dead-letter) (H3)",
    async () => {
      // the harness gate re-enqueues the job for later instead of throwing into the retry budget
      const { registerWorker } = await import("../src/harness");
      const sent: { name: string; opts?: PgBoss.SendOptions }[] = [];
      const fakeBoss = {
        work: async (
          _q: string,
          _o: unknown,
          handler: (jobs: PgBoss.JobWithMetadata<object>[]) => Promise<void>,
        ) => {
          await setSetting("kill_switch", true);
          bustSettingsCache();
          try {
            await handler([
              { id: "j1", data: { postId: newId() }, retryCount: 0, retryLimit: 3 },
            ] as unknown as PgBoss.JobWithMetadata<object>[]);
          } finally {
            await setSetting("kill_switch", false);
            bustSettingsCache();
          }
        },
        send: async (name: string, _data: object, opts?: PgBoss.SendOptions) => {
          sent.push({ name, ...(opts ? { opts } : {}) });
          return newId();
        },
      };
      let ran = false;
      await registerWorker(
        fakeBoss as unknown as Parameters<typeof registerWorker>[0],
        "publish.execute",
        (await import("@ve/core")).PublishExecutePayload,
        async () => {
          ran = true;
        },
        { concurrency: 1 },
      );
      expect(ran).toBe(false); // handler never ran — the job was deferred, not executed
      const deferred = sent.find((s) => s.name === "publish.execute");
      expect(deferred).toBeTruthy();
      expect(Number(deferred?.opts?.startAfter)).toBeGreaterThan(0); // re-armed for later
    },
  );

  t(
    "redelivered job already 'publishing' fails safe — never re-sends (no double-publish) (H2)",
    async () => {
      const { postId } = await makePublishable("scheduled");
      // simulate a crash after acquiring the lock but before recording 'published'
      await db.update(posts).set({ status: "publishing" }).where(eq(posts.id, postId));
      const boss = stubBoss();
      const seqBefore = stubState.seq;
      const res = await publishExecuteHandler({ postId }, boss);
      expect(res.status).toBe("failed");
      expect(stubState.seq).toBe(seqBefore); // Ayrshare createPost was NOT called again
      const [after] = await db.select().from(posts).where(eq(posts.id, postId));
      expect(after?.status).toBe("failed");
      expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(true);
    },
  );

  t(
    "publish.verify: platform rejection marks the post failed with the platform error (H8)",
    async () => {
      const { postId } = await makePublishable("scheduled");
      const boss = stubBoss();
      expect((await publishExecuteHandler({ postId }, boss)).status).toBe("published");
      stubState.rejectHistory = true;
      try {
        const vres = await publishVerifyHandler({ postId }, boss);
        expect(vres.verified).toBe(false);
        const [rejected] = await db.select().from(posts).where(eq(posts.id, postId));
        expect(rejected?.status).toBe("failed"); // published → failed is now a legal transition
        expect(rejected?.failReason).toContain("platform rejected");
        expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(true);
      } finally {
        stubState.rejectHistory = false;
      }
    },
  );

  t(
    "retryable 5xx → post back to scheduled with retryCount bumped + re-enqueue; 4xx → failed + alert",
    async () => {
      const { postId } = await makePublishable("scheduled");
      const boss = stubBoss();
      stubState.failStatus = 503;
      try {
        const res = await publishExecuteHandler({ postId }, boss);
        expect(res.status).toBe("failed");
        const [afterRetry] = await db.select().from(posts).where(eq(posts.id, postId));
        expect(afterRetry?.status).toBe("scheduled");
        expect(afterRetry?.retryCount).toBe(1);
        expect(boss.sent.some((s) => s.name === "publish.execute")).toBe(true);
      } finally {
        stubState.failStatus = 0;
      }

      // a 4xx is a payload bug → fail with no retry + alert
      const { postId: p2 } = await makePublishable("scheduled");
      const boss2 = stubBoss();
      stubState.failStatus = 400;
      try {
        await publishExecuteHandler({ postId: p2 }, boss2);
        const [failed] = await db.select().from(posts).where(eq(posts.id, p2));
        expect(failed?.status).toBe("failed");
        expect(boss2.sent.some((s) => s.name === "alert.telegram")).toBe(true);
      } finally {
        stubState.failStatus = 0;
      }
    },
  );
});

describe("publish.plan scheduling + cadence (doc 06 §4/§8)", () => {
  t("approved post gets a slot + a publish.execute job", async () => {
    const { postId } = await makePublishable("approved");
    const boss = stubBoss();
    await publishPlanHandler({}, boss);
    const [scheduled] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(scheduled?.status).toBe("scheduled");
    expect(scheduled?.scheduledFor).not.toBeNull();
    expect(boss.sent.some((s) => s.name === "publish.execute" && s.data.postId === postId)).toBe(
      true,
    );
  });

  t("3 tiktok posts, cap 2 → no more than 2 land on any IST day (third rolls over)", async () => {
    const categoryId = newId();
    const slug = `cad-${run}-${categoryId.slice(-6)}`;
    await db.insert(categories).values({
      id: categoryId,
      slug,
      name: slug,
      mode: "full_auto_candidate",
      autoApproveFormats: [],
      cadenceCaps: { tiktok: 2, youtube: 1, x: 5, reddit: 1 },
      active: true,
    });
    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      categoryId,
      originKind: "trend",
      status: "ready",
      angle: "a",
      formatSlug: "faceless-explainer-60s",
      targetPlatforms: ["tiktok"],
    });
    const ids = [newId(), newId(), newId()];
    for (const id of ids) {
      await db
        .insert(posts)
        .values({ id, briefId, categoryId, platform: "tiktok", status: "approved" });
    }
    await publishPlanHandler({}, stubBoss());
    const rows = await db
      .select({ scheduledFor: posts.scheduledFor })
      .from(posts)
      .where(eq(posts.categoryId, categoryId));
    const perDay = new Map<string, number>();
    for (const r of rows) {
      expect(r.scheduledFor).not.toBeNull();
      const day = new Date(r.scheduledFor as Date).toISOString().slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    expect(rows.length).toBe(3);
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(2);
    expect(perDay.size).toBeGreaterThanOrEqual(2); // third rolled to a later day
  });
});

describe("engagement scan + gated reply (doc 06 §6)", () => {
  t(
    "scan ingests + classifies comments; auto-reply enqueues for praise when the category opts in",
    async () => {
      const { postId, slug } = await makePublishable("scheduled", { slug: `eng-${run}` });
      // move to published with an ayrshare id so getComments is called
      await db.update(posts).set({ status: "publishing" }).where(eq(posts.id, postId));
      await db
        .update(posts)
        .set({ status: "published", publishedAt: new Date(), ayrsharePostId: `ayr_eng_${run}` })
        .where(eq(posts.id, postId));
      stubState.comments = [
        { commentId: `c1_${run}`, comment: "this is amazing 🔥", userName: "bob" },
        { commentId: `c2_${run}`, comment: "this is a scam", userName: "troll" },
      ];
      await setSetting("engage_auto_reply", { [slug]: true });
      bustSettingsCache();

      const [post] = await db.select().from(posts).where(eq(posts.id, postId));
      const boss = stubBoss();
      const res = await engageScanForPost(need(post), boss);
      expect(res.newComments).toBe(2);

      const rows = await db.select().from(engagements).where(eq(engagements.postId, postId));
      expect(rows.length).toBe(2);
      // criticism flagged for a human, praise enqueued for auto-reply
      expect(rows.some((r) => r.needsHuman)).toBe(true);
      const replyJob = boss.sent.find((s) => s.name === "engage.reply");
      expect(replyJob).toBeTruthy();

      // engage.reply sends the draft via the stub and records it
      const engagementId = need(replyJob).data.engagementId as string;
      await engageReplyHandler({ engagementId, text: "Thank you! 🙏" });
      const [replied] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
      expect(replied?.repliedAt).not.toBeNull();
      expect(stubState.replies.length).toBeGreaterThan(0);

      stubState.comments = [];
    },
  );
});

describe("metrics.snapshot writes a row (doc 07 §1 wiring)", () => {
  t("published post → snapshot row from Ayrshare analytics", async () => {
    const { postId } = await makePublishable("scheduled");
    await db
      .update(posts)
      .set({ status: "published", publishedAt: new Date(), ayrsharePostId: `ayr_metrics_${run}` })
      .where(eq(posts.id, postId));
    const res = await metricsSnapshotHandler({ postId }, stubBoss());
    expect(res.written).toBe(1);
    const snaps = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, postId));
    expect(snaps.length).toBe(1);
    expect(Number(snaps[0]?.views)).toBe(5000);
  });
});

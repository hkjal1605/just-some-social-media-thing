#!/usr/bin/env bun
import { approvalRequestHandler } from "../apps/workers/src/engines/approvals/request";
import { setDistributionDeps } from "../apps/workers/src/engines/distribution/deps";
import {
  FakeAyrshare,
  offlineDistributionDeps,
} from "../apps/workers/src/engines/distribution/offline";
import {
  publishExecuteHandler,
  publishVerifyHandler,
} from "../apps/workers/src/engines/distribution/publish";
import { publishPlanHandler } from "../apps/workers/src/engines/distribution/scheduler";
import { attributionHandler } from "../apps/workers/src/engines/learning/attribution";
import { setLearningDeps } from "../apps/workers/src/engines/learning/deps";
import { metricsSnapshotHandler } from "../apps/workers/src/engines/learning/metrics";
import { offlineLearningDeps } from "../apps/workers/src/engines/learning/offline";
import { playbookUpdateHandler } from "../apps/workers/src/engines/learning/playbook";
import type { Enqueuer } from "../apps/workers/src/harness";
// Distribution + Learning demo (docs 06 + 07): runs the REAL engines end to end against the
// dev database, fully offline (no API keys). A brief that has cleared the factory gate is
// auto-approved → scheduled → published to an in-memory Ayrshare → verified → snapshotted;
// then a batch of historical posts is run through attribution → playbook update, showing the
// kill list revoking an auto-approved format. No network, no ffmpeg.
// Usage: bun run scripts/distribution-demo.ts
import { CADENCE_CAPS_DEFAULT, newId } from "../packages/core/src";
import {
  briefs,
  categories,
  complianceChecks,
  db,
  eq,
  playbookVersions,
  postSnapshots,
  posts,
  renders,
  runMigrations,
  scripts,
  seed,
  trends,
} from "../packages/db/src";

function collector() {
  const sent: { name: string; data: Record<string, unknown> }[] = [];
  const boss: Enqueuer = {
    send: async (name, data) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      return "demo";
    },
  };
  return { boss, sent };
}

await runMigrations();
await seed();

const fake = new FakeAyrshare();
setDistributionDeps(offlineDistributionDeps(fake));
setLearningDeps(offlineLearningDeps({ getPostAnalytics: fake.getPostAnalytics }));

const stamp = newId().slice(-6);
const GOOD = "faceless-explainer-60s";
const BAD = "demo-screencast";

// ── a category whose GOOD + BAD formats both earned auto-approval ──
const categoryId = newId();
const slug = `demo-dist-${stamp}`;
await db.insert(categories).values({
  id: categoryId,
  slug,
  name: slug,
  mode: "full_auto_candidate",
  autoApproveFormats: [GOOD, BAD],
  cadenceCaps: CADENCE_CAPS_DEFAULT,
  active: true,
});

console.log(`\n── Distribution demo (doc 06) — category ${slug} ──`);

// a flash trend + a factory-ready brief (script + render already produced)
const trendId = newId();
await db.insert(trends).values({
  id: trendId,
  categoryId,
  status: "briefed",
  headline: "Open-weights model ships under $2/M tokens",
  summary: "A frontier-class open model just undercut the incumbents on price.",
  rightsClass: "green",
  llmScore: 88,
  emotions: ["curiosity"],
  longevity: "flash",
  peakEstimateAt: new Date(Date.now() + 3 * 3_600_000),
});
const briefId = newId();
await db.insert(briefs).values({
  id: briefId,
  trendId,
  categoryId,
  originKind: "trend",
  status: "ready",
  angle: "The real per-token cost of the new open model vs the top 3 closed APIs",
  formatSlug: GOOD,
  targetPlatforms: ["tiktok"],
});
const scriptId = newId();
await db.insert(scripts).values({
  id: scriptId,
  briefId,
  version: 1,
  hookVariants: [{ id: "a", text: "The AI cost math just flipped" }],
  chosenHook: "a",
  body: "[SCENE 1] Here's the part nobody tells you about the new open model pricing.",
  sceneCount: 1,
  estDurationSec: 66,
  perPlatformCaptions: {
    tiktok: { caption: "The build-vs-buy math just flipped.", hashtags: ["ai", "aitools", "tech"] },
  },
  sceneVisuals: [{ scene: 1, want: "server room" }],
  aiDisclosure: true,
});
const renderId = newId();
await db.insert(renders).values({
  id: renderId,
  briefId,
  scriptId,
  platform: "tiktok",
  status: "done",
  r2Key: `renders/${briefId}/${renderId}_tiktok.mp4`,
  thumbR2Key: `thumbs/${renderId}.jpg`,
  width: 1080,
  height: 1920,
  durationSec: "66.00",
  bytes: 2_400_000,
});
const postId = newId();
await db
  .insert(posts)
  .values({ id: postId, briefId, renderId, categoryId, platform: "tiktok", status: "draft" });
await db
  .insert(complianceChecks)
  .values({ id: newId(), briefId, stage: "pre_publish", pass: true, results: [] });

const c = collector();
console.log("1 · approval.request (auto-approve earned format)…");
const approval = await approvalRequestHandler({ briefId }, c.boss);
console.log(`   → ${approval.outcome}; queued: ${c.sent.map((s) => s.name).join(", ")}`);

console.log("2 · publish.plan (flash fast-path)…");
await publishPlanHandler({ fastPathBriefId: briefId }, c.boss);
const [scheduled] = await db.select().from(posts).where(eq(posts.id, postId));
console.log(`   → scheduled for ${scheduled?.scheduledFor?.toISOString()}`);

console.log("3 · publish.execute (→ in-memory Ayrshare)…");
await publishExecuteHandler({ postId }, c.boss);
console.log("4 · publish.verify…");
await publishVerifyHandler({ postId }, c.boss);
console.log("5 · metrics.snapshot…");
await metricsSnapshotHandler({ postId }, c.boss);

const [published] = await db.select().from(posts).where(eq(posts.id, postId));
const [snap] = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, postId));
console.log("\n── result ──");
console.log(`post ${postId} → ${published?.status}`);
console.log(`ayrshare id: ${published?.ayrsharePostId} · permalink: ${published?.permalink}`);
console.log(`first snapshot: ${snap?.views} views`);

// ── Learning demo (doc 07): 3 weeks of history, one format chronically under median ──
console.log(`\n── Learning demo (doc 07) — attribution over 8 weeks ──`);
const now = Date.now();
for (const [format, views] of [
  [GOOD, 320],
  [BAD, 90],
] as const) {
  const bId = newId();
  await db.insert(briefs).values({
    id: bId,
    categoryId,
    originKind: "trend",
    status: "ready",
    angle: `${format} history`,
    formatSlug: format,
    targetPlatforms: ["tiktok"],
    createdAt: new Date(now - 3 * 3_600_000),
  });
  for (const w of [1, 2, 3]) {
    for (let i = 0; i < 6; i++) {
      const publishedAt = new Date(now - (w * 7 + 2) * 86_400_000);
      const pId = newId();
      await db.insert(posts).values({
        id: pId,
        briefId: bId,
        categoryId,
        platform: "tiktok",
        status: "published",
        publishedAt,
        ayrsharePostId: `ayr_hist_${pId.slice(-8)}`,
      });
      await db.insert(postSnapshots).values({
        id: newId(),
        postId: pId,
        capturedAt: new Date(publishedAt.getTime() + 7 * 86_400_000),
        views,
      });
    }
  }
}

console.log("6 · learn.attribute…");
const attr = await attributionHandler({}, c.boss);
console.log(`   → report ${attr.reportKey}`);
console.log(`   headline: ${attr.report.headline}`);
console.log(
  `   kill list: ${attr.report.killList.map((k) => `${k.categorySlug}/${k.formatSlug}`).join(", ") || "(none)"}`,
);

console.log("7 · playbook.update…");
const pb = await playbookUpdateHandler({ attributionReportKey: attr.reportKey }, c.boss);
const versions = await db
  .select()
  .from(playbookVersions)
  .where(eq(playbookVersions.categoryId, categoryId));
const [afterKill] = await db.select().from(categories).where(eq(categories.id, categoryId));
console.log(`   → ${pb.drafts} playbook draft(s), ${pb.killed} format(s) killed`);
console.log(`   playbook versions for ${slug}: ${versions.map((v) => `v${v.version}`).join(", ")}`);
console.log(
  `   auto-approve formats after kill list: [${((afterKill?.autoApproveFormats ?? []) as string[]).join(", ")}] (was [${GOOD}, ${BAD}])`,
);

console.log("\n✅ Distribution + Learning ran end to end, offline.\n");
process.exit(0);

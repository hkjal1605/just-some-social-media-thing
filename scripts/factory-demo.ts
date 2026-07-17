#!/usr/bin/env bun
import {
  captionsHandler,
  ttsHandler,
  visualsHandler,
} from "../apps/workers/src/engines/factory/assets";
import { complianceHandler } from "../apps/workers/src/engines/factory/compliance";
import { setFactoryDeps } from "../apps/workers/src/engines/factory/deps";
import { offlineFactoryDeps } from "../apps/workers/src/engines/factory/offline";
import { renderHandler } from "../apps/workers/src/engines/factory/render";
import { scriptHandler } from "../apps/workers/src/engines/factory/scriptwriter";
import type { Enqueuer } from "../apps/workers/src/harness";
import { newId } from "../packages/core/src";
// Factory demo: runs the REAL doc-05 pipeline end to end against the dev database,
// offline (no API keys): brief → scriptwriter + similarity guard → compliance →
// tts/visuals/captions → ≥61s 1080×1920 captioned render → posts drafts → pre_publish.
// Prints curl commands to inspect the lineage over the live API.
// Usage: bun run scripts/radar-demo.ts && bun run scripts/factory-demo.ts
import {
  and,
  briefs,
  categories,
  db,
  desc,
  eq,
  posts,
  renders,
  runMigrations,
  seed,
  transitionTrend,
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
setFactoryDeps(offlineFactoryDeps);

const [aiTech] = await db.select().from(categories).where(eq(categories.slug, "ai-tech"));
if (!aiTech) throw new Error("run scripts/radar-demo.ts first (ai-tech category missing)");

// pick the hottest still-active radar trend; the pipeline needs one to brief
const [trend] = await db
  .select()
  .from(trends)
  .where(and(eq(trends.categoryId, aiTech.id), eq(trends.status, "active")))
  .orderBy(desc(trends.llmScore))
  .limit(1);
if (!trend) throw new Error("no active ai-tech trends — run scripts/radar-demo.ts first");

console.log(`── factory demo: briefing trend "${trend.headline.slice(0, 70)}" ──`);
const briefId = newId();
await db.insert(briefs).values({
  id: briefId,
  trendId: trend.id,
  categoryId: aiTech.id,
  originKind: "trend",
  status: "draft",
  angle: "The real monthly cost of running frontier-class AI at home — three setups, real numbers",
  formatSlug: "faceless-explainer-60s",
  targetPlatforms: ["tiktok"],
});
await transitionTrend(db, trend.id, "briefed");

const c = collector();
console.log("1 · scriptwriter (+ similarity guard)…");
const script = await scriptHandler({ briefId }, c.boss);
if (script.blocked) throw new Error("similarity guard blocked the demo script?!");

console.log("2 · compliance pre_render…");
await complianceHandler({ briefId, stage: "pre_render" }, c.boss);

console.log("3 · assets: tts + captions + visuals (offline media)…");
const scriptId = script.scriptId;
if (!scriptId) throw new Error("no script id");
await ttsHandler({ briefId, scriptId }, c.boss);
await captionsHandler({ briefId, scriptId }, c.boss);
await visualsHandler({ briefId, scriptId }, c.boss);

console.log("4 · render (real ffmpeg, ≥61s 1080×1920 with burned captions)…");
await renderHandler({ briefId }, c.boss);

console.log("5 · compliance pre_publish → approval.request…");
await complianceHandler({ briefId, stage: "pre_publish" }, c.boss);

const [render] = await db
  .select()
  .from(renders)
  .where(and(eq(renders.briefId, briefId), eq(renders.status, "done")));
const draftPosts = await db.select().from(posts).where(eq(posts.briefId, briefId));
const [finalBrief] = await db.select().from(briefs).where(eq(briefs.id, briefId));

console.log("\n── result ──");
console.log(`brief ${briefId} → ${finalBrief?.status}`);
console.log(
  `render: ${render?.width}x${render?.height} · ${Number(render?.durationSec).toFixed(1)}s · ${((render?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB → ${render?.r2Key}`,
);
console.log(`posts drafts: ${draftPosts.map((p) => p.platform).join(", ")}`);
console.log(`queued next: ${c.sent.map((s) => s.name).join(" → ")}`);

// seed an active music trend so the radar_only 422 can be curled live (doc 05 §7)
const musicRows = await db.select().from(categories).where(eq(categories.slug, "music"));
const music = musicRows[0];
let musicTrendId = "";
if (music) {
  musicTrendId = newId();
  await db.insert(trends).values({
    id: musicTrendId,
    categoryId: music.id,
    status: "active",
    headline: "Chart-topping single breaks records (music is radar-only)",
    summary: "intelligence only",
    rightsClass: "red",
    llmScore: 95,
    emotions: [],
  });
}

console.log("\n── curl it (with bun run dev up) ──");
console.log(`TOKEN="change-me-to-a-long-random-token"`);
console.log(`curl -s -H "authorization: Bearer $TOKEN" localhost:3000/api/v1/briefs/${briefId}`);
console.log(
  `curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\\n  -d '{"trendId":"${musicTrendId}","formatSlug":"faceless-explainer-60s","targetPlatforms":["tiktok"],"angle":"music brief attempts must be rejected with 422"}' \\\n  localhost:3000/api/v1/briefs   # expect 422 radar_only`,
);
process.exit(0);

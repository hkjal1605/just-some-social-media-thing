#!/usr/bin/env bun
import { clusterHandler } from "../apps/workers/src/engines/radar/cluster";
import { setRadarDeps } from "../apps/workers/src/engines/radar/deps";
import { buildDigestMarkdown, gatherDigestData } from "../apps/workers/src/engines/radar/digest";
import { editorTickForCategory } from "../apps/workers/src/engines/radar/editor";
import { offlineRadarDeps } from "../apps/workers/src/engines/radar/offline";
import { scoreHandler } from "../apps/workers/src/engines/radar/score";
import { scoutSource } from "../apps/workers/src/engines/radar/scouts";
import type { Enqueuer } from "../apps/workers/src/harness";
import { RadarClusterPayload, RadarScorePayload } from "../packages/core/src";
// Radar demo: runs the REAL doc-04 pipeline end to end against the dev database
// with fixture connectors (zero platform credentials) and offline LLM deps (zero
// API keys): scout → score → cluster → editor-in-chief → digest.
// Usage: bun run scripts/radar-demo.ts   (then curl /api/v1/trends)
import {
  and,
  categories,
  db,
  eq,
  runMigrations,
  seed,
  sources,
  topTrends,
} from "../packages/db/src";

function collector() {
  const sent: { name: string; data: object }[] = [];
  const boss: Enqueuer = {
    send: async (name, data) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      return "demo";
    },
  };
  return { boss, sent };
}

console.log("── radar demo: migrate + seed ──");
await runMigrations();
await seed();
setRadarDeps(offlineRadarDeps);

const [aiTech] = await db.select().from(categories).where(eq(categories.slug, "ai-tech"));
if (!aiTech) throw new Error("ai-tech category missing after seed");

// 1 · scouts across every ai-tech source (fixture mode: no credentials configured)
const srcRows = await db
  .select()
  .from(sources)
  .where(and(eq(sources.categoryId, aiTech.id), eq(sources.active, true)));
const scout = collector();
const allTouched: string[] = [];
for (const s of srcRows) {
  const touched = await scoutSource(s.id, scout.boss);
  allTouched.push(...touched);
  console.log(`scouted ${s.platform}/${s.kind} ${s.value} → ${touched.length} items`);
}

// 2 · score the whole batch (Layer A + offline rubric)
const score = collector();
await scoreHandler(
  RadarScorePayload.parse({ categoryId: aiTech.id, rawItemIds: [...new Set(allTouched)] }),
  score.boss,
);

// 3 · cluster into trends
for (const send of score.sent.filter((s) => s.name === "radar.cluster")) {
  const outcome = await clusterHandler(RadarClusterPayload.parse(send.data));
  console.log(`cluster: created ${outcome.created}, attached ${outcome.attached}`);
}

// 4 · editor-in-chief creates briefs (offline editor briefs the top candidate)
const editor = collector();
const decision = await editorTickForCategory(aiTech, editor.boss);
console.log(`editor: briefed ${decision.briefed}, skipped ${decision.skipped}`);
console.log(
  "factory.script enqueued:",
  editor.sent.filter((s) => s.name === "factory.script").length,
);

// 5 · digest markdown (telegram send no-ops without a token — print it here)
const digest = buildDigestMarkdown(await gatherDigestData());
console.log("\n── digest preview ──\n");
console.log(digest);

const trends = await topTrends({ categoryId: aiTech.id, limit: 10 });
console.log("\n── top trends now in DB ──");
for (const t of trends) {
  console.log(`  [${t.rightsClass}] ${t.llmScore} ${t.headline} (${t.memberCount} members)`);
}
console.log("\ndemo done — curl the API:  GET /api/v1/trends?category=ai-tech");
process.exit(0);

// Factory end-to-end against real Postgres + real ffmpeg (doc 05 §7 acceptance):
// seeded fake trend → script (guard passes) → compliance → 3 assets → ≥61s 1080×1920
// captioned render + thumbnail → posts drafts — fully offline. Plus: engineered
// plagiarism gets blocked, and the clipping pipeline runs source → candidates → cut.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  briefAssetsDoneKey,
  CADENCE_CAPS_DEFAULT,
  FactoryCompliancePayload,
  newId,
  type ScriptOut,
} from "@ve/core";
import {
  and,
  assets,
  briefs,
  categories,
  clipCandidates,
  complianceChecks,
  db,
  eq,
  getSetting,
  longForms,
  posts,
  rawItems,
  renders,
  runMigrations,
  scripts,
  seed,
  sql,
  sqlClient,
  trends,
} from "@ve/db";
import { cleanup, ffmpegAvailable, runFfmpeg, tmpDir } from "@ve/media";
import { getObjectBytes, putFile, r2Key } from "@ve/storage";
import type PgBoss from "pg-boss";
import { captionsHandler, ttsHandler, visualsHandler } from "../src/engines/factory/assets";
import {
  clipAnalyzeHandler,
  clipTranscribeHandler,
  promoteClipCandidate,
} from "../src/engines/factory/clips";
import { complianceHandler } from "../src/engines/factory/compliance";
import { type factoryDeps, setFactoryDeps } from "../src/engines/factory/deps";
import { offlineFactoryDeps, offlineScriptOut } from "../src/engines/factory/offline";
import { renderHandler } from "../src/engines/factory/render";
import { scriptHandler } from "../src/engines/factory/scriptwriter";
import { offlineEmbed } from "../src/engines/radar/offline";
import type { Enqueuer } from "../src/harness";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const haveFfmpeg = await ffmpegAvailable();
const ready = reachable && haveFfmpeg;
const t = ready ? test : test.skip;
if (!ready) console.warn("factory.integration: postgres/ffmpeg unavailable — suite skipped");

if (ready) {
  await runMigrations();
  await seed();
  setFactoryDeps(offlineFactoryDeps);
}

const run = newId().slice(-8);
const testStart = new Date();

interface Sent {
  name: string;
  data: object;
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

async function makeCategory(slug: string, mode = "full_auto_candidate") {
  const id = newId();
  await db.insert(categories).values({
    id,
    slug,
    name: slug,
    mode,
    autoApproveFormats: [],
    cadenceCaps: CADENCE_CAPS_DEFAULT,
  });
  return id;
}

async function makeTrendWithMember(categoryId: string, memberText: string) {
  const [embedding] = await offlineEmbed([memberText]);
  const itemId = newId();
  await db.insert(rawItems).values({
    id: itemId,
    platform: "reddit",
    externalId: `t3_fx_${run}_${itemId.slice(-10)}`,
    categoryId,
    url: `https://example.com/${itemId}`,
    title: memberText.slice(0, 80),
    text: memberText,
    publishedAt: new Date(),
    embedding,
  });
  const trendId = newId();
  await db.insert(trends).values({
    id: trendId,
    categoryId,
    status: "active",
    headline: "Fake seeded trend for factory gate",
    summary: "Open models crossed a cost threshold; builders are switching stacks.",
    rightsClass: "green",
    llmScore: 88,
    emotions: ["curiosity"],
    longevity: "days",
  });
  await db.update(rawItems).set({ trendId }).where(eq(rawItems.id, itemId));
  return { trendId, itemId };
}

async function makeBrief(
  categoryId: string,
  trendId: string | null,
  formatSlug: string,
  platforms: string[],
) {
  const id = newId();
  await db.insert(briefs).values({
    id,
    trendId,
    categoryId,
    originKind: "trend",
    status: "draft",
    angle: "The real monthly cost of running frontier-class models at home, in three setups",
    formatSlug,
    targetPlatforms: platforms,
  });
  return id;
}

const MEMBER_TEXT =
  "Open-source 32B model beats frontier labs on agentic benchmarks — weights on HF. Benchmarks in the paper: SWE-bench verified 74%, TAU-bench 81%. Runs on a single 4090 quantized.";

describe("factory happy path (doc 05 §7 gate)", () => {
  t(
    "trend → script → compliance → 3 assets → ≥61s 1080×1920 captioned render → posts drafts",
    async () => {
      const categoryId = await makeCategory(`fact-${run}`);
      const { trendId } = await makeTrendWithMember(categoryId, MEMBER_TEXT);
      const briefId = await makeBrief(categoryId, trendId, "faceless-explainer-60s", ["tiktok"]);

      // 1 · scriptwriter: passes the similarity guard, brief → scripted
      const boss = stubBoss();
      const scriptResult = await scriptHandler({ briefId }, boss);
      expect(scriptResult.blocked).toBe(false);
      const [script] = await db.select().from(scripts).where(eq(scripts.briefId, briefId));
      if (!script) throw new Error("script missing");
      expect((script.similarityReport as { pass: boolean }).pass).toBe(true);
      expect((script.sceneVisuals as unknown[]).length).toBe(3);
      const [briefAfterScript] = await db.select().from(briefs).where(eq(briefs.id, briefId));
      expect(briefAfterScript?.status).toBe("scripted");
      expect(boss.sent.some((s) => s.name === "factory.compliance")).toBe(true);

      // 2 · compliance pre_render: passes, fans out tts + visuals, brief → producing
      const compliance = await complianceHandler(
        FactoryCompliancePayload.parse({ briefId, stage: "pre_render" }),
        boss,
      );
      expect(compliance.pass).toBe(true);
      expect(boss.sent.some((s) => s.name === "factory.tts")).toBe(true);
      expect(boss.sent.some((s) => s.name === "factory.visuals")).toBe(true);

      // 3 · assets: tts (≥61s tone) → captions; visuals resolve stock + ai-image
      const assetBoss = stubBoss();
      await ttsHandler({ briefId, scriptId: script.id }, assetBoss);
      await captionsHandler({ briefId, scriptId: script.id }, assetBoss);
      const visualsResult = await visualsHandler({ briefId, scriptId: script.id }, assetBoss);
      expect(visualsResult.blocked).toBe(false);

      const assetRows = await db.select().from(assets).where(eq(assets.briefId, briefId));
      const kinds = new Set(assetRows.map((a) => a.kind));
      expect(kinds.has("tts_audio")).toBe(true);
      expect(kinds.has("captions_ass")).toBe(true);
      expect(assetRows.filter((a) => ["image", "broll_video"].includes(a.kind)).length).toBe(3);
      for (const a of assetRows) expect(a.licenseRef).not.toBeNull();

      // completion counter fired factory.render exactly once (doc 05 §3)
      const renderSends = assetBoss.sent.filter((s) => s.name === "factory.render");
      expect(renderSends.length).toBe(1);
      expect(
        await getSetting<{ tts: boolean; visuals: boolean; captions: boolean }>(
          briefAssetsDoneKey(briefId),
        ),
      ).toEqual({ tts: true, visuals: true, captions: true });

      // 4 · render: real ffmpeg — ≥61s, 1080×1920, thumbnail, bytes recorded
      const renderBoss = stubBoss();
      const rendered = await renderHandler({ briefId }, renderBoss);
      expect(rendered.rendered).toBe(1);
      const [render] = await db
        .select()
        .from(renders)
        .where(and(eq(renders.briefId, briefId), eq(renders.status, "done")));
      if (!render) throw new Error("render missing");
      expect(Number(render.durationSec)).toBeGreaterThanOrEqual(61);
      expect(render.width).toBe(1080);
      expect(render.height).toBe(1920);
      expect(render.bytes ?? 0).toBeGreaterThan(100_000);
      expect((await getObjectBytes(render.r2Key ?? "")).byteLength).toBeGreaterThan(100_000);
      expect((await getObjectBytes(render.thumbR2Key ?? "")).byteLength).toBeGreaterThan(1_000);

      // 5 · posts drafts + pre_publish gate → approval.request
      const draftRows = await db.select().from(posts).where(eq(posts.briefId, briefId));
      expect(draftRows.length).toBe(1);
      expect(draftRows[0]?.status).toBe("draft");
      expect(draftRows[0]?.renderId).toBe(render.id);
      expect(renderBoss.sent.some((s) => s.name === "factory.compliance")).toBe(true);

      const publishGate = await complianceHandler(
        FactoryCompliancePayload.parse({ briefId, stage: "pre_publish" }),
        renderBoss,
      );
      expect(publishGate.pass).toBe(true);
      expect(renderBoss.sent.some((s) => s.name === "approval.request")).toBe(true);
      const [readyBrief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
      expect(readyBrief?.status).toBe("ready");

      const gateRows = await db
        .select()
        .from(complianceChecks)
        .where(eq(complianceChecks.briefId, briefId));
      expect(gateRows.filter((g) => g.stage === "pre_render" && g.pass).length).toBe(1);
      expect(gateRows.filter((g) => g.stage === "pre_publish" && g.pass).length).toBe(1);

      // 6 · cost ledger: every step metered, full short ≤ $1.00 (doc 05 §6)
      const spend = (await db.execute(sql`
        select coalesce(sum(cost_usd), 0)::float as total, count(*)::int as rows
        from llm_usage where at >= ${testStart.toISOString()}::timestamptz
          and purpose in ('scriptwriter', 'tts', 'transcribe', 'scene-image')
      `)) as unknown as { total: number; rows: number }[];
      expect(spend[0]?.rows ?? 0).toBeGreaterThanOrEqual(4);
      expect(spend[0]?.total ?? 99).toBeLessThan(1.0);
    },
    600_000,
  );

  t(
    "engineered plagiarism → one rewrite → brief blocked with similarity fail (doc 05 §7)",
    async () => {
      const categoryId = await makeCategory(`fact-plag-${run}`);
      const { trendId } = await makeTrendWithMember(categoryId, MEMBER_TEXT);
      const briefId = await makeBrief(categoryId, trendId, "faceless-explainer-60s", ["tiktok"]);

      // scriptwriter that echoes the source verbatim — the guard must catch it in code
      let calls = 0;
      setFactoryDeps({
        runStructured: (async <T>(opts: { schema: { parse: (v: unknown) => T } }): Promise<T> => {
          calls++;
          const out: ScriptOut = {
            ...offlineScriptOut({ angle: "echo" }),
            body: `[SCENE 1] ${MEMBER_TEXT}`,
          };
          return opts.schema.parse(out);
        }) as typeof factoryDeps.runStructured,
      });
      try {
        const boss = stubBoss();
        const result = await scriptHandler({ briefId }, boss);
        expect(result.blocked).toBe(true);
        expect(calls).toBe(2); // initial + one automatic rewrite (doc 05 §1)
        const [blocked] = await db.select().from(briefs).where(eq(briefs.id, briefId));
        expect(blocked?.status).toBe("blocked");
        expect(blocked?.blockedReason).toBe("similarity");
        const [script] = await db.select().from(scripts).where(eq(scripts.briefId, briefId));
        expect((script?.similarityReport as { pass: boolean } | null)?.pass).toBe(false);
        expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(true);
        expect(boss.sent.some((s) => s.name === "factory.compliance")).toBe(false);
      } finally {
        setFactoryDeps(offlineFactoryDeps);
      }
    },
  );

  t("screen-demo scene with no demo upload → blocked needs-demo (doc 05 §3)", async () => {
    const categoryId = await makeCategory(`fact-demo-${run}`);
    const briefId = await makeBrief(categoryId, null, "demo-screencast", ["tiktok"]);
    await db.update(briefs).set({ status: "producing" }).where(eq(briefs.id, briefId));
    const scriptId = newId();
    await db.insert(scripts).values({
      id: scriptId,
      briefId,
      version: 1,
      hookVariants: [{ id: "a", text: "hook" }],
      body: "[SCENE 1] demo narration",
      sceneCount: 1,
      estDurationSec: 60,
      perPlatformCaptions: {},
      sceneVisuals: [{ scene: 1, want: "screen-demo" }],
    });
    const boss = stubBoss();
    const result = await visualsHandler({ briefId, scriptId }, boss);
    expect(result.blocked).toBe(true);
    const [blocked] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe("needs-demo");
    expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(true);

    // recovery (M10): the human uploads a demo (source_video, meta.demo=true) — re-running visuals
    // now resolves it and no longer blocks (the previously dead-end touchpoint)
    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
    await db.insert(assets).values({
      id: newId(),
      briefId,
      kind: "source_video",
      r2Key: `assets/${briefId}/demo.mp4`,
      mime: "video/mp4",
      meta: { demo: true, categorySlug: cat?.slug ?? "" },
      licenseRef: "own-recording",
    });
    await db.update(briefs).set({ status: "producing" }).where(eq(briefs.id, briefId));
    const recovered = await visualsHandler({ briefId, scriptId }, stubBoss());
    expect(recovered.blocked).toBe(false);
  });

  t(
    "edit re-script (v2) clears v1 assets/renders/posts so the change reaches the render (H4a)",
    async () => {
      const categoryId = await makeCategory(`fact-edit-${run}`);
      const { trendId } = await makeTrendWithMember(categoryId, MEMBER_TEXT);
      const briefId = await makeBrief(categoryId, trendId, "faceless-explainer-60s", ["tiktok"]);

      // v1 script + simulated v1 production artifacts (asset, render, post, done-counter)
      const boss = stubBoss();
      await scriptHandler({ briefId }, boss);
      const [v1] = await db.select().from(scripts).where(eq(scripts.briefId, briefId));
      if (!v1) throw new Error("v1 script missing");
      const renderId = newId();
      await db.insert(assets).values({
        id: newId(),
        briefId,
        kind: "tts_audio",
        r2Key: `assets/${briefId}/a.mp3`,
        mime: "audio/mpeg",
        licenseRef: "ai-gen:tts",
      });
      await db
        .insert(renders)
        .values({ id: renderId, briefId, scriptId: v1.id, platform: "tiktok", status: "done" });
      await db.insert(posts).values({
        id: newId(),
        briefId,
        categoryId,
        renderId,
        platform: "tiktok",
        status: "draft",
      });
      await db.update(briefs).set({ status: "ready" }).where(eq(briefs.id, briefId));

      // edit-requested re-script → v2
      const editBoss = stubBoss();
      const res = await scriptHandler(
        { briefId, editInstructions: "punchier hook, drop scene 2" },
        editBoss,
      );
      expect(res.blocked).toBe(false);

      const scriptRows = await db.select().from(scripts).where(eq(scripts.briefId, briefId));
      expect(scriptRows.length).toBe(2); // v2 written
      // v1's stale artifacts are gone, so the fan-out regenerates from v2 (no reused render)
      expect((await db.select().from(assets).where(eq(assets.briefId, briefId))).length).toBe(0);
      expect((await db.select().from(renders).where(eq(renders.briefId, briefId))).length).toBe(0);
      expect((await db.select().from(posts).where(eq(posts.briefId, briefId))).length).toBe(0);
      expect(editBoss.sent.some((s) => s.name === "factory.compliance")).toBe(true);
    },
  );
});

describe("clipping pipeline (doc 05 §5)", () => {
  t(
    "long-form → transcribe → analyze → promote → cut render with transcript captions",
    async () => {
      const categoryId = await makeCategory(`fact-clip-${run}`);

      // 30s 16:9 source with audio, uploaded as an own long-form
      const dir = await tmpDir("clip-src");
      const longFormId = newId();
      try {
        const src = join(dir, "source.mp4");
        await runFfmpeg([
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=640x360:rate=24:duration=30",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=300:duration=30",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          src,
        ]);
        await putFile(r2Key.longformSource(longFormId), src, "video/mp4");
      } finally {
        await cleanup(dir);
      }
      await db.insert(longForms).values({
        id: longFormId,
        categoryId,
        title: `own weekly long-form ${run}`,
        r2Key: r2Key.longformSource(longFormId),
        status: "uploaded",
      });

      const boss = stubBoss();
      const transcribed = await clipTranscribeHandler({ kind: "longform", id: longFormId }, boss);
      expect(transcribed.durationSec).toBeGreaterThan(29);
      expect(boss.sent.some((s) => s.name === "clip.analyze")).toBe(true);
      const [afterTranscribe] = await db
        .select()
        .from(longForms)
        .where(eq(longForms.id, longFormId));
      expect(afterTranscribe?.status).toBe("transcribed");
      expect(afterTranscribe?.transcriptR2Key).toBe(r2Key.longformTranscript(longFormId));

      const analyzed = await clipAnalyzeHandler({ kind: "longform", id: longFormId });
      expect(analyzed.candidates).toBeGreaterThanOrEqual(1);
      const candidates = await db
        .select()
        .from(clipCandidates)
        .where(eq(clipCandidates.longFormId, longFormId));
      const candidate = candidates[0];
      if (!candidate) throw new Error("no clip candidates");
      expect(Number(candidate.endSec) - Number(candidate.startSec)).toBeGreaterThanOrEqual(20);

      // promote → clip brief; scriptwriter uses the transcript slice as body, guard skipped
      const promoted = await promoteClipCandidate(candidate.id, ["tiktok"], boss);
      if (!promoted) throw new Error("promote returned null — source unexpectedly missing");
      const scriptResult = await scriptHandler({ briefId: promoted.briefId }, boss);
      expect(scriptResult.blocked).toBe(false);
      const [clipScript] = await db
        .select()
        .from(scripts)
        .where(eq(scripts.briefId, promoted.briefId));
      expect(clipScript?.body).toBe(candidate.transcriptSlice ?? "");
      expect((clipScript?.similarityReport as { pass: boolean } | null)?.pass).toBe(true);

      // compliance pre_render routes clip briefs straight to render (no tts/visuals)
      const gateBoss = stubBoss();
      const gate = await complianceHandler(
        FactoryCompliancePayload.parse({ briefId: promoted.briefId, stage: "pre_render" }),
        gateBoss,
      );
      expect(gate.pass).toBe(true);
      expect(gateBoss.sent.some((s) => s.name === "factory.render")).toBe(true);
      expect(gateBoss.sent.some((s) => s.name === "factory.tts")).toBe(false);

      const rendered = await renderHandler({ briefId: promoted.briefId }, gateBoss);
      expect(rendered.rendered).toBe(1);
      const [render] = await db
        .select()
        .from(renders)
        .where(and(eq(renders.briefId, promoted.briefId), eq(renders.status, "done")));
      if (!render) throw new Error("clip render missing");
      const len = Number(candidate.endSec) - Number(candidate.startSec);
      expect(Math.abs(Number(render.durationSec) - len)).toBeLessThan(1.5);
      expect(render.width).toBe(1080);
      expect(render.height).toBe(1920);

      const clipPosts = await db.select().from(posts).where(eq(posts.briefId, promoted.briefId));
      expect(clipPosts.length).toBe(1);
    },
    300_000,
  );
});

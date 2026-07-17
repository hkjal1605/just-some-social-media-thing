// Factory API routes (doc 11 subset for doc 05): brief creation rails incl. the
// music-422 acceptance, lineage view, long-form ingest + clip promotion.
import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { CADENCE_CAPS_DEFAULT, newId } from "@ve/core";
import {
  briefs,
  categories,
  clipCandidates,
  db,
  eq,
  longForms,
  runMigrations,
  seed,
  sqlClient,
  trends,
} from "@ve/db";
import { app } from "../src/app";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("factory-api.test: postgres unreachable — suite skipped");

if (reachable) {
  await runMigrations();
  await seed();
}

const run = newId().slice(-8);
const bearer = {
  authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
  "content-type": "application/json",
};

async function makeTrend(categoryId: string, rightsClass = "green") {
  const id = newId();
  await db.insert(trends).values({
    id,
    categoryId,
    status: "active",
    headline: `factory api trend ${run} ${id.slice(-6)}`,
    summary: "s",
    rightsClass,
    llmScore: 90,
    emotions: [],
  });
  return id;
}

describe("POST /briefs rails (doc 05 §7 acceptance)", () => {
  t("music (radar_only) brief attempt → 422, no brief row", async () => {
    const [music] = await db.select().from(categories).where(eq(categories.slug, "music"));
    if (!music) throw new Error("music category missing");
    const trendId = await makeTrend(music.id);
    const res = await app.request("/api/v1/briefs", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        trendId,
        formatSlug: "faceless-explainer-60s",
        targetPlatforms: ["tiktok"],
        angle: "this must never be created because music is radar-only",
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("radar_only");
    const rows = await db.select().from(briefs).where(eq(briefs.categoryId, music.id));
    expect(rows.length).toBe(0);
  });

  t("green trend → 201, trend transitions to briefed, lineage endpoint shows it", async () => {
    const catId = newId();
    await db.insert(categories).values({
      id: catId,
      slug: `fapi-${run}`,
      name: "fapi",
      mode: "full_auto_candidate",
      autoApproveFormats: [],
      cadenceCaps: CADENCE_CAPS_DEFAULT,
    });
    const trendId = await makeTrend(catId);
    const res = await app.request("/api/v1/briefs", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        trendId,
        formatSlug: "faceless-explainer-60s",
        targetPlatforms: ["tiktok", "youtube", "reddit"], // reddit gets filtered by format
        angle: "a legitimate original angle for the factory api test",
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [trend] = await db.select().from(trends).where(eq(trends.id, trendId));
    expect(trend?.status).toBe("briefed");
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, id));
    expect(brief?.targetPlatforms).toEqual(["tiktok", "youtube"]);

    const lineage = await app.request(`/api/v1/briefs/${id}`, { headers: bearer });
    expect(lineage.status).toBe(200);
    const body = (await lineage.json()) as {
      brief: { id: string };
      scripts: unknown[];
      assets: unknown[];
      renders: unknown[];
      compliance: unknown[];
      posts: unknown[];
    };
    expect(body.brief.id).toBe(id);
    expect(Array.isArray(body.scripts)).toBe(true);

    // double-brief the same trend → no longer active → 422
    const again = await app.request("/api/v1/briefs", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        trendId,
        formatSlug: "faceless-explainer-60s",
        targetPlatforms: ["tiktok"],
        angle: "second brief on the same trend must fail",
      }),
    });
    expect(again.status).toBe(422);
  });

  t("red trend → 422; amber trend requires commentary format", async () => {
    const catId = newId();
    await db.insert(categories).values({
      id: catId,
      slug: `fapi-rights-${run}`,
      name: "fapi rights",
      mode: "human_gated",
      autoApproveFormats: [],
      cadenceCaps: CADENCE_CAPS_DEFAULT,
    });
    const redTrend = await makeTrend(catId, "red");
    const redRes = await app.request("/api/v1/briefs", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        trendId: redTrend,
        formatSlug: "x-thread",
        targetPlatforms: ["x"],
        angle: "red trends are intelligence only and must 422",
      }),
    });
    expect(redRes.status).toBe(422);

    const amberTrend = await makeTrend(catId, "amber");
    const badFormat = await app.request("/api/v1/briefs", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        trendId: amberTrend,
        formatSlug: "clip-vertical",
        targetPlatforms: ["tiktok"],
        angle: "amber with a non-commentary format must 422",
      }),
    });
    expect(badFormat.status).toBe(422);

    const okFormat = await app.request("/api/v1/briefs", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        trendId: amberTrend,
        formatSlug: "x-thread",
        targetPlatforms: ["x"],
        angle: "amber with commentary format is allowed",
      }),
    });
    expect(okFormat.status).toBe(201);
  });
});

describe("long-forms + clip candidates API", () => {
  t("create → ingest → detail → promote", async () => {
    const catId = newId();
    await db.insert(categories).values({
      id: catId,
      slug: `fapi-lf-${run}`,
      name: "lf",
      mode: "full_auto_candidate",
      autoApproveFormats: [],
      cadenceCaps: CADENCE_CAPS_DEFAULT,
    });

    const created = await app.request("/api/v1/longforms", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ title: `api long-form ${run}`, categoryId: catId }),
    });
    expect(created.status).toBe(201);
    const { id, presignedPut } = (await created.json()) as { id: string; presignedPut: string };
    expect(presignedPut.length).toBeGreaterThan(0);

    const ingest = await app.request(`/api/v1/longforms/${id}/ingest`, {
      method: "POST",
      headers: bearer,
    });
    expect(ingest.status).toBe(200); // enqueues clip.transcribe via lazy send-only boss

    // simulate the analyzer having produced a candidate, then promote it via the API
    const candidateId = newId();
    await db.insert(clipCandidates).values({
      id: candidateId,
      longFormId: id,
      startSec: "2.00",
      endSec: "26.00",
      hookScore: 80,
      selfContainedScore: 75,
      emotionScore: 70,
      transcriptSlice: "a self-contained moment from our own long-form",
    });
    const detail = await app.request(`/api/v1/longforms/${id}`, { headers: bearer });
    const detailBody = (await detail.json()) as { candidates: { id: string }[] };
    expect(detailBody.candidates.some((c) => c.id === candidateId)).toBe(true);

    const promoted = await app.request(`/api/v1/clip-candidates/${candidateId}/promote`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ targetPlatforms: ["tiktok"] }),
    });
    expect(promoted.status).toBe(201);
    const { id: briefId } = (await promoted.json()) as { id: string };
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(brief?.originKind).toBe("longform_clip");
    expect(brief?.formatSlug).toBe("clip-vertical");
    const [lf] = await db.select().from(longForms).where(eq(longForms.id, id));
    expect(lf?.status).toBe("clipped");

    // idempotent re-promote returns the same brief
    const again = await app.request(`/api/v1/clip-candidates/${candidateId}/promote`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ targetPlatforms: ["tiktok"] }),
    });
    expect(((await again.json()) as { id: string }).id).toBe(briefId);
  });

  t(
    "campaign source: upload → ingest → candidate promotes to a campaign_clip brief (H9)",
    async () => {
      const catId = newId();
      await db.insert(categories).values({
        id: catId,
        slug: `fapi-camp-${run}`,
        name: "camp",
        mode: "full_auto_candidate",
        autoApproveFormats: [],
        cadenceCaps: CADENCE_CAPS_DEFAULT,
      });
      const campCreate = await app.request("/api/v1/campaigns", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ name: `camp ${run}`, categoryId: catId }),
      });
      expect(campCreate.status).toBe(201);
      const { id: campaignId } = (await campCreate.json()) as { id: string };

      // presign a source PUT, then ingest → clip.transcribe (both previously missing)
      const source = await app.request(`/api/v1/campaigns/${campaignId}/source`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ mime: "video/mp4" }),
      });
      expect(source.status).toBe(200);
      expect(
        ((await source.json()) as { presignedPut: string }).presignedPut.length,
      ).toBeGreaterThan(0);

      const ingest = await app.request(`/api/v1/campaigns/${campaignId}/ingest`, {
        method: "POST",
        headers: bearer,
      });
      expect(ingest.status).toBe(200);

      // a campaign-origin candidate must promote (category resolved via campaigns.categoryId) —
      // this returned 422 no_category before the fix
      const candidateId = newId();
      await db.insert(clipCandidates).values({
        id: candidateId,
        campaignId,
        startSec: "1.00",
        endSec: "25.00",
        hookScore: 82,
        selfContainedScore: 78,
        emotionScore: 71,
        transcriptSlice: "a licensed sponsor moment",
      });
      const promoted = await app.request(`/api/v1/clip-candidates/${candidateId}/promote`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ targetPlatforms: ["tiktok"] }),
      });
      expect(promoted.status).toBe(201);
      const { id: briefId } = (await promoted.json()) as { id: string };
      const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
      expect(brief?.originKind).toBe("campaign_clip");
      expect(brief?.categoryId).toBe(catId);
      expect(brief?.campaignId).toBe(campaignId);
    },
  );
});

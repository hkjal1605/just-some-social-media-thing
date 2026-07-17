// Playbooks + Costs + Campaigns API (doc 11 §3, doc 10 §3.6/§3.7/§3.8).
import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { CADENCE_CAPS_DEFAULT, newId } from "@ve/core";
import {
  briefs,
  campaignClips,
  categories,
  db,
  eq,
  playbookVersions,
  posts,
  runMigrations,
  seed,
  sqlClient,
} from "@ve/db";
import { app } from "../src/app";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("misc-api.test: postgres unreachable — suite skipped");
if (reachable) {
  await runMigrations();
  await seed();
}

const run = newId().slice(-8);
const bearer = {
  authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
  "content-type": "application/json",
};
let n = 0;

async function makeCategory() {
  const id = newId();
  await db.insert(categories).values({
    id,
    slug: `misc-${run}-${n++}`,
    name: "misc cat",
    mode: "full_auto_candidate",
    autoApproveFormats: [],
    cadenceCaps: CADENCE_CAPS_DEFAULT,
  });
  return id;
}

describe("playbooks (doc 07 §3, doc 10 §3.7)", () => {
  t("lists versions, diffs v2 vs v1, approves the draft", async () => {
    const catId = await makeCategory();
    await db.insert(playbookVersions).values({
      id: newId(),
      categoryId: catId,
      version: 1,
      markdown: "# Voice\n- calm\n# Hooks\n- open on a number",
      createdBy: "human",
      approvedAt: new Date(),
    });
    const v2Id = newId();
    await db.insert(playbookVersions).values({
      id: v2Id,
      categoryId: catId,
      version: 2,
      markdown: "# Voice\n- calm\n# Hooks\n- lead with a stat",
      changeSummary: "hook tweak",
      createdBy: "system",
      approvedAt: null,
    });

    const list = await app.request(`/api/v1/playbooks?category=${catId}`, { headers: bearer });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(2);

    const diff = await app.request(`/api/v1/playbooks/${v2Id}/diff`, { headers: bearer });
    expect(diff.status).toBe(200);
    const d = (await diff.json()) as {
      previous: { version: number } | null;
      diff: { type: string; text: string }[];
    };
    expect(d.previous?.version).toBe(1);
    expect(d.diff.some((l) => l.type === "add" && l.text.includes("lead with a stat"))).toBe(true);
    expect(d.diff.some((l) => l.type === "del" && l.text.includes("open on a number"))).toBe(true);

    const approve = await app.request(`/api/v1/playbooks/${v2Id}/approve`, {
      method: "POST",
      headers: bearer,
    });
    expect(approve.status).toBe(200);
    const [v2] = await db.select().from(playbookVersions).where(eq(playbookVersions.id, v2Id));
    expect(v2?.approvedAt).not.toBeNull();
  });
});

describe("costs (doc 10 §3.8)", () => {
  t("returns services, agents, revenue, and budget for a month", async () => {
    const res = await app.request("/api/v1/costs", { headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      month: string;
      services: unknown[];
      agents: unknown[];
      revenue: { campaigns: number; platform: number; total: number };
      spend: number;
    };
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(Array.isArray(body.services)).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(typeof body.revenue.total).toBe("number");
    expect(typeof body.spend).toBe("number");
  });
});

describe("campaigns (doc 05 §5, doc 10 §3.6)", () => {
  t("create → list → detail → patch → clip payout", async () => {
    const created = await app.request("/api/v1/campaigns", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: `Whop ${run}`, ratePer1k: 1.5, budgetUsd: 500 }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const list = await app.request("/api/v1/campaigns", { headers: bearer });
    expect(
      ((await list.json()) as { items: { id: string }[] }).items.some((x) => x.id === id),
    ).toBe(true);

    // a published post + campaign clip for the detail + payout flow
    const catId = await makeCategory();
    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      categoryId: catId,
      originKind: "campaign_clip",
      campaignId: id,
      status: "ready",
      angle: "clip",
      formatSlug: "clip-vertical",
      targetPlatforms: ["tiktok"],
    });
    const postId = newId();
    await db.insert(posts).values({
      id: postId,
      briefId,
      categoryId: catId,
      platform: "tiktok",
      status: "published",
      publishedAt: new Date(),
      permalink: "https://tiktok.com/@x/video/1",
    });
    const clipId = newId();
    await db.insert(campaignClips).values({ id: clipId, campaignId: id, postId });

    const detail = await app.request(`/api/v1/campaigns/${id}`, { headers: bearer });
    expect(detail.status).toBe(200);
    const det = (await detail.json()) as { campaign: { id: string }; clips: { id: string }[] };
    expect(det.campaign.id).toBe(id);
    expect(det.clips.some((cl) => cl.id === clipId)).toBe(true);

    const patch = await app.request(`/api/v1/campaigns/${id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(200);

    const payout = await app.request(`/api/v1/campaign-clips/${clipId}`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        submittedUrl: "https://whop.com/sub/1",
        payoutUsd: 42.5,
        markPaid: true,
      }),
    });
    expect(payout.status).toBe(200);
    const [clip] = await db.select().from(campaignClips).where(eq(campaignClips.id, clipId));
    expect(Number(clip?.payoutUsd)).toBe(42.5);
    expect(clip?.payoutAt).not.toBeNull();
  });
});

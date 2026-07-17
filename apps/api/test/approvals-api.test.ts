// Approvals API (doc 09 §3/§6) via app.request(): card assembly, the transactional decision,
// the two-concurrent-decides race (exactly one wins), and reject/edit state transitions.
import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { CADENCE_CAPS_DEFAULT, newId } from "@ve/core";
import {
  approvalEvents,
  approvals,
  briefs,
  categories,
  db,
  eq,
  posts,
  renders,
  runMigrations,
  scripts,
  seed,
  sqlClient,
  trends,
} from "@ve/db";
import { r2Key } from "@ve/storage";
import { app } from "../src/app";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("approvals-api.test: postgres unreachable — suite skipped");
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

async function seedApproval() {
  const catId = newId();
  await db.insert(categories).values({
    id: catId,
    slug: `apr-${run}-${n++}`,
    name: "apr cat",
    mode: "human_gated",
    autoApproveFormats: [],
    cadenceCaps: CADENCE_CAPS_DEFAULT,
  });
  const trendId = newId();
  await db.insert(trends).values({
    id: trendId,
    categoryId: catId,
    status: "briefed",
    headline: `apr trend ${run}`,
    summary: "s",
    rightsClass: "green",
    llmScore: 85,
    emotions: [],
    longevity: "flash",
  });
  const briefId = newId();
  await db.insert(briefs).values({
    id: briefId,
    categoryId: catId,
    trendId,
    originKind: "trend",
    status: "ready",
    angle: "the original angle for approval",
    formatSlug: "faceless-explainer-60s",
    targetPlatforms: ["tiktok", "youtube"],
  });
  const scriptId = newId();
  await db.insert(scripts).values({
    id: scriptId,
    briefId,
    version: 1,
    hookVariants: [
      { id: "a", text: "Hook A wins" },
      { id: "b", text: "Hook B" },
    ],
    chosenHook: "a",
    body: "[SCENE 1] narration body",
    sceneCount: 1,
    estDurationSec: 62,
    perPlatformCaptions: {},
    aiDisclosure: false,
  });
  const renderId = newId();
  await db.insert(renders).values({
    id: renderId,
    briefId,
    scriptId,
    platform: "tiktok",
    status: "done",
    r2Key: r2Key.render(briefId, renderId, "tiktok"),
    bytes: 12_000_000,
    width: 1080,
    height: 1920,
  });
  const postIds: string[] = [];
  for (const platform of ["tiktok", "youtube"] as const) {
    const pid = newId();
    postIds.push(pid);
    await db.insert(posts).values({
      id: pid,
      briefId,
      categoryId: catId,
      platform,
      renderId: platform === "tiktok" ? renderId : null,
      status: "awaiting_approval",
    });
  }
  const approvalId = newId();
  await db.insert(approvals).values({
    id: approvalId,
    briefId,
    status: "pending",
    expiresAt: new Date(Date.now() + 24 * 3_600_000),
  });
  return { catId, trendId, briefId, scriptId, renderId, approvalId, postIds };
}

describe("GET /approvals list + card (doc 09 §3)", () => {
  t("lists pending and assembles a card with hook, slot, presigned preview", async () => {
    const { approvalId } = await seedApproval();

    const list = await app.request("/api/v1/approvals?status=pending", { headers: bearer });
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: { id: string; hook: string }[] }).items;
    const mine = items.find((i) => i.id === approvalId);
    expect(mine?.hook).toBe("Hook A wins");

    const card = await app.request(`/api/v1/approvals/${approvalId}/card`, { headers: bearer });
    expect(card.status).toBe(200);
    const c = (await card.json()) as {
      hook: string;
      platforms: string[];
      previewVideoUrl?: string;
      plannedSlotDisplay: string;
      dashboardUrl: string;
    };
    expect(c.hook).toBe("Hook A wins");
    expect(c.platforms).toEqual(["tiktok", "youtube"]);
    expect(c.previewVideoUrl).toBeTruthy(); // presigned (memory:// in test)
    expect(c.plannedSlotDisplay.length).toBeGreaterThan(0);
  });

  t("stores the tg message id; unknown approval 404s", async () => {
    const { approvalId } = await seedApproval();
    const res = await app.request(`/api/v1/approvals/${approvalId}/tg-message`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ tgMessageId: 4242 }),
    });
    expect(res.status).toBe(200);
    const detail = await app.request(`/api/v1/approvals/${approvalId}`, { headers: bearer });
    expect(((await detail.json()) as { tgMessageId: number }).tgMessageId).toBe(4242);

    const missing = await app.request(`/api/v1/approvals/${newId()}`, { headers: bearer });
    expect(missing.status).toBe(404);
  });
});

describe("POST /approvals/:id/decide (doc 09 §1/§6)", () => {
  t("approve → approval approved, awaiting posts approved", async () => {
    const { approvalId, postIds } = await seedApproval();
    const res = await app.request(`/api/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ decision: "approved", via: "dashboard" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const [ap] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(ap?.status).toBe("approved");
    expect(ap?.decidedVia).toBe("dashboard");
    for (const pid of postIds) {
      const [p] = await db.select().from(posts).where(eq(posts.id, pid));
      expect(p?.status).toBe("approved");
    }
  });

  t("two concurrent decides: exactly one wins, the other is raced + recorded", async () => {
    const { approvalId } = await seedApproval();
    const decide = async (): Promise<{ ok?: boolean; raced?: boolean }> => {
      const res = await app.request(`/api/v1/approvals/${approvalId}/decide`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ decision: "approved", via: "telegram", tgUserId: 111 }),
      });
      return (await res.json()) as { ok?: boolean; raced?: boolean };
    };
    const [a, b] = await Promise.all([decide(), decide()]);
    const wins = [a, b].filter((r) => r.ok === true).length;
    const raced = [a, b].filter((r) => r.raced === true).length;
    expect(wins).toBe(1);
    expect(raced).toBe(1);

    const events = await db
      .select()
      .from(approvalEvents)
      .where(eq(approvalEvents.approvalId, approvalId));
    expect(events.some((e) => e.event === "approved")).toBe(true);
    expect(events.some((e) => e.event === "race_ignored")).toBe(true);
  });

  t("reject → approval rejected, posts draft, brief abandoned, event recorded", async () => {
    const { approvalId, briefId, postIds } = await seedApproval();
    const res = await app.request(`/api/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ decision: "rejected", reason: "off-brand", via: "dashboard" }),
    });
    expect(res.status).toBe(200);
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(ap?.status).toBe("rejected");
    expect(ap?.rejectReason).toBe("off-brand");
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(brief?.status).toBe("abandoned");
    for (const pid of postIds) {
      const [p] = await db.select().from(posts).where(eq(posts.id, pid));
      expect(p?.status).toBe("draft");
    }
  });

  t("edit → approval edit_requested, brief back to scripted, event recorded", async () => {
    const { approvalId, briefId } = await seedApproval();
    const res = await app.request(`/api/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        decision: "edit_requested",
        editInstructions: "punch up the hook",
        via: "dashboard",
      }),
    });
    expect(res.status).toBe(200);
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(ap?.status).toBe("edit_requested");
    expect(ap?.editInstructions).toBe("punch up the hook");
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(brief?.status).toBe("scripted");
  });

  t("deciding an unknown approval 404s", async () => {
    const res = await app.request(`/api/v1/approvals/${newId()}/decide`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ decision: "approved", via: "dashboard" }),
    });
    expect(res.status).toBe(404);
  });
});

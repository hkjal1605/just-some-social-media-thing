// approval.request bridge integration (doc 09 §1 worker) against real Postgres:
// auto-approve fast-path vs human-gated parking, idempotency, and the radar_only/human_gated
// code guards that must never auto-approve.
import { describe, expect, test } from "bun:test";
import { CADENCE_CAPS_DEFAULT, newId } from "@ve/core";
import {
  approvalEvents,
  approvals,
  briefs,
  categories,
  db,
  eq,
  posts,
  seed,
  sqlClient,
} from "@ve/db";
import type PgBoss from "pg-boss";
import { approvalRequestHandler, shouldAutoApprove } from "../src/engines/approvals/request";
import type { Enqueuer } from "../src/harness";
import { need } from "./helpers";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("approvals.test: postgres unavailable — suite skipped");
if (reachable) await seed();

const run = newId().slice(-8);

interface Sent {
  name: string;
  data: Record<string, unknown>;
}
function stubBoss(): Enqueuer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (name: string, data: object, _o?: PgBoss.SendOptions) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      return newId();
    },
  };
}

async function makeCategory(mode: string, autoApproveFormats: string[] = []) {
  const id = newId();
  const slug = `apr-${mode}-${run}-${id.slice(-4)}`;
  await db.insert(categories).values({
    id,
    slug,
    name: slug,
    mode,
    autoApproveFormats,
    cadenceCaps: CADENCE_CAPS_DEFAULT,
  });
  return { id, slug };
}

async function makeBriefWithPosts(categoryId: string, formatSlug: string, platforms: string[]) {
  const briefId = newId();
  await db.insert(briefs).values({
    id: briefId,
    categoryId,
    originKind: "trend",
    status: "ready",
    angle: "an original angle",
    formatSlug,
    targetPlatforms: platforms,
  });
  for (const platform of platforms) {
    await db.insert(posts).values({
      id: newId(),
      briefId,
      categoryId,
      platform,
      status: "draft",
    });
  }
  return briefId;
}

describe("approval.request (doc 09 §1 worker)", () => {
  t(
    "full_auto_candidate + earned format → auto_approved, posts approved, publish.plan fast-path",
    async () => {
      const cat = await makeCategory("full_auto_candidate", ["faceless-explainer-60s"]);
      const briefId = await makeBriefWithPosts(cat.id, "faceless-explainer-60s", [
        "tiktok",
        "youtube",
      ]);
      const boss = stubBoss();

      const res = await approvalRequestHandler({ briefId }, boss);
      expect(res.outcome).toBe("auto_approved");

      const [approval] = await db.select().from(approvals).where(eq(approvals.briefId, briefId));
      expect(approval?.status).toBe("auto_approved");
      expect(approval?.decidedVia).toBe("auto");

      const postRows = await db.select().from(posts).where(eq(posts.briefId, briefId));
      expect(postRows.every((p) => p.status === "approved")).toBe(true);

      const fastPath = boss.sent.find((s) => s.name === "publish.plan");
      expect(fastPath?.data.fastPathBriefId).toBe(briefId);

      const events = await db
        .select()
        .from(approvalEvents)
        .where(eq(approvalEvents.approvalId, need(approval).id));
      expect(events.some((e) => e.event === "created")).toBe(true);
      expect(events.some((e) => e.event === "approved")).toBe(true);
    },
  );

  t(
    "human_gated category → pending approval, posts awaiting_approval, no auto-schedule",
    async () => {
      const cat = await makeCategory("human_gated", ["faceless-explainer-60s"]); // earned format is ignored
      const briefId = await makeBriefWithPosts(cat.id, "faceless-explainer-60s", ["tiktok"]);
      const boss = stubBoss();

      const res = await approvalRequestHandler({ briefId }, boss);
      expect(res.outcome).toBe("pending");

      const [approval] = await db.select().from(approvals).where(eq(approvals.briefId, briefId));
      expect(approval?.status).toBe("pending");
      expect(approval?.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const postRows = await db.select().from(posts).where(eq(posts.briefId, briefId));
      expect(postRows.every((p) => p.status === "awaiting_approval")).toBe(true);
      expect(boss.sent.some((s) => s.name === "publish.plan")).toBe(false);
      // the notification is now the interactive approval CARD pushed via @ve/telegram (H12), which
      // no-ops without a bot token in tests — so no alert.telegram is enqueued on the happy path.
      expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(false);
    },
  );

  t("second call is idempotent (no duplicate approval)", async () => {
    const cat = await makeCategory("full_auto_candidate", ["faceless-explainer-60s"]);
    const briefId = await makeBriefWithPosts(cat.id, "faceless-explainer-60s", ["tiktok"]);
    const boss = stubBoss();
    await approvalRequestHandler({ briefId }, boss);
    const second = await approvalRequestHandler({ briefId }, boss);
    expect(second.outcome).toBe("skipped");
    const rows = await db.select().from(approvals).where(eq(approvals.briefId, briefId));
    expect(rows.length).toBe(1);
  });

  test("shouldAutoApprove: only full_auto_candidate + earned format (unit)", () => {
    const base = { mode: "full_auto_candidate", autoApproveFormats: ["x-thread"] } as never;
    expect(shouldAutoApprove(base, "x-thread")).toBe(true);
    expect(shouldAutoApprove(base, "faceless-explainer-60s")).toBe(false);
    expect(
      shouldAutoApprove(
        { mode: "human_gated", autoApproveFormats: ["x-thread"] } as never,
        "x-thread",
      ),
    ).toBe(false);
    expect(
      shouldAutoApprove(
        { mode: "radar_only", autoApproveFormats: ["x-thread"] } as never,
        "x-thread",
      ),
    ).toBe(false);
  });
});

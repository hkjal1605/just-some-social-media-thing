// Harness ops integration (doc 08 §7/§8, §3 approval.remind) against real Postgres + in-memory R2.
// costs.rollup: budget warn/kill crossings flip the kill-switch + alert, baseline recompute runs,
// reddit raw-items past TTL are pruned. policy.watch: baseline → material change → unchanged →
// blocked, with the differ mocked at the @ve/llm boundary. approval.remind: remind, expire→abandon,
// and renew-once for a still-hot trend.
import { describe, expect, test } from "bun:test";
import {
  APPROVAL_TTL_HOURS,
  BUDGET_STATE_SETTING_KEY,
  BudgetStateSchema,
  newId,
  REDDIT_RAW_ITEM_RETENTION_DAYS,
} from "@ve/core";
import {
  approvalEvents,
  approvals,
  briefs,
  categories,
  costsByServiceMonth,
  db,
  eq,
  getSetting,
  itemSnapshots,
  policyPages,
  rawItems,
  recordApiUsage,
  seed,
  setSetting,
  sqlClient,
  trends,
} from "@ve/db";
import { approvalRemindHandler } from "../src/engines/approvals/remind";
import {
  costsRollupHandler,
  pruneRedditRawItems,
  recomputeAllBaselines,
  utcMonth,
} from "../src/engines/ops/costs-rollup";
import type { OpsDeps } from "../src/engines/ops/deps";
import { checkPolicyPage, policyWatchHandler } from "../src/engines/ops/policy-watch";
import { baselineKey } from "../src/engines/radar/baseline";
import type { Enqueuer } from "../src/harness";
import { need } from "./helpers";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("ops.integration: postgres unavailable — suite skipped");
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
    send: async (name, data) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      return newId();
    },
  };
}

async function currentMonthSpend(now: Date): Promise<number> {
  const { services } = await costsByServiceMonth(utcMonth(now));
  return services.reduce((sum, s) => sum + s.costUsd, 0);
}

// ── costs.rollup (doc 08 §7) ─────────────────────────────────────────────────

describe("costs.rollup budget guard (doc 08 §7)", () => {
  t("≥80% (not 100%) warns once, does not flip the kill-switch", async () => {
    await setSetting("kill_switch", false);
    await setSetting(BUDGET_STATE_SETTING_KEY, { monthUsd: 0 }); // legacy shape ⇒ fresh markers
    await recordApiUsage({
      service: "ayrshare",
      endpoint: `ops-warn-${run}`,
      units: 1,
      costUsd: 3,
    });

    const now = new Date();
    const budgetUsd = (await currentMonthSpend(now)) / 0.85; // → ratio ≈ 0.85
    const boss = stubBoss();
    const r = await costsRollupHandler(boss, { now, budgetUsd });

    expect(r.warned).toBe(true);
    expect(r.killed).toBe(false);
    expect(r.level).toBe("warn");
    expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(true);
    expect(await getSetting<boolean>("kill_switch")).not.toBe(true);

    // idempotent within the month: second run doesn't re-warn
    const r2 = await costsRollupHandler(boss, { now, budgetUsd });
    expect(r2.warned).toBe(false);
  });

  t("≥100% flips the kill-switch once with a budget alert, then never re-kills", async () => {
    await setSetting("kill_switch", false);
    await setSetting(BUDGET_STATE_SETTING_KEY, { monthUsd: 0 });
    await recordApiUsage({
      service: "ayrshare",
      endpoint: `ops-kill-${run}`,
      units: 1,
      costUsd: 5,
    });

    const boss = stubBoss();
    const r = await costsRollupHandler(boss, { budgetUsd: 0.01 }); // tiny budget ⇒ ratio ≫ 100%
    expect(r.killed).toBe(true);
    expect(r.level).toBe("kill");
    expect(await getSetting<boolean>("kill_switch")).toBe(true);
    expect(
      boss.sent.some(
        (s) => s.name === "alert.telegram" && /kill-switch/i.test(String(s.data.text)),
      ),
    ).toBe(true);

    // budget_state persisted with a killedAt marker
    const state = BudgetStateSchema.parse(await getSetting(BUDGET_STATE_SETTING_KEY));
    expect(state.level).toBe("kill");
    expect(state.killedAt).not.toBeNull();

    // second run within the same month must not re-kill (once-per-month)
    const boss2 = stubBoss();
    const r2 = await costsRollupHandler(boss2, { budgetUsd: 0.01 });
    expect(r2.killed).toBe(false);
    expect(boss2.sent.some((s) => /kill-switch/i.test(String(s.data.text)))).toBe(false);

    await setSetting("kill_switch", false); // restore — shared DB across suites
  });

  t("recomputes every active category × platform baseline", async () => {
    const n = await recomputeAllBaselines();
    const active = await db.select().from(categories).where(eq(categories.active, true));
    expect(n).toBe(active.length * 4);
    // a concrete baseline setting exists for a seeded category
    const [ai] = await db.select().from(categories).where(eq(categories.slug, "ai-tech"));
    expect(await getSetting(baselineKey(need(ai).id, "reddit"))).not.toBeNull();
  });

  t("prunes reddit raw_items past the TTL; snapshots cascade; recent items survive", async () => {
    const [ai] = await db.select().from(categories).where(eq(categories.slug, "ai-tech"));
    const catId = need(ai).id;
    const now = new Date();
    const oldId = newId();
    const freshId = newId();
    const oldSeen = new Date(now.getTime() - (REDDIT_RAW_ITEM_RETENTION_DAYS + 10) * 86_400_000);
    await db.insert(rawItems).values({
      id: oldId,
      platform: "reddit",
      externalId: `t3_old_${run}`,
      categoryId: catId,
      url: "https://reddit.com/old",
      firstSeenAt: oldSeen,
    });
    await db.insert(itemSnapshots).values({ id: newId(), rawItemId: oldId, views: 10 });
    await db.insert(rawItems).values({
      id: freshId,
      platform: "reddit",
      externalId: `t3_fresh_${run}`,
      categoryId: catId,
      url: "https://reddit.com/fresh",
      firstSeenAt: now,
    });

    const pruned = await pruneRedditRawItems(now);
    expect(pruned).toBeGreaterThanOrEqual(1);

    expect((await db.select().from(rawItems).where(eq(rawItems.id, oldId))).length).toBe(0);
    expect(
      (await db.select().from(itemSnapshots).where(eq(itemSnapshots.rawItemId, oldId))).length,
    ).toBe(0);
    expect((await db.select().from(rawItems).where(eq(rawItems.id, freshId))).length).toBe(1);
  });
});

// ── policy.watch (doc 08 §8) ─────────────────────────────────────────────────

function policyDeps(over: {
  fetchText?: string;
  fetchOk?: boolean;
  fetchStatus?: number;
  material?: boolean;
  summary?: string;
}): OpsDeps {
  return {
    fetchPolicy: async () => ({
      ok: over.fetchOk ?? true,
      status: over.fetchStatus ?? 200,
      text: over.fetchText ?? "",
    }),
    runStructured: (async (opts: { schema: { parse: (v: unknown) => unknown } }) =>
      opts.schema.parse({
        hasMaterialChange: over.material ?? true,
        summary: over.summary ?? "Rewards now require 61s minimum",
        impact: "Shorts must exceed 61s",
      })) as never,
  };
}

async function makePolicyPage(): Promise<typeof policyPages.$inferSelect> {
  const id = newId();
  await db.insert(policyPages).values({
    id,
    name: `Test Policy ${run}`,
    url: `https://example.test/policy/${id}`,
  });
  const [row] = await db.select().from(policyPages).where(eq(policyPages.id, id));
  return need(row);
}

describe("policy.watch (doc 08 §8)", () => {
  t("baseline → material change → unchanged, with alert only on the material change", async () => {
    const page = await makePolicyPage();
    const boss = stubBoss();

    // 1 · first sighting = baseline, no alert
    const r1 = await checkPolicyPage(
      page,
      boss,
      policyDeps({ fetchText: "<h1>Creator Rewards</h1><p>Post regularly.</p>" }),
    );
    expect(r1.status).toBe("baseline");
    expect(boss.sent.length).toBe(0);
    const [after1] = await db.select().from(policyPages).where(eq(policyPages.id, page.id));
    expect(need(after1).lastHash).not.toBeNull();

    // 2 · content changed materially → differ fires + alert
    const r2 = await checkPolicyPage(
      need(after1),
      boss,
      policyDeps({
        fetchText: "<h1>Creator Rewards</h1><p>Now requires 61 seconds.</p>",
        material: true,
        summary: "Minimum length raised to 61s",
      }),
    );
    expect(r2.status).toBe("changed");
    expect(r2.summary).toBe("Minimum length raised to 61s");
    expect(
      boss.sent.some((s) => s.name === "alert.telegram" && /changed/.test(String(s.data.text))),
    ).toBe(true);
    const [after2] = await db.select().from(policyPages).where(eq(policyPages.id, page.id));
    expect(need(after2).lastDiffSummary).toBe("Minimum length raised to 61s");
    expect(need(after2).lastChangedAt).not.toBeNull();

    // 3 · same content again → unchanged, no differ, no alert
    const boss3 = stubBoss();
    const r3 = await checkPolicyPage(
      need(after2),
      boss3,
      policyDeps({ fetchText: "<h1>Creator Rewards</h1><p>Now requires 61 seconds.</p>" }),
    );
    expect(r3.status).toBe("unchanged");
    expect(boss3.sent.length).toBe(0);
  });

  t("a changed-but-cosmetic diff updates state without alerting", async () => {
    const page = await makePolicyPage();
    const boss = stubBoss();
    await checkPolicyPage(page, boss, policyDeps({ fetchText: "<p>original text</p>" }));
    const [afterBase] = await db.select().from(policyPages).where(eq(policyPages.id, page.id));

    const r = await checkPolicyPage(
      need(afterBase),
      boss,
      policyDeps({
        fetchText: "<p>original text reformatted</p>",
        material: false,
        summary: "cosmetic only",
      }),
    );
    expect(r.status).toBe("cosmetic");
    expect(boss.sent.some((s) => s.name === "alert.telegram")).toBe(false);
  });

  t("a blocked fetch is marked fetch_blocked and never calls the differ", async () => {
    const page = await makePolicyPage();
    const boss = stubBoss();
    let differCalls = 0;
    const deps: OpsDeps = {
      fetchPolicy: async () => ({ ok: false, status: 403, text: "" }),
      runStructured: (async () => {
        differCalls++;
        return {};
      }) as never,
    };
    const r = await checkPolicyPage(page, boss, deps);
    expect(r.status).toBe("blocked");
    expect(differCalls).toBe(0);
    const [after] = await db.select().from(policyPages).where(eq(policyPages.id, page.id));
    expect(need(after).lastDiffSummary).toContain("fetch_blocked");
  });

  t("policyWatchHandler sweeps all pages and sends one blocked-summary alert", async () => {
    const boss = stubBoss();
    // stub every fetch as blocked → all rows (seeded + test) report blocked
    const deps: OpsDeps = {
      fetchPolicy: async () => ({ ok: false, status: 503, text: "" }),
      runStructured: (async () => ({})) as never,
    };
    const res = await policyWatchHandler(boss, deps);
    const total = (await db.select().from(policyPages)).length;
    expect(res.checked).toBe(total);
    expect(res.blocked).toBeGreaterThanOrEqual(1);
    expect(boss.sent.some((s) => s.data.key === "policy-watch-blocked")).toBe(true);
  });
});

// ── approval.remind (doc 08 §3 cron; doc 09 §1) ──────────────────────────────

async function makeApproval(opts: {
  expiresAt: Date;
  briefStatus?: "ready" | "draft";
  withTrend?: "hot" | "cold" | "none";
}): Promise<{ approvalId: string; briefId: string; trendId?: string }> {
  const [ai] = await db.select().from(categories).where(eq(categories.slug, "ai-tech"));
  const catId = need(ai).id;
  let trendId: string | undefined;
  if (opts.withTrend && opts.withTrend !== "none") {
    trendId = newId();
    await db.insert(trends).values({
      id: trendId,
      categoryId: catId,
      status: opts.withTrend === "hot" ? "active" : "expired",
      headline: `remind trend ${run}`,
      summary: "s",
      rightsClass: "green",
      llmScore: opts.withTrend === "hot" ? 90 : 40,
      emotions: [],
    });
  }
  const briefId = newId();
  await db.insert(briefs).values({
    id: briefId,
    categoryId: catId,
    ...(trendId ? { trendId } : {}),
    originKind: "trend",
    status: opts.briefStatus ?? "ready",
    angle: "angle",
    formatSlug: "faceless-explainer-60s",
    targetPlatforms: ["tiktok"],
  });
  const approvalId = newId();
  await db.insert(approvals).values({
    id: approvalId,
    briefId,
    status: "pending",
    expiresAt: opts.expiresAt,
  });
  const p: { approvalId: string; briefId: string; trendId?: string } = { approvalId, briefId };
  if (trendId) p.trendId = trendId;
  return p;
}

async function eventsFor(approvalId: string): Promise<string[]> {
  const evs = await db
    .select()
    .from(approvalEvents)
    .where(eq(approvalEvents.approvalId, approvalId));
  return evs.map((e) => e.event);
}

describe("approval.remind (doc 08 §3, doc 09 §1)", () => {
  t("nudges a pending approval once inside the 4h window", async () => {
    const now = new Date();
    const { approvalId } = await makeApproval({
      expiresAt: new Date(now.getTime() + 2 * 3_600_000), // 2h left
    });
    const first = await approvalRemindHandler({}, stubBoss(), now);
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    expect(await eventsFor(approvalId)).toContain("reminded");

    // second sweep at the same time → already reminded, no repeat for this approval
    const remindedBefore = (await eventsFor(approvalId)).filter((e) => e === "reminded").length;
    await approvalRemindHandler({}, stubBoss(), now);
    const remindedAfter = (await eventsFor(approvalId)).filter((e) => e === "reminded").length;
    expect(remindedAfter).toBe(remindedBefore);
  });

  t("expires a past-TTL approval with a cold trend and abandons its brief", async () => {
    const now = new Date();
    const { approvalId, briefId } = await makeApproval({
      expiresAt: new Date(now.getTime() - 3_600_000), // 1h past TTL
      withTrend: "cold",
    });
    await approvalRemindHandler({}, stubBoss(), now);
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [br] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(need(ap).status).toBe("expired");
    expect(need(br).status).toBe("abandoned");
    expect(await eventsFor(approvalId)).toContain("expired");
  });

  t("renews a hot trend's approval once, then expires it on the next TTL", async () => {
    const now = new Date();
    const { approvalId, briefId } = await makeApproval({
      expiresAt: new Date(now.getTime() - 3_600_000), // past TTL
      withTrend: "hot",
    });

    // renew: back to pending with a fresh 24h expiry
    await approvalRemindHandler({}, stubBoss(), now);
    const [renewed] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(need(renewed).status).toBe("pending");
    expect(await eventsFor(approvalId)).toContain("renewed");
    expect(need(renewed).expiresAt.getTime()).toBeGreaterThan(now.getTime());

    // advance past the renewed TTL → renew-once means it now expires
    const later = new Date(now.getTime() + (APPROVAL_TTL_HOURS + 1) * 3_600_000);
    await approvalRemindHandler({}, stubBoss(), later);
    const [expired] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(need(expired).status).toBe("expired");
    const [br] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(need(br).status).toBe("abandoned");
  });
});

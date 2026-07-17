// doc 09 §5: a pre_publish compliance failure revokes any earned auto-approval for the pair.
import { describe, expect, test } from "bun:test";
import { FactoryCompliancePayload, newId } from "@ve/core";
import { briefs, categories, db, eq, scripts, seed, sqlClient, trends } from "@ve/db";
import { complianceHandler } from "../src/engines/factory/compliance";
import type { Enqueuer } from "../src/harness";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("compliance-revoke.test: postgres unavailable — suite skipped");
if (reachable) await seed();

const run = newId().slice(-8);
function stubBoss(): Enqueuer & { sent: { name: string; data: Record<string, unknown> }[] } {
  const sent: { name: string; data: Record<string, unknown> }[] = [];
  return {
    sent,
    send: async (name, data) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      return newId();
    },
  };
}

describe("compliance pre_publish revoke (doc 09 §5)", () => {
  t("a failing pre_publish gate revokes the earned auto-approval + alerts", async () => {
    const catId = newId();
    const format = "faceless-explainer-60s";
    await db.insert(categories).values({
      id: catId,
      slug: `revoke-${run}`,
      name: "revoke cat",
      mode: "full_auto_candidate",
      autoApproveFormats: [format], // earned auto-approval that the failure must revoke
      cadenceCaps: { tiktok: 2, youtube: 1, x: 5, reddit: 1 },
    });
    // a RED trend makes the rights check fail at pre_publish (doc 05 §2)
    const trendId = newId();
    await db.insert(trends).values({
      id: trendId,
      categoryId: catId,
      status: "briefed",
      headline: "red trend",
      summary: "s",
      rightsClass: "red",
      llmScore: 90,
      emotions: [],
    });
    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      categoryId: catId,
      trendId,
      originKind: "trend",
      status: "producing", // pre_publish runs after render; producing → blocked is valid
      angle: "angle",
      formatSlug: format,
      targetPlatforms: ["tiktok"],
    });
    await db.insert(scripts).values({
      id: newId(),
      briefId,
      version: 1,
      hookVariants: [{ id: "a", text: "hook" }],
      chosenHook: "a",
      body: "[SCENE 1] body",
      sceneCount: 1,
      estDurationSec: 62,
      perPlatformCaptions: {},
      aiDisclosure: false,
    });

    const boss = stubBoss();
    const res = await complianceHandler(
      FactoryCompliancePayload.parse({ briefId, stage: "pre_publish" }),
      boss,
    );
    expect(res.pass).toBe(false);

    const [cat] = await db.select().from(categories).where(eq(categories.id, catId));
    expect(((cat?.autoApproveFormats ?? []) as string[]).includes(format)).toBe(false);
    expect(boss.sent.some((s) => /auto-approve revoked/.test(String(s.data.text)))).toBe(true);

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId));
    expect(brief?.status).toBe("blocked");
  });
});

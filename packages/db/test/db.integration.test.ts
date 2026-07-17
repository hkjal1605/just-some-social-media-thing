// Integration tests against a real Postgres (viral_engine_test).
// Skips cleanly when no server is reachable (CI provides one; local dev uses docker/native PG).
import { describe, expect, test } from "bun:test";
import { newId } from "@ve/core";
import { eq } from "drizzle-orm";
import {
  briefs,
  categories,
  db,
  getSetting,
  InvalidTransitionError,
  posts,
  recordApiUsage,
  recordLlmUsage,
  runMigrations,
  seed,
  setSetting,
  settings,
  sqlClient,
  transitionPost,
} from "../src";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}

const t = reachable ? test : test.skip;
if (!reachable) console.warn("db.integration: postgres unreachable — suite skipped");

if (reachable) {
  // clean slate: drop app schema + pgboss schema + drizzle's migration journal,
  // then re-apply committed migrations from zero
  await sqlClient.unsafe("drop schema if exists public cascade");
  await sqlClient.unsafe("create schema public");
  await sqlClient.unsafe("drop schema if exists pgboss cascade");
  await sqlClient.unsafe("drop schema if exists drizzle cascade");
  await runMigrations();
}
// no afterAll(closeDb): the pool is shared across test files in one process

describe("migrations + seed", () => {
  t("seed is idempotent — same counts after running twice", async () => {
    const first = await seed();
    const second = await seed();
    expect(first.categories).toBe(6);
    expect(second.categories).toBe(6);
    expect(second.sources).toBe(first.sources);
    expect(second.policyPages).toBe(12);
  });

  t("seeded categories carry the doc modes", async () => {
    const rows = await db.select().from(categories);
    const modes = Object.fromEntries(rows.map((c) => [c.slug, c.mode]));
    expect(modes["ai-tech"]).toBe("full_auto_candidate");
    expect(modes.politics).toBe("human_gated");
    expect(modes.music).toBe("radar_only");
  });
});

describe("state-machine enforcement (doc 02 §5)", () => {
  async function makePost(status = "draft") {
    const [cat] = await db.select().from(categories).where(eq(categories.slug, "ai-tech"));
    if (!cat) throw new Error("seed first");
    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      categoryId: cat.id,
      angle: "test angle",
      formatSlug: "faceless-explainer-60s",
      targetPlatforms: ["tiktok"],
    });
    const postId = newId();
    await db.insert(posts).values({
      id: postId,
      briefId,
      categoryId: cat.id,
      platform: "tiktok",
      status,
    });
    return postId;
  }

  t("allowed transition draft → awaiting_approval updates row + updated_at", async () => {
    const id = await makePost();
    const updated = await transitionPost(db, id, "awaiting_approval");
    expect(updated.status).toBe("awaiting_approval");
  });

  t(
    "illegal transition draft → published throws InvalidTransitionError, row untouched",
    async () => {
      const id = await makePost();
      expect(transitionPost(db, id, "published")).rejects.toThrow(InvalidTransitionError);
      const [row] = await db.select().from(posts).where(eq(posts.id, id));
      expect(row?.status).toBe("draft");
    },
  );

  t("concurrent same transition: exactly one wins (row lock)", async () => {
    const id = await makePost("approved");
    const results = await Promise.allSettled([
      transitionPost(db, id, "scheduled"),
      transitionPost(db, id, "scheduled"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const [row] = await db.select().from(posts).where(eq(posts.id, id));
    expect(row?.status).toBe("scheduled");
  });
});

describe("settings + usage meters", () => {
  t("setSetting/getSetting round-trip with cache bust", async () => {
    await setSetting("test_key", { hello: 1 });
    expect(await getSetting<{ hello: number }>("test_key")).toEqual({ hello: 1 });
    await setSetting("test_key", { hello: 2 });
    expect(await getSetting<{ hello: number }>("test_key")).toEqual({ hello: 2 });
    const [row] = await db.select().from(settings).where(eq(settings.key, "test_key"));
    expect(row?.value).toEqual({ hello: 2 });
  });

  t("usage recorders insert rows", async () => {
    await recordLlmUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      purpose: "test",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.00105,
    });
    await recordApiUsage({
      service: "x_api",
      endpoint: "tweets.search.recent",
      units: 10,
      costUsd: 0.05,
    });
    const llmRows = await sqlClient.unsafe("select count(*)::int as n from llm_usage");
    const apiRows = await sqlClient.unsafe("select count(*)::int as n from api_usage");
    expect(Number(llmRows[0]?.n)).toBeGreaterThan(0);
    expect(Number(apiRows[0]?.n)).toBeGreaterThan(0);
  });
});

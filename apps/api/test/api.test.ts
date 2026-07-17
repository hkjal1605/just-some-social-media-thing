// API routes via in-process app.request() (doc 13 §2) — auth + the trends inventory.
import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { CADENCE_CAPS_DEFAULT, newId } from "@ve/core";
import {
  categories,
  db,
  eq,
  rawItems,
  runMigrations,
  seed,
  sqlClient,
  trendMembers,
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
if (!reachable) console.warn("api.test: postgres unreachable — suite skipped");

if (reachable) {
  await runMigrations();
  await seed();
}
// NOTE: no afterAll(closeDb) — the postgres pool is module-shared across every test
// file in the bun test process; closing it here would kill later suites.

const run = newId().slice(-8);
const bearer = { authorization: `Bearer ${env.ADMIN_API_TOKEN}` };

let fixtureN = 0;
async function seedTrendFixture() {
  const n = fixtureN++;
  const slug = `api-test-${run}-${n}`;
  const catId = newId();
  await db.insert(categories).values({
    id: catId,
    slug,
    name: "api test",
    mode: "full_auto_candidate",
    autoApproveFormats: [],
    cadenceCaps: CADENCE_CAPS_DEFAULT,
  });
  const itemId = newId();
  await db.insert(rawItems).values({
    id: itemId,
    platform: "reddit",
    externalId: `t3_api_${run}_${n}`,
    categoryId: catId,
    url: "https://reddit.com/r/test/api",
    title: "api fixture item",
    publishedAt: new Date(),
  });
  const trendId = newId();
  await db.insert(trends).values({
    id: trendId,
    categoryId: catId,
    status: "active",
    headline: `API test trend ${run}`,
    summary: "summary",
    rightsClass: "green",
    llmScore: 91,
    emotions: ["curiosity"],
  });
  await db.insert(trendMembers).values({ trendId, rawItemId: itemId, similarity: "1.0000" });
  await db.update(rawItems).set({ trendId }).where(eq(rawItems.id, itemId));
  return { catId, trendId, slug };
}

describe("auth", () => {
  t("unauthenticated /api/v1/trends → 401", async () => {
    const res = await app.request("/api/v1/trends");
    expect(res.status).toBe(401);
  });

  t("wrong password → 401; correct login → session cookie → /auth/me", async () => {
    const bad = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);

    const ok = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: env.DASHBOARD_ADMIN_PASSWORD }),
    });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ve_session=");

    const me = await app.request("/api/v1/auth/me", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { username: string }).username).toBe("admin");
  });

  t("bearer token works for bot/workers/CLI (doc 11 §2)", async () => {
    const res = await app.request("/api/v1/ping", { headers: bearer });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { admin: string }).admin).toBe("api-token");
  });
});

describe("GET /trends (doc 11 §3, doc 13 Phase 1)", () => {
  t("lists trends filtered by category slug", async () => {
    const { trendId, slug } = await seedTrendFixture();
    const res = await app.request(`/api/v1/trends?category=${slug}`, { headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; headline: string; memberCount: number }[];
    };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.id).toBe(trendId);
    expect(body.items[0]?.memberCount).toBe(1);
  });

  t("unknown category → 404; unknown trend detail → 404", async () => {
    const notFound = await app.request("/api/v1/trends?category=nope-does-not-exist", {
      headers: bearer,
    });
    expect(notFound.status).toBe(404);
    const detail404 = await app.request(`/api/v1/trends/${newId()}`, { headers: bearer });
    expect(detail404.status).toBe(404);
  });

  t("detail returns trend + members + series", async () => {
    const { trendId } = await seedTrendFixture();
    const res = await app.request(`/api/v1/trends/${trendId}`, { headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trend: { id: string; headline: string };
      members: { url: string }[];
      series: unknown[];
    };
    expect(body.trend.id).toBe(trendId);
    expect(body.members.length).toBe(1);
    expect(body.members[0]?.url).toContain("reddit.com");
    expect(Array.isArray(body.series)).toBe(true);
  });

  t("suppress transitions once, then 422 (state machine holds at the API)", async () => {
    const { trendId, slug } = await seedTrendFixture();
    const first = await app.request(`/api/v1/trends/${trendId}/suppress`, {
      method: "POST",
      headers: bearer,
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { trend: { status: string } }).trend.status).toBe("suppressed");

    const second = await app.request(`/api/v1/trends/${trendId}/suppress`, {
      method: "POST",
      headers: bearer,
    });
    expect(second.status).toBe(422);

    // suppressed trends stay visible under their status filter (intelligence, doc 10 §3.2)
    const list = await app.request(`/api/v1/trends?status=suppressed&category=${slug}`, {
      headers: bearer,
    });
    const items = ((await list.json()) as { items: { id: string }[] }).items;
    expect(items.some((i) => i.id === trendId)).toBe(true);
  });
});

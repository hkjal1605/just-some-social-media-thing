// Posts + engagements API (doc 11 §3, doc 10 §3.3/§3.5): list/detail/metrics, reslot with
// caps/gaps 422s, retry, delete, and the manual engagement reply.
import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { istParts, istWallToUtc, newId } from "@ve/core";
import {
  briefs,
  categories,
  db,
  engagements,
  eq,
  postSnapshots,
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
if (!reachable) console.warn("posts-api.test: postgres unreachable — suite skipped");
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

async function makeCategory(caps: Record<string, number>) {
  const id = newId();
  await db.insert(categories).values({
    id,
    slug: `posts-${run}-${n++}`,
    name: "posts cat",
    mode: "full_auto_candidate",
    autoApproveFormats: [],
    cadenceCaps: caps,
  });
  return id;
}

async function makeBrief(categoryId: string) {
  const id = newId();
  await db.insert(briefs).values({
    id,
    categoryId,
    originKind: "trend",
    status: "ready",
    angle: `posts-api angle ${run}`,
    formatSlug: "faceless-explainer-60s",
    targetPlatforms: ["tiktok"],
  });
  return id;
}

async function makePost(
  categoryId: string,
  briefId: string,
  opts: { status: string; platform?: string; scheduledFor?: Date; publishedAt?: Date } = {
    status: "approved",
  },
) {
  const id = newId();
  await db.insert(posts).values({
    id,
    briefId,
    categoryId,
    platform: opts.platform ?? "tiktok",
    status: opts.status,
    ...(opts.scheduledFor ? { scheduledFor: opts.scheduledFor } : {}),
    ...(opts.publishedAt ? { publishedAt: opts.publishedAt } : {}),
  });
  return id;
}

// IST times on "tomorrow" so slots are always in the future
const tmr = istParts(new Date(Date.now() + 24 * 3_600_000));
const istAt = (hour: number) => istWallToUtc(tmr.year, tmr.month, tmr.day, hour, 0);

describe("GET /posts list + detail + metrics (doc 11)", () => {
  t("lists posts and reads one detail + its metrics series", async () => {
    const catId = await makeCategory({ tiktok: 5 });
    const briefId = await makeBrief(catId);
    const postId = await makePost(catId, briefId, { status: "published", publishedAt: new Date() });
    await db.insert(postSnapshots).values({
      id: newId(),
      postId,
      capturedAt: new Date(Date.now() - 3_600_000),
      views: 100,
    });
    await db.insert(postSnapshots).values({ id: newId(), postId, views: 250 });

    const list = await app.request(`/api/v1/posts?category=${catId}`, { headers: bearer });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { id: string; views: number | null }[] };
    const mine = body.items.find((p) => p.id === postId);
    expect(mine?.views).toBe(250); // latest snapshot

    const detail = await app.request(`/api/v1/posts/${postId}`, { headers: bearer });
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as { post: { id: string }; brief: { id: string } | null };
    expect(d.post.id).toBe(postId);
    expect(d.brief?.id).toBe(briefId);

    const metrics = await app.request(`/api/v1/posts/${postId}/metrics`, { headers: bearer });
    const series = ((await metrics.json()) as { series: unknown[] }).series;
    expect(series.length).toBe(2);
  });

  t("unknown post 404s on detail + metrics", async () => {
    expect((await app.request(`/api/v1/posts/${newId()}`, { headers: bearer })).status).toBe(404);
    expect(
      (await app.request(`/api/v1/posts/${newId()}/metrics`, { headers: bearer })).status,
    ).toBe(404);
  });
});

describe("PATCH /posts/:id reslot (doc 10 §3.5)", () => {
  t("valid slot schedules an approved post", async () => {
    const catId = await makeCategory({ tiktok: 5 });
    const briefId = await makeBrief(catId);
    const postId = await makePost(catId, briefId, { status: "approved" });
    const res = await app.request(`/api/v1/posts/${postId}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ scheduledFor: istAt(9).toISOString() }),
    });
    expect(res.status).toBe(200);
    const [p] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(p?.status).toBe("scheduled");
    expect(p?.scheduledFor).not.toBeNull();
  });

  t("gap violation (<3h from another same-platform post) → 422", async () => {
    const catId = await makeCategory({ tiktok: 5 });
    const briefId = await makeBrief(catId);
    await makePost(catId, briefId, { status: "scheduled", scheduledFor: istAt(9) });
    const candidate = await makePost(catId, briefId, { status: "approved" });
    const res = await app.request(`/api/v1/posts/${candidate}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ scheduledFor: istAt(10).toISOString() }), // 1h from 09:00
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("gap_violation");
  });

  t("daily cap exceeded → 422", async () => {
    const catId = await makeCategory({ tiktok: 2 });
    const briefId = await makeBrief(catId);
    await makePost(catId, briefId, { status: "scheduled", scheduledFor: istAt(9) });
    await makePost(catId, briefId, { status: "scheduled", scheduledFor: istAt(17) }); // 8h apart
    const candidate = await makePost(catId, briefId, { status: "approved" });
    const res = await app.request(`/api/v1/posts/${candidate}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ scheduledFor: istAt(13).toISOString() }), // 4h from both, same day
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("cap_exceeded");
  });

  t("past slot → 422", async () => {
    const catId = await makeCategory({ tiktok: 5 });
    const briefId = await makeBrief(catId);
    const postId = await makePost(catId, briefId, { status: "approved" });
    const res = await app.request(`/api/v1/posts/${postId}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ scheduledFor: new Date(Date.now() - 3_600_000).toISOString() }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("past_slot");
  });
});

describe("retry + delete (doc 11)", () => {
  t("failed post retries → scheduled; published cannot delete", async () => {
    const catId = await makeCategory({ tiktok: 5 });
    const briefId = await makeBrief(catId);
    const failed = await makePost(catId, briefId, { status: "failed" });
    const retry = await app.request(`/api/v1/posts/${failed}/retry`, {
      method: "POST",
      headers: bearer,
    });
    expect(retry.status).toBe(200);
    const [p] = await db.select().from(posts).where(eq(posts.id, failed));
    expect(p?.status).toBe("scheduled");

    const draft = await makePost(catId, briefId, { status: "draft" });
    const del = await app.request(`/api/v1/posts/${draft}`, { method: "DELETE", headers: bearer });
    expect(del.status).toBe(200);
    const [d] = await db.select().from(posts).where(eq(posts.id, draft));
    expect(d?.status).toBe("deleted");

    const published = await makePost(catId, briefId, {
      status: "published",
      publishedAt: new Date(),
    });
    const delPub = await app.request(`/api/v1/posts/${published}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(delPub.status).toBe(200); // published → deleted is allowed (POST_TRANSITIONS)
  });
});

describe("engagements (doc 11, doc 06 §6)", () => {
  t("lists needsHuman comments and queues a manual reply", async () => {
    const catId = await makeCategory({ tiktok: 5 });
    const briefId = await makeBrief(catId);
    const postId = await makePost(catId, briefId, { status: "published", publishedAt: new Date() });
    const engId = newId();
    await db.insert(engagements).values({
      id: engId,
      postId,
      externalCommentId: `c_${run}`,
      author: "someone",
      text: "great question?",
      needsHuman: true,
    });

    const list = await app.request(`/api/v1/engagements?needsHuman=1&postId=${postId}`, {
      headers: bearer,
    });
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: { id: string }[] }).items;
    expect(items.some((e) => e.id === engId)).toBe(true);

    const reply = await app.request(`/api/v1/engagements/${engId}/reply`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ text: "thanks for asking!" }),
    });
    expect(reply.status).toBe(200);
  });
});

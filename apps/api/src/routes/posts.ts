// Posts routes (doc 11 §3): filterable list with latest metrics, detail lineage, metrics series,
// reslot (caps/gaps validated), retry, delete. Reslot mirrors the scheduler's rails (doc 06 §7).
import { zValidator } from "@hono/zod-validator";
import {
  type CategoriesCadenceCaps,
  canTransition,
  istParts,
  MIN_SAME_PLATFORM_GAP_HOURS,
  makeLogger,
  type Platform,
  POST_TRANSITIONS,
  Q,
} from "@ve/core";
import {
  briefs,
  campaignClips,
  categories,
  db,
  desc,
  engagements,
  eq,
  InvalidTransitionError,
  postMetricsSeries,
  posts,
  postsWithLatestMetrics,
  renders,
  scripts,
  sql,
  transitionPost,
  trends,
} from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const log = makeLogger("api-posts");

const GAP_MS = MIN_SAME_PLATFORM_GAP_HOURS * 3_600_000;
const istDayKey = (d: Date) => {
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}`;
};

const ListQuery = z.object({
  platform: z.string().optional(),
  status: z.string().optional(),
  category: z.string().uuid().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

async function resolveCategoryId(idOrSlug: string): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)) {
    return idOrSlug;
  }
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, idOrSlug));
  return row?.id ?? null;
}

/** Reslot validation (doc 06 §7 rails): future, ≥3h same-platform gap, per-lane daily cap. */
async function validateSlot(
  post: typeof posts.$inferSelect,
  newTime: Date,
  now: Date,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (newTime.getTime() <= now.getTime()) {
    return { ok: false, code: "past_slot", message: "scheduledFor must be in the future" };
  }
  const [category] = await db.select().from(categories).where(eq(categories.id, post.categoryId));
  const caps = (category?.cadenceCaps ?? {}) as CategoriesCadenceCaps;
  const cap = caps[post.platform as Platform] ?? 0;

  const existing = (await db.execute(sql`
    select coalesce(scheduled_for, published_at) as "when"
    from posts
    where category_id = ${post.categoryId} and platform = ${post.platform} and id != ${post.id}
      and status in ('scheduled', 'publishing', 'published')
      and coalesce(scheduled_for, published_at) is not null
  `)) as unknown as { when: Date | string }[];
  const whens = existing.map((e) => new Date(e.when));

  for (const w of whens) {
    if (Math.abs(newTime.getTime() - w.getTime()) < GAP_MS) {
      return {
        ok: false,
        code: "gap_violation",
        message: `must be ≥${MIN_SAME_PLATFORM_GAP_HOURS}h from another ${post.platform} post`,
      };
    }
  }
  const dk = istDayKey(newTime);
  const sameDay = whens.filter((w) => istDayKey(w) === dk).length;
  if (sameDay >= cap) {
    return {
      ok: false,
      code: "cap_exceeded",
      message: `daily cap ${cap} reached for ${post.platform}`,
    };
  }
  return { ok: true };
}

const PatchBody = z.object({ scheduledFor: z.string().datetime() });

export const postsRoutes = new Hono<AuthedEnv>()
  .get("/", zValidator("query", ListQuery), async (c) => {
    const q = c.req.valid("query");
    let categoryId: string | undefined;
    if (q.category) {
      const resolved = await resolveCategoryId(q.category);
      if (!resolved)
        return c.json({ error: { code: "not_found", message: "unknown category" } }, 404);
      categoryId = resolved;
    }
    const result = await postsWithLatestMetrics({
      ...(q.platform ? { platform: q.platform } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    return c.json(result);
  })

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!post) return c.json({ error: { code: "not_found", message: "post not found" } }, 404);
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, post.briefId)).limit(1);
    const [script] = brief
      ? await db
          .select()
          .from(scripts)
          .where(eq(scripts.briefId, brief.id))
          .orderBy(desc(scripts.version))
          .limit(1)
      : [];
    const render = post.renderId
      ? ((await db.select().from(renders).where(eq(renders.id, post.renderId)).limit(1))[0] ?? null)
      : null;
    const trend = brief?.trendId
      ? ((await db.select().from(trends).where(eq(trends.id, brief.trendId)).limit(1))[0] ?? null)
      : null;
    const comments = await db
      .select()
      .from(engagements)
      .where(eq(engagements.postId, id))
      .orderBy(desc(engagements.seenAt));
    const [campaignClip] = await db
      .select()
      .from(campaignClips)
      .where(eq(campaignClips.postId, id))
      .limit(1);

    return c.json({
      post,
      brief: brief ?? null,
      script: script ?? null,
      render,
      trend,
      engagements: comments,
      campaignClip: campaignClip ?? null,
    });
  })

  .get("/:id/metrics", async (c) => {
    const id = c.req.param("id");
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!post) return c.json({ error: { code: "not_found", message: "post not found" } }, 404);
    const series = await postMetricsSeries(id);
    return c.json({ series });
  })

  // reslot (doc 10 §3.5 calendar): validates caps/gaps → 422 on violation
  .patch("/:id", zValidator("json", PatchBody), async (c) => {
    const id = c.req.param("id");
    const { scheduledFor } = c.req.valid("json");
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!post) return c.json({ error: { code: "not_found", message: "post not found" } }, 404);
    if (!["approved", "scheduled", "failed"].includes(post.status)) {
      return c.json(
        { error: { code: "not_reslottable", message: `cannot reslot a ${post.status} post` } },
        422,
      );
    }
    const newTime = new Date(scheduledFor);
    const check = await validateSlot(post, newTime, new Date());
    if (!check.ok) return c.json({ error: { code: check.code, message: check.message } }, 422);

    if (post.status === "approved" || post.status === "failed") {
      await transitionPost(db, id, "scheduled", { scheduledFor: newTime });
    } else {
      // already scheduled — just move the time (not a status change)
      await db
        .update(posts)
        .set({ scheduledFor: newTime, updatedAt: new Date() })
        .where(eq(posts.id, id));
    }
    await enqueue(Q.publishExecute, { postId: id }, { startAfter: newTime, singletonKey: id });
    log.info({ postId: id, scheduledFor: newTime.toISOString() }, "post reslotted");
    return c.json({ ok: true, scheduledFor: newTime.toISOString() });
  })

  .post("/:id/retry", async (c) => {
    const id = c.req.param("id");
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!post) return c.json({ error: { code: "not_found", message: "post not found" } }, 404);
    if (post.status !== "failed") {
      return c.json({ error: { code: "not_failed", message: "only failed posts retry" } }, 422);
    }
    const when = new Date(Date.now() + 60_000);
    await transitionPost(db, id, "scheduled", { scheduledFor: when });
    await enqueue(Q.publishExecute, { postId: id }, { startAfter: when, singletonKey: id });
    return c.json({ ok: true, status: "scheduled" });
  })

  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!post) return c.json({ error: { code: "not_found", message: "post not found" } }, 404);
    if (!canTransition(POST_TRANSITIONS, post.status, "deleted")) {
      return c.json(
        { error: { code: "not_deletable", message: `cannot delete a ${post.status} post` } },
        422,
      );
    }
    try {
      await transitionPost(db, id, "deleted");
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return c.json({ error: { code: "invalid_transition", message: err.message } }, 422);
      }
      throw err;
    }
    return c.json({ ok: true, status: "deleted" });
  });

// Trends routes (doc 11 §3, built early per doc 13 Phase 1).
import { zValidator } from "@hono/zod-validator";
import { TREND_STATUS } from "@ve/core";
import {
  categories,
  db,
  eq,
  InvalidTransitionError,
  topTrends,
  transitionTrend,
  trendDetail,
} from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";

const ListQuery = z.object({
  category: z.string().optional(), // slug or uuid
  status: z.enum(TREND_STATUS).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

async function resolveCategoryId(idOrSlug: string): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)) {
    return idOrSlug;
  }
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, idOrSlug))
    .limit(1);
  return row?.id ?? null;
}

export const trendsRoutes = new Hono<AuthedEnv>()
  .get("/", zValidator("query", ListQuery), async (c) => {
    const q = c.req.valid("query");
    let categoryId: string | undefined;
    if (q.category) {
      const resolved = await resolveCategoryId(q.category);
      if (!resolved) {
        return c.json(
          { error: { code: "not_found", message: `unknown category ${q.category}` } },
          404,
        );
      }
      categoryId = resolved;
    }
    const items = await topTrends({
      ...(categoryId ? { categoryId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return c.json({ items });
  })
  .get("/:id", async (c) => {
    const detail = await trendDetail(c.req.param("id"));
    if (!detail) {
      return c.json({ error: { code: "not_found", message: "trend not found" } }, 404);
    }
    return c.json(detail);
  })
  .post("/:id/suppress", async (c) => {
    try {
      const updated = await transitionTrend(db, c.req.param("id"), "suppressed");
      return c.json({ ok: true, trend: { id: updated.id, status: updated.status } });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return c.json({ error: { code: "invalid_transition", message: err.message } }, 422);
      }
      if (err instanceof Error && err.name === "EntityNotFoundError") {
        return c.json({ error: { code: "not_found", message: "trend not found" } }, 404);
      }
      throw err;
    }
  });

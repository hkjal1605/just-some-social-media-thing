// Playbook routes (doc 11 §3, doc 07 §3): list versions per category, diff a draft vs the
// previous version (LCS line diff), approve a draft (human review gate).
import { zValidator } from "@hono/zod-validator";
import { lineDiff } from "@ve/core";
import { and, categories, db, desc, eq, playbookVersions } from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";

const ListQuery = z.object({ category: z.string().optional() });

async function resolveCategoryId(idOrSlug: string): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug))
    return idOrSlug;
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, idOrSlug));
  return row?.id ?? null;
}

export const playbooksRoutes = new Hono<AuthedEnv>()
  .get("/", zValidator("query", ListQuery), async (c) => {
    const { category } = c.req.valid("query");
    let categoryId: string | undefined;
    if (category) {
      const resolved = await resolveCategoryId(category);
      if (!resolved)
        return c.json({ error: { code: "not_found", message: "unknown category" } }, 404);
      categoryId = resolved;
    }
    const items = await db
      .select({
        id: playbookVersions.id,
        categoryId: playbookVersions.categoryId,
        version: playbookVersions.version,
        changeSummary: playbookVersions.changeSummary,
        createdBy: playbookVersions.createdBy,
        approvedAt: playbookVersions.approvedAt,
        createdAt: playbookVersions.createdAt,
      })
      .from(playbookVersions)
      .where(categoryId ? eq(playbookVersions.categoryId, categoryId) : undefined)
      .orderBy(desc(playbookVersions.createdAt));
    return c.json({ items });
  })

  .get("/:id", async (c) => {
    const [pv] = await db
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.id, c.req.param("id")))
      .limit(1);
    if (!pv) return c.json({ error: { code: "not_found", message: "playbook not found" } }, 404);
    return c.json({ playbook: pv });
  })

  .get("/:id/diff", async (c) => {
    const [pv] = await db
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.id, c.req.param("id")))
      .limit(1);
    if (!pv) return c.json({ error: { code: "not_found", message: "playbook not found" } }, 404);
    const [prev] = await db
      .select()
      .from(playbookVersions)
      .where(
        and(
          eq(playbookVersions.categoryId, pv.categoryId),
          eq(playbookVersions.version, pv.version - 1),
        ),
      )
      .limit(1);
    return c.json({
      current: { id: pv.id, version: pv.version, markdown: pv.markdown, approvedAt: pv.approvedAt },
      previous: prev ? { id: prev.id, version: prev.version, markdown: prev.markdown } : null,
      diff: lineDiff(prev?.markdown ?? "", pv.markdown),
    });
  })

  .post("/:id/approve", async (c) => {
    const id = c.req.param("id");
    const updated = await db
      .update(playbookVersions)
      .set({ approvedAt: new Date() })
      .where(eq(playbookVersions.id, id))
      .returning();
    if (updated.length === 0) {
      return c.json({ error: { code: "not_found", message: "playbook not found" } }, 404);
    }
    return c.json({ ok: true, playbook: updated[0] });
  });

// Category + source CRUD (doc 11 §3, doc 10 §3.9 Settings). Sources get a "scout now" button.
import { zValidator } from "@hono/zod-validator";
import {
  CATEGORY_MODE,
  makeLogger,
  newId,
  PLATFORM,
  type Platform,
  Q,
  type QueueName,
  SOURCE_KIND,
} from "@ve/core";
import { categories, db, desc, eq, sources, sql } from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const log = makeLogger("api-categories");

const SCOUT_QUEUE: Record<Platform, QueueName> = {
  reddit: Q.scoutReddit,
  youtube: Q.scoutYoutube,
  x: Q.scoutX,
  tiktok: Q.scoutTiktok,
};

const CreateCategory = z.object({
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  mode: z.enum(CATEGORY_MODE),
  cadenceCaps: z.record(z.string(), z.number().int().nonnegative()).optional(),
  autoApproveFormats: z.array(z.string()).optional(),
});
const PatchCategory = z.object({
  name: z.string().min(1).max(100).optional(),
  mode: z.enum(CATEGORY_MODE).optional(),
  cadenceCaps: z.record(z.string(), z.number().int().nonnegative()).optional(),
  autoApproveFormats: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

export const categoriesRoutes = new Hono<AuthedEnv>()
  .get("/", async (c) => {
    const items = await db.select().from(categories).orderBy(categories.slug);
    return c.json({ items });
  })
  .post("/", zValidator("json", CreateCategory), async (c) => {
    const b = c.req.valid("json");
    const id = newId();
    try {
      await db.insert(categories).values({
        id,
        slug: b.slug,
        name: b.name,
        mode: b.mode,
        cadenceCaps: b.cadenceCaps ?? { tiktok: 2, youtube: 1, x: 5, reddit: 1 },
        autoApproveFormats: b.autoApproveFormats ?? [],
      });
    } catch {
      return c.json({ error: { code: "conflict", message: `slug ${b.slug} exists` } }, 409);
    }
    return c.json({ id }, 201);
  })
  .patch("/:id", zValidator("json", PatchCategory), async (c) => {
    const id = c.req.param("id");
    const b = c.req.valid("json");
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (b.name !== undefined) set.name = b.name;
    if (b.mode !== undefined) set.mode = b.mode;
    if (b.cadenceCaps !== undefined) set.cadenceCaps = b.cadenceCaps;
    if (b.autoApproveFormats !== undefined) set.autoApproveFormats = b.autoApproveFormats;
    if (b.active !== undefined) set.active = b.active;
    const updated = await db.update(categories).set(set).where(eq(categories.id, id)).returning();
    if (updated.length === 0)
      return c.json({ error: { code: "not_found", message: "category not found" } }, 404);
    return c.json({ ok: true, category: updated[0] });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    // refuse if referenced (sources/trends/briefs) — deactivate instead (doc 10 §3.9)
    const refs = (await db.execute(sql`
      select
        (select count(*)::int from sources where category_id = ${id}) as "sources",
        (select count(*)::int from trends where category_id = ${id}) as "trends",
        (select count(*)::int from briefs where category_id = ${id}) as "briefs"
    `)) as unknown as { sources: number; trends: number; briefs: number }[];
    const r = refs[0];
    if (r && (r.sources > 0 || r.trends > 0 || r.briefs > 0)) {
      return c.json(
        {
          error: {
            code: "has_dependencies",
            message: "category has sources/trends/briefs — deactivate instead",
          },
        },
        422,
      );
    }
    const deleted = await db
      .delete(categories)
      .where(eq(categories.id, id))
      .returning({ id: categories.id });
    if (deleted.length === 0)
      return c.json({ error: { code: "not_found", message: "category not found" } }, 404);
    return c.json({ ok: true });
  });

const CreateSource = z.object({
  categoryId: z.string().uuid(),
  platform: z.enum(PLATFORM),
  kind: z.enum(SOURCE_KIND),
  value: z.string().min(1).max(500),
  scoutIntervalMin: z.number().int().min(5).max(1440).optional(),
});
const PatchSource = z.object({
  value: z.string().min(1).max(500).optional(),
  scoutIntervalMin: z.number().int().min(5).max(1440).optional(),
  active: z.boolean().optional(),
});

export const sourcesRoutes = new Hono<AuthedEnv>()
  .get(
    "/",
    zValidator("query", z.object({ category: z.string().uuid().optional() })),
    async (c) => {
      const { category } = c.req.valid("query");
      const items = await db
        .select()
        .from(sources)
        .where(category ? eq(sources.categoryId, category) : undefined)
        .orderBy(desc(sources.createdAt));
      return c.json({ items });
    },
  )
  .post("/", zValidator("json", CreateSource), async (c) => {
    const b = c.req.valid("json");
    const id = newId();
    try {
      await db.insert(sources).values({
        id,
        categoryId: b.categoryId,
        platform: b.platform,
        kind: b.kind,
        value: b.value,
        ...(b.scoutIntervalMin ? { scoutIntervalMin: b.scoutIntervalMin } : {}),
      });
    } catch {
      return c.json({ error: { code: "conflict", message: "source already exists" } }, 409);
    }
    return c.json({ id }, 201);
  })
  .patch("/:id", zValidator("json", PatchSource), async (c) => {
    const id = c.req.param("id");
    const b = c.req.valid("json");
    const set: Record<string, unknown> = {};
    if (b.value !== undefined) set.value = b.value;
    if (b.scoutIntervalMin !== undefined) set.scoutIntervalMin = b.scoutIntervalMin;
    if (b.active !== undefined) set.active = b.active;
    if (Object.keys(set).length === 0) return c.json({ ok: true });
    const updated = await db.update(sources).set(set).where(eq(sources.id, id)).returning();
    if (updated.length === 0)
      return c.json({ error: { code: "not_found", message: "source not found" } }, 404);
    return c.json({ ok: true, source: updated[0] });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    // raw_items reference source_id (nullable, no cascade) — detach before delete
    await db.execute(sql`update raw_items set source_id = null where source_id = ${id}`);
    const deleted = await db
      .delete(sources)
      .where(eq(sources.id, id))
      .returning({ id: sources.id });
    if (deleted.length === 0)
      return c.json({ error: { code: "not_found", message: "source not found" } }, 404);
    return c.json({ ok: true });
  })
  .post("/:id/scout", async (c) => {
    const id = c.req.param("id");
    const [src] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
    if (!src) return c.json({ error: { code: "not_found", message: "source not found" } }, 404);
    const queue = SCOUT_QUEUE[src.platform as Platform];
    await enqueue(queue, { sourceId: id });
    log.info({ sourceId: id, queue }, "manual scout enqueued");
    return c.json({ ok: true, queue });
  });

// Briefs routes (doc 11 §3): manual brief creation + the full lineage view.
// Acceptance (doc 05 §7): a brief in a radar_only category (music) 422s here.
import { zValidator } from "@hono/zod-validator";
import {
  AMBER_ALLOWED_FORMATS,
  FORMATS,
  type FormatSlug,
  FormatSlugSchema,
  newId,
  type Platform,
  PlatformSchema,
  Q,
} from "@ve/core";
import {
  approvals,
  assets,
  briefs,
  categories,
  complianceChecks,
  db,
  desc,
  eq,
  posts,
  renders,
  scripts,
  transitionBrief,
  transitionTrend,
  trends,
} from "@ve/db";
import { presignPut, r2Key } from "@ve/storage";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const CreateBrief = z.object({
  trendId: z.string().uuid(),
  formatSlug: FormatSlugSchema,
  targetPlatforms: z.array(PlatformSchema).min(1),
  angle: z.string().min(8).max(300),
});

export const briefsRoutes = new Hono<AuthedEnv>()
  .post("/", zValidator("json", CreateBrief), async (c) => {
    const input = c.req.valid("json");

    const [trend] = await db.select().from(trends).where(eq(trends.id, input.trendId)).limit(1);
    if (!trend) return c.json({ error: { code: "not_found", message: "trend not found" } }, 404);
    const [category] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, trend.categoryId))
      .limit(1);
    if (!category) {
      return c.json({ error: { code: "not_found", message: "category not found" } }, 404);
    }

    // hard rails (doc 05 §7 / doc 00 §2): music can never be briefed
    if (category.mode === "radar_only") {
      return c.json(
        {
          error: {
            code: "radar_only",
            message: `category ${category.slug} is radar-only — publishing is disabled`,
          },
        },
        422,
      );
    }
    if (trend.status !== "active") {
      return c.json(
        { error: { code: "invalid_state", message: `trend is ${trend.status}, not active` } },
        422,
      );
    }
    if (trend.rightsClass === "red") {
      return c.json(
        { error: { code: "rights_red", message: "red trends are intelligence-only" } },
        422,
      );
    }
    if (
      trend.rightsClass === "amber" &&
      !(AMBER_ALLOWED_FORMATS as readonly string[]).includes(input.formatSlug)
    ) {
      return c.json(
        {
          error: {
            code: "amber_format",
            message: `amber trends allow only ${AMBER_ALLOWED_FORMATS.join(", ")}`,
          },
        },
        422,
      );
    }
    const format = FORMATS[input.formatSlug as FormatSlug];
    const targetPlatforms = input.targetPlatforms.filter((p) =>
      (format.platforms as readonly Platform[]).includes(p),
    );
    if (targetPlatforms.length === 0) {
      return c.json(
        {
          error: {
            code: "platform_mismatch",
            message: `${input.formatSlug} supports ${format.platforms.join(", ")}`,
          },
        },
        422,
      );
    }

    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      trendId: trend.id,
      categoryId: category.id,
      originKind: "trend",
      status: "draft",
      angle: input.angle,
      formatSlug: input.formatSlug,
      targetPlatforms,
    });
    await transitionTrend(db, trend.id, "briefed");
    await enqueue(Q.factoryScript, { briefId });
    return c.json({ id: briefId, status: "draft" }, 201);
  })

  // lineage view (doc 11 §3): script versions, assets, renders, compliance, approval, posts
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
    if (!brief) return c.json({ error: { code: "not_found", message: "brief not found" } }, 404);

    const [scriptRows, assetRows, renderRows, complianceRows, approvalRows, postRows] =
      await Promise.all([
        db.select().from(scripts).where(eq(scripts.briefId, id)).orderBy(desc(scripts.version)),
        db.select().from(assets).where(eq(assets.briefId, id)),
        db.select().from(renders).where(eq(renders.briefId, id)),
        db.select().from(complianceChecks).where(eq(complianceChecks.briefId, id)),
        db.select().from(approvals).where(eq(approvals.briefId, id)),
        db.select().from(posts).where(eq(posts.briefId, id)),
      ]);

    return c.json({
      brief,
      scripts: scriptRows,
      assets: assetRows,
      renders: renderRows,
      compliance: complianceRows,
      approvals: approvalRows,
      posts: postRows,
    });
  })

  // ── screen-demo recovery (doc 05 §3, M10) — the human touchpoint for a `needs-demo` block ──
  // 1) presign a PUT for the demo recording and register it as a reusable category demo asset
  .post(
    "/:id/demo",
    zValidator("json", z.object({ mime: z.string().default("video/mp4") })),
    async (c) => {
      const id = c.req.param("id");
      const [brief] = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
      if (!brief) return c.json({ error: { code: "not_found", message: "brief not found" } }, 404);
      const [category] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, brief.categoryId))
        .limit(1);
      const { mime } = c.req.valid("json");
      const assetId = newId();
      const ext = mime.includes("quicktime") ? "mov" : "mp4";
      const key = r2Key.asset(id, assetId, ext);
      await db.insert(assets).values({
        id: assetId,
        briefId: id,
        kind: "source_video",
        r2Key: key,
        mime,
        // tagged with the category slug so the same recording is reused by the category's briefs
        meta: { demo: true, categorySlug: category?.slug ?? "" },
        licenseRef: "own-recording",
      });
      const presignedPut = await presignPut(key, mime, 3600);
      return c.json({ assetId, key, presignedPut }, 201);
    },
  )
  // 2) after upload, resume the brief: blocked → producing, then re-run visuals (finds the demo now)
  .post("/:id/demo/ingest", async (c) => {
    const id = c.req.param("id");
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
    if (!brief) return c.json({ error: { code: "not_found", message: "brief not found" } }, 404);
    const [script] = await db
      .select({ id: scripts.id })
      .from(scripts)
      .where(eq(scripts.briefId, id))
      .orderBy(desc(scripts.version))
      .limit(1);
    if (!script) {
      return c.json({ error: { code: "no_script", message: "brief has no script yet" } }, 422);
    }
    if (brief.status === "blocked") await transitionBrief(db, id, "producing");
    await enqueue(Q.factoryVisuals, { briefId: id, scriptId: script.id });
    return c.json({ ok: true });
  });

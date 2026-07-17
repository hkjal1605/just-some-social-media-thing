// Long-form + clip-candidate routes (doc 11 §3): upload → ingest → candidates → promote.
import { zValidator } from "@hono/zod-validator";
import { newId, PlatformSchema, Q } from "@ve/core";
import { briefs, campaigns, clipCandidates, db, desc, eq, longForms } from "@ve/db";
import { presignPut, r2Key } from "@ve/storage";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const CreateLongForm = z.object({
  title: z.string().min(1).max(300),
  categoryId: z.string().uuid(),
  bytes: z.number().int().positive().optional(),
  mime: z.string().default("video/mp4"),
});

export const longformsRoutes = new Hono<AuthedEnv>()
  // client uploads straight to R2 with the returned presigned PUT (doc 11)
  .post("/", zValidator("json", CreateLongForm), async (c) => {
    const input = c.req.valid("json");
    const id = newId();
    const key = r2Key.longformSource(id);
    await db.insert(longForms).values({
      id,
      categoryId: input.categoryId,
      title: input.title,
      r2Key: key,
      status: "uploaded",
    });
    const presignedPut = await presignPut(key, input.mime, 3600);
    return c.json({ id, key, presignedPut }, 201);
  })

  .post("/:id/ingest", async (c) => {
    const id = c.req.param("id");
    const [lf] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
    if (!lf) return c.json({ error: { code: "not_found", message: "long_form not found" } }, 404);
    await enqueue(Q.clipTranscribe, { kind: "longform", id });
    return c.json({ ok: true, status: lf.status });
  })

  .get("/", async (c) => {
    const items = await db.select().from(longForms).orderBy(desc(longForms.createdAt));
    return c.json({ items });
  })

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const [lf] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
    if (!lf) return c.json({ error: { code: "not_found", message: "long_form not found" } }, 404);
    const candidates = await db
      .select()
      .from(clipCandidates)
      .where(eq(clipCandidates.longFormId, id))
      .orderBy(desc(clipCandidates.hookScore));
    return c.json({ longForm: lf, candidates });
  });

const PromoteBody = z.object({
  targetPlatforms: z.array(PlatformSchema).min(1),
});

/** POST /clip-candidates/:id/promote — candidate → clip-vertical brief (doc 05 §5). */
export const clipCandidatesRoutes = new Hono<AuthedEnv>().post(
  "/:id/promote",
  zValidator("json", PromoteBody),
  async (c) => {
    const id = c.req.param("id");
    const { targetPlatforms } = c.req.valid("json");
    const [candidate] = await db
      .select()
      .from(clipCandidates)
      .where(eq(clipCandidates.id, id))
      .limit(1);
    if (!candidate) {
      return c.json({ error: { code: "not_found", message: "clip candidate not found" } }, 404);
    }
    if (candidate.briefId) {
      return c.json({ id: candidate.briefId, alreadyPromoted: true });
    }

    // resolve the brief's category from whichever source this candidate came from (doc 05 §5) —
    // long-form via long_forms, campaign clip via campaigns (the campaign path was previously dead)
    let categoryId: string | null = null;
    if (candidate.longFormId) {
      const [lf] = await db
        .select()
        .from(longForms)
        .where(eq(longForms.id, candidate.longFormId))
        .limit(1);
      categoryId = lf?.categoryId ?? null;
    } else if (candidate.campaignId) {
      const [camp] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, candidate.campaignId))
        .limit(1);
      categoryId = camp?.categoryId ?? null;
    }
    if (!categoryId) {
      return c.json(
        { error: { code: "no_category", message: "source has no category — set one first" } },
        422,
      );
    }

    const briefId = newId();
    await db.insert(briefs).values({
      id: briefId,
      categoryId,
      originKind: candidate.longFormId ? "longform_clip" : "campaign_clip",
      longFormId: candidate.longFormId,
      campaignId: candidate.campaignId,
      status: "draft",
      angle: (candidate.transcriptSlice ?? "clip highlight").slice(0, 300),
      formatSlug: "clip-vertical",
      targetPlatforms,
    });
    await db.update(clipCandidates).set({ briefId }).where(eq(clipCandidates.id, id));
    if (candidate.longFormId) {
      await db
        .update(longForms)
        .set({ status: "clipped" })
        .where(eq(longForms.id, candidate.longFormId));
    }
    await enqueue(Q.factoryScript, { briefId });
    return c.json({ id: briefId }, 201);
  },
);

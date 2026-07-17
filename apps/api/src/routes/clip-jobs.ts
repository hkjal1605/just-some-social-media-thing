// Clip Studio routes: paste a video URL → auto-generate the best viral clips → download → delete.
// A "job" is a long_form flagged with clip_options; the pipeline (ingest_url → transcribe → analyze
// → auto-promote top-N studio-only briefs → render) runs render-ONLY (never publishes). The UI polls
// GET /:id for status + downloadable clips and can DELETE to wipe the source + clips from R2.
import { zValidator } from "@hono/zod-validator";
import { integrations } from "@ve/config";
import { bufferConnectedPlatforms } from "@ve/connectors";
import { newId, PlatformSchema, Q } from "@ve/core";
import {
  and,
  briefs,
  categories,
  clipCandidates,
  db,
  desc,
  eq,
  inArray,
  isNotNull,
  longForms,
  posts,
  renders,
  scripts,
} from "@ve/db";
import { deletePrefix, presignGet, r2Key } from "@ve/storage";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const CreateJob = z.object({
  url: z.string().url(),
  title: z.string().max(200).optional(),
  platforms: z.array(PlatformSchema).min(1).default(["tiktok"]),
  topN: z.number().int().min(1).max(10).default(3),
  captionPreset: z.enum(["hormozi", "beast", "clean"]).default("hormozi"),
  genre: z.string().max(40).optional(),
  maxLen: z.number().int().min(15).max(90).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  // bake the designed cover (best frame + hook) as a ~0.7s hook-card at the clip start, so it becomes
  // the actual cover on X / YouTube Shorts / TikTok (the platforms/Buffer won't accept a cover image)
  hookCard: z.boolean().default(false),
});

/** Studio jobs need a category (long_forms.category_id is NOT NULL); use a dedicated one. */
async function studioCategoryId(): Promise<string> {
  const [existing] = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, "clip-studio"))
    .limit(1);
  if (existing) return existing.id;
  const id = newId();
  await db
    .insert(categories)
    .values({
      id,
      slug: "clip-studio",
      name: "Clip Studio",
      mode: "human_gated",
      cadenceCaps: { tiktok: 0, youtube: 0, x: 0, reddit: 0 }, // studio never publishes
    })
    .onConflictDoNothing();
  const [c] = await db.select().from(categories).where(eq(categories.slug, "clip-studio")).limit(1);
  return c?.id ?? id;
}

type LongForm = typeof longForms.$inferSelect;

async function jobView(lf: LongForm) {
  const jobBriefs = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.longFormId, lf.id), eq(briefs.studioOnly, true)));
  const briefIds = jobBriefs.map((b) => b.id);
  const rends = briefIds.length
    ? await db.select().from(renders).where(inArray(renders.briefId, briefIds))
    : [];
  const cands = await db
    .select()
    .from(clipCandidates)
    .where(and(eq(clipCandidates.longFormId, lf.id), isNotNull(clipCandidates.briefId)));
  const candByBrief = new Map(cands.map((c) => [c.briefId, c]));
  const postRows = briefIds.length
    ? await db.select().from(posts).where(inArray(posts.briefId, briefIds))
    : [];

  const clips = await Promise.all(
    jobBriefs.map(async (b) => {
      const done = rends.find((r) => r.briefId === b.id && r.status === "done");
      const any = done ?? rends.find((r) => r.briefId === b.id);
      const cand = candByBrief.get(b.id);
      const hooks = (cand?.scriptData as { hookVariants?: { text: string }[] } | null)
        ?.hookVariants;
      return {
        briefId: b.id,
        status: any?.status ?? "pending",
        platform: any?.platform ?? (b.targetPlatforms as string[])[0] ?? "tiktok",
        downloadUrl: done?.r2Key ? await presignGet(done.r2Key, 3600) : null,
        thumbUrl: done?.thumbR2Key ? await presignGet(done.thumbR2Key, 3600) : null,
        width: done?.width ?? null,
        height: done?.height ?? null,
        durationSec: done?.durationSec ? Number(done.durationSec) : null,
        hook: hooks?.[0]?.text ?? cand?.transcriptSlice?.slice(0, 80) ?? null,
        scores: cand
          ? {
              hook: cand.hookScore,
              selfContained: cand.selfContainedScore,
              emotion: cand.emotionScore,
            }
          : null,
        // per-platform publish state for the Post buttons (empty until the user posts)
        posts: postRows
          .filter((p) => p.briefId === b.id)
          .map((p) => ({ platform: p.platform, status: p.status, url: p.permalink })),
      };
    }),
  );

  // effective status: once every promoted clip has a done render, the job is ready to download
  const allDone =
    jobBriefs.length > 0 &&
    jobBriefs.every((b) => rends.some((r) => r.briefId === b.id && r.status === "done"));
  const status = lf.status === "rendering" && allDone ? "ready" : lf.status;
  return {
    id: lf.id,
    title: lf.title || "Untitled clip", // ingest backfills the real title; placeholder until then
    status,
    genre: lf.genre,
    sourceUrl: lf.sourceUrl,
    options: lf.clipOptions,
    durationSec: lf.durationSec,
    createdAt: lf.createdAt,
    clips,
  };
}

export const clipJobsRoutes = new Hono<AuthedEnv>()
  .post("/", zValidator("json", CreateJob), async (c) => {
    const input = c.req.valid("json");
    const id = newId();
    await db.insert(longForms).values({
      id,
      categoryId: await studioCategoryId(),
      // empty ⇒ the ingest worker backfills it from the source (yt-dlp title / file name)
      title: input.title?.trim() || "",
      r2Key: r2Key.longformSource(id),
      sourceUrl: input.url,
      genre: input.genre ?? null,
      status: "queued",
      clipOptions: {
        platforms: input.platforms,
        topN: input.topN,
        captionPreset: input.captionPreset,
        ...(input.maxLen ? { maxLen: input.maxLen } : {}),
        ...(input.minScore ? { minScore: input.minScore } : {}),
        ...(input.hookCard ? { hookCard: true } : {}),
      },
    });
    await enqueue(Q.clipIngestUrl, { longFormId: id });
    return c.json({ id, status: "queued" }, 201);
  })

  .get("/", async (c) => {
    const items = await db
      .select()
      .from(longForms)
      .where(isNotNull(longForms.clipOptions))
      .orderBy(desc(longForms.createdAt));
    return c.json({ items: await Promise.all(items.map(jobView)) });
  })

  // which platforms are postable via Buffer (drives the per-clip Post buttons). A platform is
  // available when the Buffer account has a connected channel for it. Buffer unreachable / no token
  // ⇒ everything false (buttons disabled) rather than a 500 that would break the page.
  .get("/social-targets", async (c) => {
    if (!integrations.buffer) return c.json({ youtube: false, tiktok: false, x: false });
    try {
      return c.json(await bufferConnectedPlatforms());
    } catch {
      return c.json({ youtube: false, tiktok: false, x: false });
    }
  })

  .get("/:id", async (c) => {
    const [lf] = await db
      .select()
      .from(longForms)
      .where(eq(longForms.id, c.req.param("id")))
      .limit(1);
    if (!lf) return c.json({ error: { code: "not_found", message: "clip job not found" } }, 404);
    return c.json(await jobView(lf));
  })

  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [lf] = await db.select().from(longForms).where(eq(longForms.id, id)).limit(1);
    if (!lf) return c.json({ error: { code: "not_found", message: "clip job not found" } }, 404);

    const jobBriefs = await db.select().from(briefs).where(eq(briefs.longFormId, id));
    const briefIds = jobBriefs.map((b) => b.id);
    const rends = briefIds.length
      ? await db.select().from(renders).where(inArray(renders.briefId, briefIds))
      : [];

    // R2: source + audio + transcript (longforms/<id>/), every render + its thumb
    await deletePrefix(`longforms/${id}/`);
    for (const b of briefIds) await deletePrefix(`renders/${b}/`);
    for (const r of rends) if (r.thumbR2Key) await deletePrefix(r.thumbR2Key);

    // DB in FK-safe order: posts (ref renders+briefs) → renders → clip_candidates → scripts →
    // briefs (cascades assets/compliance) → long_form
    if (briefIds.length) await db.delete(posts).where(inArray(posts.briefId, briefIds));
    if (briefIds.length) await db.delete(renders).where(inArray(renders.briefId, briefIds));
    await db.delete(clipCandidates).where(eq(clipCandidates.longFormId, id));
    if (briefIds.length) {
      await db.delete(scripts).where(inArray(scripts.briefId, briefIds));
      await db.delete(briefs).where(inArray(briefs.id, briefIds));
    }
    await db.delete(longForms).where(eq(longForms.id, id));
    return c.json({ ok: true, deletedClips: rends.length });
  })

  // POST /clip-jobs/:id/clips/:briefId/publish — post a rendered clip to YouTube/TikTok/X through
  // Buffer, bypassing the approval/cadence pipeline (the user clicked Post explicitly).
  .post(
    "/:id/clips/:briefId/publish",
    zValidator("json", z.object({ platforms: z.array(z.enum(["youtube", "tiktok", "x"])).min(1) })),
    async (c) => {
      const jobId = c.req.param("id");
      const briefId = c.req.param("briefId");
      const { platforms } = c.req.valid("json");
      const [brief] = await db
        .select()
        .from(briefs)
        .where(
          and(eq(briefs.id, briefId), eq(briefs.longFormId, jobId), eq(briefs.studioOnly, true)),
        )
        .limit(1);
      if (!brief) {
        return c.json(
          { error: { code: "not_found", message: "clip not found for this job" } },
          404,
        );
      }
      const [render] = await db
        .select()
        .from(renders)
        .where(and(eq(renders.briefId, briefId), eq(renders.status, "done")))
        .limit(1);
      if (!render) {
        return c.json({ error: { code: "not_ready", message: "clip is still rendering" } }, 409);
      }
      // Buffer must be configured; then keep only platforms with a connected Buffer channel. If the
      // Buffer lookup itself errors, fall through with the requested platforms — the worker will mark
      // any unpostable one `failed` with a clear reason rather than silently dropping it.
      if (!integrations.buffer) {
        return c.json(
          {
            error: {
              code: "not_configured",
              message: "Buffer is not connected — set BUFFER_ACCESS_TOKEN",
            },
          },
          400,
        );
      }
      const connected = await bufferConnectedPlatforms().catch(() => null);
      const targets = connected ? platforms.filter((p) => connected[p]) : platforms;
      if (targets.length === 0) {
        return c.json(
          {
            error: {
              code: "not_connected",
              message: "none of the requested platforms have a connected Buffer channel",
            },
          },
          400,
        );
      }
      for (const platform of targets) {
        const [existing] = await db
          .select()
          .from(posts)
          .where(and(eq(posts.renderId, render.id), eq(posts.platform, platform)))
          .limit(1);
        if (existing?.status === "published") continue; // already live — never double-post
        const postId = existing?.id ?? newId();
        if (existing) {
          await db
            .update(posts)
            .set({ status: "publishing", failReason: null, updatedAt: new Date() })
            .where(eq(posts.id, postId));
        } else {
          await db.insert(posts).values({
            id: postId,
            briefId: brief.id,
            renderId: render.id,
            categoryId: brief.categoryId,
            platform,
            status: "publishing",
          });
        }
        await enqueue(Q.clipPublish, { postId });
      }
      return c.json({ ok: true, platforms: targets }, 202);
    },
  );

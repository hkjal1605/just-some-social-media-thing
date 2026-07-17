// Campaign routes (doc 11 §3, doc 05 §5 / doc 10 §3.6): CRUD for licensed-clipping campaigns
// and per-clip submission/payout tracking (feeds the Costs/Revenue page).
import { zValidator } from "@hono/zod-validator";
import { makeLogger, newId, Q } from "@ve/core";
import { campaignClips, campaigns, db, desc, eq, sql } from "@ve/db";
import { presignPut, r2Key } from "@ve/storage";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const log = makeLogger("api-campaigns");
const money = (v: number | undefined) => (v === undefined ? undefined : v.toString());

const CreateCampaign = z.object({
  name: z.string().min(1).max(200),
  marketplace: z.string().default("whop"),
  categoryId: z.string().uuid().optional(),
  ratePer1k: z.number().nonnegative().optional(),
  budgetUsd: z.number().nonnegative().optional(),
  rulesUrl: z.string().url().optional(),
  rulesNote: z.string().max(4000).optional(),
  sourceFootageNote: z.string().max(2000).optional(),
});
const PatchCampaign = CreateCampaign.partial().extend({ active: z.boolean().optional() });
const PatchClip = z.object({
  submittedUrl: z.string().url().optional(),
  payoutUsd: z.number().nonnegative().optional(),
  markSubmitted: z.boolean().optional(),
  markPaid: z.boolean().optional(),
});

export const campaignsRoutes = new Hono<AuthedEnv>()
  .get("/", async (c) => {
    const items = await db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
    return c.json({ items });
  })
  .post("/", zValidator("json", CreateCampaign), async (c) => {
    const b = c.req.valid("json");
    const id = newId();
    await db.insert(campaigns).values({
      id,
      name: b.name,
      marketplace: b.marketplace,
      categoryId: b.categoryId ?? null,
      ratePer1k: money(b.ratePer1k) ?? null,
      budgetUsd: money(b.budgetUsd) ?? null,
      rulesUrl: b.rulesUrl ?? null,
      rulesNote: b.rulesNote ?? null,
      sourceFootageNote: b.sourceFootageNote ?? null,
    });
    log.info({ campaignId: id, name: b.name }, "campaign created");
    return c.json({ id }, 201);
  })
  // licensed source footage: presign a PUT to the campaign's source key, then ingest → clip pipeline
  // (doc 05 §5). Convention matches the worker's resolveSource: campaigns/{id}/source/source.mp4.
  .post(
    "/:id/source",
    zValidator("json", z.object({ mime: z.string().default("video/mp4") })),
    async (c) => {
      const id = c.req.param("id");
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
      if (!campaign)
        return c.json({ error: { code: "not_found", message: "campaign not found" } }, 404);
      const key = r2Key.campaignSource(id, "source");
      const presignedPut = await presignPut(key, c.req.valid("json").mime, 3600);
      return c.json({ key, presignedPut });
    },
  )
  .post("/:id/ingest", async (c) => {
    const id = c.req.param("id");
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!campaign)
      return c.json({ error: { code: "not_found", message: "campaign not found" } }, 404);
    await enqueue(Q.clipTranscribe, { kind: "campaign", id });
    log.info({ campaignId: id }, "campaign source ingest → clip.transcribe");
    return c.json({ ok: true });
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!campaign)
      return c.json({ error: { code: "not_found", message: "campaign not found" } }, 404);
    // clips with their post platform + latest views + permalink (doc 10 §3.6)
    const clips = (await db.execute(sql`
      select cc.id, cc.post_id as "postId", cc.submitted_url as "submittedUrl",
             cc.submitted_at as "submittedAt", cc.payout_usd as "payoutUsd", cc.payout_at as "payoutAt",
             p.platform, p.permalink, p.status,
             (select s.views from post_snapshots s where s.post_id = p.id
              order by s.captured_at desc limit 1)::bigint as "views"
      from campaign_clips cc
      join posts p on p.id = cc.post_id
      where cc.campaign_id = ${id}
      order by cc.submitted_at desc nulls last
    `)) as unknown as Record<string, unknown>[];
    return c.json({
      campaign,
      clips: clips.map((r) => ({ ...r, views: r.views === null ? null : Number(r.views) })),
    });
  })
  .patch("/:id", zValidator("json", PatchCampaign), async (c) => {
    const id = c.req.param("id");
    const b = c.req.valid("json");
    const set: Record<string, unknown> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.marketplace !== undefined) set.marketplace = b.marketplace;
    if (b.categoryId !== undefined) set.categoryId = b.categoryId;
    if (b.ratePer1k !== undefined) set.ratePer1k = money(b.ratePer1k);
    if (b.budgetUsd !== undefined) set.budgetUsd = money(b.budgetUsd);
    if (b.rulesUrl !== undefined) set.rulesUrl = b.rulesUrl;
    if (b.rulesNote !== undefined) set.rulesNote = b.rulesNote;
    if (b.sourceFootageNote !== undefined) set.sourceFootageNote = b.sourceFootageNote;
    if (b.active !== undefined) set.active = b.active;
    if (Object.keys(set).length === 0) return c.json({ ok: true });
    const updated = await db.update(campaigns).set(set).where(eq(campaigns.id, id)).returning();
    if (updated.length === 0)
      return c.json({ error: { code: "not_found", message: "campaign not found" } }, 404);
    return c.json({ ok: true, campaign: updated[0] });
  });

/** POST /campaign-clips/:id — record submission / payout (Whop stays manual, doc 05 §5). */
export const campaignClipsRoutes = new Hono<AuthedEnv>().post(
  "/:id",
  zValidator("json", PatchClip),
  async (c) => {
    const id = c.req.param("id");
    const b = c.req.valid("json");
    const set: Record<string, unknown> = {};
    if (b.submittedUrl !== undefined) set.submittedUrl = b.submittedUrl;
    if (b.payoutUsd !== undefined) set.payoutUsd = money(b.payoutUsd);
    if (b.markSubmitted) set.submittedAt = new Date();
    if (b.markPaid) set.payoutAt = new Date();
    const updated = await db
      .update(campaignClips)
      .set(set)
      .where(eq(campaignClips.id, id))
      .returning();
    if (updated.length === 0) {
      return c.json({ error: { code: "not_found", message: "campaign clip not found" } }, 404);
    }
    return c.json({ ok: true, clip: updated[0] });
  },
);

// Engagement routes (doc 11 §3, doc 06 §6): list comments (optionally only those needing a
// human) and send a manual reply (enqueues a single engage.reply job).
import { zValidator } from "@hono/zod-validator";
import { makeLogger, Q } from "@ve/core";
import { and, db, desc, engagements, eq, isNull } from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const log = makeLogger("api-engagements");

const ListQuery = z.object({
  needsHuman: z.coerce.boolean().optional(),
  postId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const ReplyBody = z.object({ text: z.string().min(1).max(2000) });

export const engagementsRoutes = new Hono<AuthedEnv>()
  .get("/", zValidator("query", ListQuery), async (c) => {
    const q = c.req.valid("query");
    const conds = [];
    if (q.needsHuman) conds.push(eq(engagements.needsHuman, true));
    if (q.postId) conds.push(eq(engagements.postId, q.postId));
    // only surface un-replied ones when filtering for human attention
    if (q.needsHuman) conds.push(isNull(engagements.repliedAt));
    const items = await db
      .select()
      .from(engagements)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(engagements.seenAt))
      .limit(Math.min(q.limit ?? 100, 200));
    return c.json({ items });
  })

  .post("/:id/reply", zValidator("json", ReplyBody), async (c) => {
    const id = c.req.param("id");
    const { text } = c.req.valid("json");
    const [row] = await db.select().from(engagements).where(eq(engagements.id, id)).limit(1);
    if (!row) return c.json({ error: { code: "not_found", message: "engagement not found" } }, 404);
    if (row.repliedAt) {
      return c.json({ error: { code: "already_replied", message: "already replied" } }, 422);
    }
    await enqueue(Q.engageReply, { engagementId: id, text });
    log.info({ engagementId: id }, "manual reply enqueued");
    return c.json({ ok: true });
  });

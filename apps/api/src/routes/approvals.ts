// Approvals routes (doc 09 §3): the single transactional decision path plus the card/list
// endpoints the Telegram bot + dashboard consume. First decision wins; both surfaces converge.
import { zValidator } from "@hono/zod-validator";
import { env } from "@ve/config";
import {
  BRIEF_TRANSITIONS,
  canTransition,
  istParts,
  istWallToUtc,
  makeLogger,
  newId,
  type PostingWindow,
  parseHhMm,
  Q,
  type SettingsPostingWindows,
  toDisplay,
  windowActiveOnDay,
} from "@ve/core";
import {
  and,
  approvalEvents,
  approvalRowById,
  approvals,
  approvalsByStatus,
  briefs,
  db,
  eq,
  getSetting,
  type PendingApprovalRow,
  posts,
  transitionApproval,
  transitionBrief,
  transitionPost,
  withTx,
} from "@ve/db";
import { presignGet } from "@ve/storage";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

const log = makeLogger("api-approvals");

interface RenderPreview {
  id: string;
  platform: string;
  r2Key: string | null;
  thumbR2Key: string | null;
  bytes: number | null;
  durationSec: string | null;
}

function hookText(row: PendingApprovalRow): string {
  const variants = (row.hookVariants as { id: string; text: string }[] | null) ?? [];
  return variants.find((v) => v.id === row.chosenHook)?.text ?? variants[0]?.text ?? "";
}

/** Lightweight scheduler dry-run for the card: earliest upcoming window start for a platform. */
function nextSlotDisplay(
  windows: SettingsPostingWindows | null,
  platform: string,
  now: Date,
): string {
  const pw = (windows?.[platform as keyof SettingsPostingWindows] ?? []) as PostingWindow[];
  if (pw.length === 0) return "next available slot";
  for (let d = 0; d <= 3; d++) {
    const dayInstant = new Date(now.getTime() + d * 86_400_000);
    const { year, month, day, weekday } = istParts(dayInstant);
    const candidates: Date[] = [];
    for (const w of pw) {
      if (!windowActiveOnDay(w, weekday)) continue;
      const s = parseHhMm(w.start);
      const at = istWallToUtc(year, month, day, s.hour, s.minute);
      if (at.getTime() > now.getTime()) candidates.push(at);
    }
    candidates.sort((a, b) => a.getTime() - b.getTime());
    if (candidates[0]) return toDisplay(candidates[0]);
  }
  return "next available slot";
}

/** Compact list/summary shape (bot reads {items:[{id}]}; dashboard reads the rest). */
function summarize(row: PendingApprovalRow) {
  const renders = (row.renders as RenderPreview[] | null) ?? [];
  return {
    id: row.id,
    briefId: row.briefId,
    status: row.status,
    categoryName: row.categoryName,
    categorySlug: row.categorySlug,
    formatSlug: row.formatSlug,
    angle: row.angle,
    hook: hookText(row),
    platforms: (row.targetPlatforms as string[] | null) ?? [],
    trendHeadline: row.trendHeadline,
    aiDisclosure: row.aiDisclosure ?? false,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    // raw db.execute returns bigint as string — coerce (tg message ids fit in a JS number)
    tgMessageId:
      row.tgMessageId === null || row.tgMessageId === undefined ? null : Number(row.tgMessageId),
    renderCount: renders.length,
  };
}

async function buildCard(row: PendingApprovalRow) {
  const renders = (row.renders as RenderPreview[] | null) ?? [];
  const first = renders.find((r) => r.r2Key);
  const windows = await getSetting<SettingsPostingWindows>("posting_windows");
  const platforms = (row.targetPlatforms as string[] | null) ?? [];
  const card: Record<string, unknown> = {
    id: row.id,
    categoryName: row.categoryName,
    formatSlug: row.formatSlug,
    angle: row.angle,
    hook: hookText(row),
    // full hook set + chosen id so the dashboard can render the a/b/c radio (doc 09 §4)
    hookVariants: (row.hookVariants as { id: string; text: string }[] | null) ?? [],
    chosenHook: row.chosenHook,
    // per-platform captions "as will be sent" — read-only display in the dashboard (doc 09 §4)
    captions: row.perPlatformCaptions ?? null,
    platforms,
    plannedSlotDisplay: nextSlotDisplay(windows, platforms[0] ?? "tiktok", new Date()),
    aiDisclosure: row.aiDisclosure ?? false,
    dashboardUrl: `${env.APP_BASE_URL}/approvals`,
    bodyPreview: row.bodyPreview ?? "",
  };
  if (row.trendHeadline) card.trendHeadline = row.trendHeadline;
  if (first?.r2Key) {
    card.previewVideoUrl = await presignGet(first.r2Key, 3600);
    if (first.bytes !== null) card.previewBytes = first.bytes;
  }
  // thumbnail is the fallback preview when the render is too big to URL-send to Telegram (doc 09 §2)
  if (first?.thumbR2Key) card.previewThumbUrl = await presignGet(first.thumbR2Key, 3600);
  return card;
}

const DecideBody = z.object({
  decision: z.enum(["approved", "rejected", "edit_requested"]),
  reason: z.string().max(1000).optional(),
  editInstructions: z.string().max(2000).optional(),
  via: z.enum(["telegram", "dashboard"]),
  tgUserId: z.number().int().optional(),
});
const ListQuery = z.object({ status: z.string().optional() });
const TgMessageBody = z.object({ tgMessageId: z.number().int() });

export const approvalsRoutes = new Hono<AuthedEnv>()
  .get("/", zValidator("query", ListQuery), async (c) => {
    const { status } = c.req.valid("query");
    const rows = await approvalsByStatus(status);
    return c.json({ items: rows.map(summarize) });
  })
  .get("/:id", async (c) => {
    const row = await approvalRowById(c.req.param("id"));
    if (!row) return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    return c.json(summarize(row));
  })
  .get("/:id/card", async (c) => {
    const row = await approvalRowById(c.req.param("id"));
    if (!row) return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    return c.json(await buildCard(row));
  })
  .post("/:id/tg-message", zValidator("json", TgMessageBody), async (c) => {
    const id = c.req.param("id");
    const { tgMessageId } = c.req.valid("json");
    const updated = await db
      .update(approvals)
      .set({ tgMessageId })
      .where(eq(approvals.id, id))
      .returning({ id: approvals.id });
    if (updated.length === 0) {
      return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    }
    return c.json({ ok: true });
  })
  // the single transactional decision path (doc 09 §1) — row lock, first decision wins
  .post("/:id/decide", zValidator("json", DecideBody), async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const actor =
      body.via === "telegram"
        ? body.tgUserId
          ? `tg:${body.tgUserId}`
          : "telegram"
        : c.get("admin").username;
    const now = new Date();

    const outcome = await withTx(async (tx) => {
      const [ap] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update");
      if (!ap) return { kind: "not_found" as const };

      if (ap.status !== "pending") {
        // race: someone (or another surface) already decided — record + report, don't throw
        await tx.insert(approvalEvents).values({
          id: newId(),
          approvalId: id,
          event: "race_ignored",
          actor,
          detail: { attempted: body.decision, priorStatus: ap.status },
        });
        return { kind: "raced" as const };
      }

      const [brief] = await tx.select().from(briefs).where(eq(briefs.id, ap.briefId)).limit(1);
      const awaiting = await tx
        .select()
        .from(posts)
        .where(and(eq(posts.briefId, ap.briefId), eq(posts.status, "awaiting_approval")));

      const decidePatch = {
        decidedVia: body.via,
        decidedAt: now,
        ...(body.tgUserId !== undefined ? { decidedByTgUserId: body.tgUserId } : {}),
      };

      if (body.decision === "approved") {
        await transitionApproval(tx, id, "approved", decidePatch);
        for (const p of awaiting) await transitionPost(tx, p.id, "approved");
        await tx.insert(approvalEvents).values({
          id: newId(),
          approvalId: id,
          event: "approved",
          actor,
          detail: { via: body.via },
        });
        return { kind: "approved" as const, briefId: ap.briefId };
      }

      if (body.decision === "rejected") {
        await transitionApproval(tx, id, "rejected", { ...decidePatch, rejectReason: body.reason });
        for (const p of awaiting) await transitionPost(tx, p.id, "draft");
        if (brief && canTransition(BRIEF_TRANSITIONS, brief.status, "abandoned")) {
          await transitionBrief(tx, brief.id, "abandoned", { blockedReason: "rejected" });
        }
        await tx.insert(approvalEvents).values({
          id: newId(),
          approvalId: id,
          event: "rejected",
          actor,
          detail: { reason: body.reason ?? null },
        });
        return { kind: "rejected" as const };
      }

      // edit_requested → re-script (v+1) with instructions → new render/approval cycle
      await transitionApproval(tx, id, "edit_requested", {
        ...decidePatch,
        editInstructions: body.editInstructions,
      });
      for (const p of awaiting) await transitionPost(tx, p.id, "draft");
      if (brief && canTransition(BRIEF_TRANSITIONS, brief.status, "scripted")) {
        await transitionBrief(tx, brief.id, "scripted");
      }
      await tx.insert(approvalEvents).values({
        id: newId(),
        approvalId: id,
        event: "edit_requested",
        actor,
        detail: { editInstructions: body.editInstructions ?? null },
      });
      return {
        kind: "edit_requested" as const,
        briefId: ap.briefId,
        editInstructions: body.editInstructions,
      };
    });

    if (outcome.kind === "not_found") {
      return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    }
    if (outcome.kind === "raced") return c.json({ ok: false, raced: true });

    // side effects after the row lock is released
    if (outcome.kind === "approved") {
      await enqueue(Q.publishPlan, { fastPathBriefId: outcome.briefId });
    } else if (outcome.kind === "edit_requested") {
      await enqueue(Q.factoryScript, {
        briefId: outcome.briefId,
        ...(outcome.editInstructions ? { editInstructions: outcome.editInstructions } : {}),
      });
    }
    log.info({ approvalId: id, decision: body.decision, via: body.via }, "approval decided");
    return c.json({ ok: true });
  });

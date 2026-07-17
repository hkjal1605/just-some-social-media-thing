// approval.request (doc 09 §1, worker side) — the bridge from Factory to Distribution.
// The factory enqueues this after the pre_publish compliance gate passes. Two paths:
//   • auto-approve   (full_auto_candidate category + format earned auto-approval)
//       → approvals.auto_approved, posts → approved, enqueue publish.plan fast-path.
//   • human approval (everything else, incl. politics/football/f1 forever)
//       → pending approvals row, posts → awaiting_approval, card sent by the bot (doc 09).
// The human decision surface (Telegram bot + /decide API) is doc 09; this worker only
// creates the data and wires the auto path end to end.
import {
  APPROVAL_TTL_HOURS,
  type CategoriesAutoApproveFormats,
  makeLogger,
  newId,
  Q,
} from "@ve/core";
import {
  approvalEvents,
  approvals,
  briefs,
  categories,
  db,
  desc,
  eq,
  posts,
  transitionPost,
} from "@ve/db";
import { sendApprovalCard } from "@ve/telegram";
import { type Enqueuer, enqueueAlert } from "../../harness";

const log = makeLogger("approvals-request");

/** Auto-approve iff category is a full-auto candidate and the format earned it (doc 09 §5). */
export function shouldAutoApprove(
  category: typeof categories.$inferSelect,
  formatSlug: string,
): boolean {
  if (category.mode !== "full_auto_candidate") return false; // human_gated/radar_only never auto
  const earned = (category.autoApproveFormats ?? []) as CategoriesAutoApproveFormats;
  return earned.includes(formatSlug);
}

export async function approvalRequestHandler(
  payload: { briefId: string },
  boss: Enqueuer,
): Promise<{ outcome: "auto_approved" | "pending" | "skipped" }> {
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, payload.briefId)).limit(1);
  if (!brief) throw new Error(`approval.request: brief ${payload.briefId} missing`);
  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, brief.categoryId))
    .limit(1);
  if (!category) throw new Error(`approval.request: category for brief ${brief.id} missing`);

  // idempotency: skip if a live approval already exists (doc 08 §11). rejected/expired are dead
  // ends; edit_requested is ALSO recyclable — the edit flow produces a v2 render that needs a NEW
  // approval card (doc 09 §1), so it must not block creation here (H4b).
  const [existing] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.briefId, brief.id))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  if (existing && !["rejected", "expired", "edit_requested"].includes(existing.status)) {
    log.info({ briefId: brief.id, approvalId: existing.id }, "approval.request no-op (exists)");
    return { outcome: "skipped" };
  }

  const draftPosts = await db.select().from(posts).where(eq(posts.briefId, brief.id));
  if (draftPosts.length === 0) {
    log.warn({ briefId: brief.id }, "approval.request: no posts for brief — nothing to gate");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_HOURS * 3_600_000);
  const auto = shouldAutoApprove(category, brief.formatSlug);
  const approvalId = newId();

  await db.insert(approvals).values({
    id: approvalId,
    briefId: brief.id,
    status: auto ? "auto_approved" : "pending",
    expiresAt,
    ...(auto ? { decidedVia: "auto", decidedAt: now } : {}),
  });
  await db.insert(approvalEvents).values({
    id: newId(),
    approvalId,
    event: "created",
    actor: "system",
    detail: { auto },
  });

  if (auto) {
    // draft → awaiting_approval → approved for every post, then schedule fast-path
    for (const p of draftPosts) {
      if (p.status === "draft") {
        await transitionPost(db, p.id, "awaiting_approval");
        await transitionPost(db, p.id, "approved");
      }
    }
    await db.insert(approvalEvents).values({
      id: newId(),
      approvalId,
      event: "approved",
      actor: "system",
      detail: { via: "auto" },
    });
    await boss.send(Q.publishPlan, { fastPathBriefId: brief.id });
    log.info(
      { briefId: brief.id, approvalId, posts: draftPosts.length },
      "auto-approved → scheduling",
    );
    return { outcome: "auto_approved" };
  }

  // human path: park posts awaiting approval, then push the interactive approval card to the
  // Telegram group (doc 09 §1). sendApprovalCard stores the tgMessageId via the API and no-ops
  // cleanly when Telegram isn't configured; the dashboard surfaces the pending approval regardless.
  for (const p of draftPosts) {
    if (p.status === "draft") await transitionPost(db, p.id, "awaiting_approval");
  }
  try {
    await sendApprovalCard(approvalId);
  } catch (err) {
    // card delivery is best-effort — a TG/API hiccup must not fail the job or lose the approval
    log.warn(
      { briefId: brief.id, approvalId, err },
      "approval card send failed (dashboard still has it)",
    );
    await enqueueAlert(
      boss,
      `📝 Approval needed (card send failed) | ${category.slug} · ${brief.formatSlug} | brief:${brief.id}`,
      `approval-pending:${brief.id}`,
    );
  }
  log.info({ briefId: brief.id, approvalId }, "awaiting human approval");
  return { outcome: "pending" };
}

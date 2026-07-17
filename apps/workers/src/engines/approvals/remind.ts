// approval.remind (doc 08 §3 cron, hourly; logic doc 09 §1): nudge stale pending approvals,
// then expire them. A pending approval with <4h left gets one reminder ping; once past its
// 24h TTL it expires and its brief is abandoned — unless the trend is still hot (llmScore≥80),
// in which case it renews once. Every step records an approval_event.
import {
  APPROVAL_REMIND_WINDOW_HOURS,
  APPROVAL_RENEW_MIN_LLM_SCORE,
  APPROVAL_TTL_HOURS,
  makeLogger,
  newId,
} from "@ve/core";
import {
  approvalEvents,
  approvals,
  briefs,
  db,
  eq,
  transitionApproval,
  transitionBrief,
  trends,
} from "@ve/db";
import { updateApprovalCard } from "@ve/telegram";

const log = makeLogger("approvals-remind");

export type RemindAction = "none" | "remind" | "renew" | "expire";

/** Pure decision (doc 09 §1). Renew only once, and only for a still-hot trend. */
export function remindDecision(input: {
  expiresAt: Date;
  hasReminded: boolean;
  hasRenewed: boolean;
  trendHot: boolean; // trend still live AND llmScore ≥ threshold
  now: Date;
}): RemindAction {
  const msLeft = input.expiresAt.getTime() - input.now.getTime();
  if (msLeft <= 0) {
    return !input.hasRenewed && input.trendHot ? "renew" : "expire";
  }
  if (msLeft <= APPROVAL_REMIND_WINDOW_HOURS * 3_600_000 && !input.hasReminded) {
    return "remind";
  }
  return "none";
}

export interface RemindResult {
  scanned: number;
  reminded: number;
  renewed: number;
  expired: number;
}

export async function approvalRemindHandler(
  _payload: Record<string, never>,
  _boss: unknown,
  now: Date = new Date(),
): Promise<RemindResult> {
  const pending = await db.select().from(approvals).where(eq(approvals.status, "pending"));
  const res: RemindResult = { scanned: pending.length, reminded: 0, renewed: 0, expired: 0 };

  for (const a of pending) {
    const [brief] = await db.select().from(briefs).where(eq(briefs.id, a.briefId)).limit(1);
    const trend = brief?.trendId
      ? (await db.select().from(trends).where(eq(trends.id, brief.trendId)).limit(1))[0]
      : undefined;
    const events = await db
      .select()
      .from(approvalEvents)
      .where(eq(approvalEvents.approvalId, a.id));
    const trendHot =
      !!trend &&
      (trend.status === "active" || trend.status === "briefed") &&
      (trend.llmScore ?? 0) >= APPROVAL_RENEW_MIN_LLM_SCORE;

    const action = remindDecision({
      expiresAt: a.expiresAt,
      hasReminded: events.some((e) => e.event === "reminded"),
      hasRenewed: events.some((e) => e.event === "renewed"),
      trendHot,
      now,
    });

    if (action === "remind") {
      const hoursLeft = Math.max(0, Math.ceil((a.expiresAt.getTime() - now.getTime()) / 3_600_000));
      await updateApprovalCard(a.id, `⏰ expires in ~${hoursLeft}h — please review`).catch((err) =>
        log.warn({ err, approvalId: a.id }, "reminder card update failed (best effort)"),
      );
      await db
        .insert(approvalEvents)
        .values({ id: newId(), approvalId: a.id, event: "reminded", actor: "system" });
      res.reminded++;
      log.info({ approvalId: a.id, hoursLeft }, "approval reminder sent");
    } else if (action === "renew") {
      const newExpiry = new Date(now.getTime() + APPROVAL_TTL_HOURS * 3_600_000);
      await transitionApproval(db, a.id, "expired");
      await transitionApproval(db, a.id, "pending", { expiresAt: newExpiry });
      await db.insert(approvalEvents).values({
        id: newId(),
        approvalId: a.id,
        event: "renewed",
        actor: "system",
        detail: {
          trendId: trend?.id,
          llmScore: trend?.llmScore,
          newExpiry: newExpiry.toISOString(),
        },
      });
      res.renewed++;
      log.info({ approvalId: a.id, trendId: trend?.id }, "approval renewed (trend still hot)");
    } else if (action === "expire") {
      await transitionApproval(db, a.id, "expired");
      if (brief && brief.status !== "abandoned") {
        await transitionBrief(db, brief.id, "abandoned", {
          blockedReason: "approval_expired",
        }).catch((err) => log.warn({ err, briefId: brief.id }, "brief abandon on expiry failed"));
      }
      await db.insert(approvalEvents).values({
        id: newId(),
        approvalId: a.id,
        event: "expired",
        actor: "system",
      });
      res.expired++;
      log.info({ approvalId: a.id, briefId: a.briefId }, "approval expired → brief abandoned");
    }
  }

  if (res.reminded || res.renewed || res.expired) {
    log.info(res, "approval.remind sweep complete");
  }
  return res;
}

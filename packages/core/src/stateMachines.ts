// Allowed status transitions (doc 02 §5). DB-update helpers in @ve/db enforce these;
// any transition not listed throws. Workers must never raw-update status columns.
import type { ApprovalStatus, BriefStatus, PostStatus, RenderStatus, TrendStatus } from "./enums";

export type TransitionMap<S extends string> = Record<S, readonly S[]>;

export const POST_TRANSITIONS: TransitionMap<PostStatus> = {
  draft: ["awaiting_approval", "deleted"],
  awaiting_approval: ["approved", "draft", "deleted"], // draft = edit requested
  approved: ["scheduled", "deleted"],
  scheduled: ["publishing", "approved", "deleted"], // back to approved if slot re-planned
  publishing: ["published", "failed"],
  published: ["failed", "deleted"], // failed = platform rejected after an optimistic 200 (publish.verify, doc 06 §5)
  failed: ["scheduled", "deleted"], // retry re-schedules
  deleted: [],
};

export const BRIEF_TRANSITIONS: TransitionMap<BriefStatus> = {
  draft: ["scripted", "blocked", "abandoned"],
  scripted: ["producing", "blocked", "abandoned"],
  producing: ["ready", "blocked", "abandoned"],
  blocked: ["draft", "scripted", "producing", "abandoned"],
  ready: ["scripted", "abandoned"], // scripted = edit-requested rewrite cycle (doc 09 §1)
  abandoned: [],
};

export const APPROVAL_TRANSITIONS: TransitionMap<ApprovalStatus> = {
  pending: ["approved", "rejected", "edit_requested", "expired"],
  expired: ["pending"], // one renewal when the trend is still hot (doc 09 §1)
  approved: [],
  rejected: [],
  edit_requested: [],
  auto_approved: [], // created directly in this state, never transitions
};

export const RENDER_TRANSITIONS: TransitionMap<RenderStatus> = {
  pending: ["rendering"],
  rendering: ["done", "failed"],
  failed: ["rendering"],
  done: [], // re-render replaces the row (doc 08 §11)
};

export const TREND_TRANSITIONS: TransitionMap<TrendStatus> = {
  active: ["briefed", "expired", "suppressed"],
  briefed: ["expired", "suppressed"],
  expired: [],
  suppressed: [],
};

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return (map[from] ?? []).includes(to);
}

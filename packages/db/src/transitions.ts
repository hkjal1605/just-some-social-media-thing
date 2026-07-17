// Status transitions with row locks (doc 02 §5). Workers must use these helpers —
// never raw `update` on status columns. Any transition not in the map throws.
import {
  APPROVAL_TRANSITIONS,
  type ApprovalStatus,
  BRIEF_TRANSITIONS,
  type BriefStatus,
  POST_TRANSITIONS,
  type PostStatus,
  RENDER_TRANSITIONS,
  type RenderStatus,
  TREND_TRANSITIONS,
  type TransitionMap,
  type TrendStatus,
} from "@ve/core";
import { eq } from "drizzle-orm";
import { type DbOrTx, db, type Tx, withTx } from "./client";
import { approvals, briefs, posts, renders, trends } from "./schema";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`invalid ${entity} transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class EntityNotFoundError extends Error {
  constructor(
    public readonly entity: string,
    public readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = "EntityNotFoundError";
  }
}

type AnyTable = typeof posts | typeof briefs | typeof approvals | typeof renders | typeof trends;

interface EntityConfig<S extends string> {
  entity: string;
  table: AnyTable;
  map: TransitionMap<S>;
  hasUpdatedAt: boolean;
}

async function transitionIn<S extends string, Row>(
  tx: Tx,
  cfg: EntityConfig<S>,
  id: string,
  to: S,
  patch: Record<string, unknown>,
): Promise<Row> {
  const table = cfg.table;
  const [row] = await tx.select().from(table).where(eq(table.id, id)).for("update");
  if (!row) throw new EntityNotFoundError(cfg.entity, id);
  const from = (row as unknown as { status: S }).status;
  if (!(cfg.map[from] ?? []).includes(to)) throw new InvalidTransitionError(cfg.entity, from, to);
  // patch first, then status — a caller's patch can never override the validated target status
  const set: Record<string, unknown> = { ...patch, status: to };
  if (cfg.hasUpdatedAt) set.updatedAt = new Date();
  const [updated] = await tx.update(table).set(set).where(eq(table.id, id)).returning();
  return updated as Row;
}

function makeTransition<S extends string, Row>(cfg: EntityConfig<S>) {
  return async (
    dbx: DbOrTx,
    id: string,
    to: S,
    patch: Record<string, unknown> = {},
  ): Promise<Row> => {
    // FOR UPDATE needs a transaction: reuse the caller's, else open one.
    if (dbx === db) return withTx((tx) => transitionIn<S, Row>(tx, cfg, id, to, patch));
    return transitionIn<S, Row>(dbx as Tx, cfg, id, to, patch);
  };
}

export const transitionPost = makeTransition<PostStatus, typeof posts.$inferSelect>({
  entity: "post",
  table: posts,
  map: POST_TRANSITIONS,
  hasUpdatedAt: true,
});

export const transitionBrief = makeTransition<BriefStatus, typeof briefs.$inferSelect>({
  entity: "brief",
  table: briefs,
  map: BRIEF_TRANSITIONS,
  hasUpdatedAt: true,
});

export const transitionApproval = makeTransition<ApprovalStatus, typeof approvals.$inferSelect>({
  entity: "approval",
  table: approvals,
  map: APPROVAL_TRANSITIONS,
  hasUpdatedAt: false,
});

export const transitionRender = makeTransition<RenderStatus, typeof renders.$inferSelect>({
  entity: "render",
  table: renders,
  map: RENDER_TRANSITIONS,
  hasUpdatedAt: true,
});

export const transitionTrend = makeTransition<TrendStatus, typeof trends.$inferSelect>({
  entity: "trend",
  table: trends,
  map: TREND_TRANSITIONS,
  hasUpdatedAt: true,
});

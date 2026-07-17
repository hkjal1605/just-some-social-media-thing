// Ops observability queries (doc 08 §10): a thin read over pg-boss's own job table plus a
// few app-table counters that back GET /ops/jobs and GET /ops/summary. All pgboss reads are
// guarded — if the pgboss schema isn't initialized yet (api started before workers ever ran),
// they degrade to empty/zero instead of throwing.
import { env } from "@ve/config";
import type { BudgetState } from "@ve/core";
import { sql } from "drizzle-orm";
import { db } from "../client";
import { getSetting } from "../settings";
import { spendMonthToDate } from "./costs";

const PGB = env.PGBOSS_SCHEMA;
const HEARTBEAT_STALE_MS = 5 * 60_000;

export interface RecentJob {
  id: string;
  name: string;
  state: string;
  retryCount: number;
  createdOn: Date;
  startedOn: Date | null;
  completedOn: Date | null;
}

/** jobs_recent (doc 08 §10): id, name, state, retrycount, started/completed — newest first. */
export async function recentJobs(
  opts: { state?: string; limit?: number } = {},
): Promise<RecentJob[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  try {
    const rows = (await db.execute(sql`
      select id, name, state::text as state, retry_count as "retryCount",
             created_on as "createdOn", started_on as "startedOn", completed_on as "completedOn"
      from ${sql.identifier(PGB)}.job
      ${opts.state ? sql`where state::text = ${opts.state}` : sql``}
      order by created_on desc
      limit ${limit}
    `)) as unknown as RecentJob[];
    return rows;
  } catch {
    return [];
  }
}

export interface QueueDepth {
  name: string;
  pending: number;
  active: number;
  failed: number;
}

/** Per-queue depth from pgboss.job (pending = created+retry). */
export async function queueDepths(): Promise<QueueDepth[]> {
  try {
    const rows = (await db.execute(sql`
      select name,
        count(*) filter (where state in ('created','retry'))::int as pending,
        count(*) filter (where state = 'active')::int as active,
        count(*) filter (where state = 'failed')::int as failed
      from ${sql.identifier(PGB)}.job
      group by name
      order by pending desc, name asc
    `)) as unknown as QueueDepth[];
    return rows;
  } catch {
    return [];
  }
}

/** Dead-letter/exhausted jobs (doc 08 §10 DLQ count) = jobs left in the failed state. */
export async function deadLetterCount(): Promise<number> {
  try {
    const rows = (await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(PGB)}.job where state = 'failed'`,
    )) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

async function scalarInt(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

export async function pendingApprovalsCount(): Promise<number> {
  return scalarInt(sql`select count(*)::int as n from approvals where status = 'pending'`);
}

export async function oldestPendingApprovalAt(): Promise<Date | null> {
  const rows = (await db.execute(
    sql`select min(created_at) as "at" from approvals where status = 'pending'`,
  )) as unknown as { at: Date | string | null }[];
  const at = rows[0]?.at ?? null;
  return at ? new Date(at) : null;
}

/** Posts published "today" in the display timezone (doc 08 §10 / bot /status). */
export async function postsPublishedToday(tz: string = env.DISPLAY_TZ): Promise<number> {
  return scalarInt(sql`
    select count(*)::int as n from posts
    where status = 'published' and published_at is not null
      and (published_at at time zone ${tz})::date = (now() at time zone ${tz})::date
  `);
}

export interface OpsSummary {
  killSwitch: boolean;
  workersHeartbeat: string | null;
  workersStale: boolean;
  pendingApprovals: number;
  oldestPendingApprovalMinutes: number | null;
  postsToday: number;
  spendMtd: number;
  budget: BudgetState | null;
  dlqCount: number;
  queues: QueueDepth[];
}

/** Everything GET /ops/summary needs except the boss cron schedules (added by the route). */
export async function opsSummary(): Promise<OpsSummary> {
  const [
    killSwitch,
    heartbeat,
    budget,
    pendingApprovals,
    oldestAt,
    postsToday,
    spendMtd,
    dlqCount,
    queues,
  ] = await Promise.all([
    getSetting<boolean>("kill_switch"),
    getSetting<string>("workers_heartbeat"),
    getSetting<BudgetState>("budget_state"),
    pendingApprovalsCount(),
    oldestPendingApprovalAt(),
    postsPublishedToday(),
    spendMonthToDate(),
    deadLetterCount(),
    queueDepths(),
  ]);

  const workersStale = heartbeat
    ? Date.now() - new Date(heartbeat).getTime() > HEARTBEAT_STALE_MS
    : true;
  const oldestPendingApprovalMinutes = oldestAt
    ? Math.round((Date.now() - oldestAt.getTime()) / 60_000)
    : null;

  return {
    killSwitch: killSwitch === true,
    workersHeartbeat: heartbeat,
    workersStale,
    pendingApprovals,
    oldestPendingApprovalMinutes,
    postsToday,
    spendMtd,
    budget: budget ?? null,
    dlqCount,
    queues,
  };
}

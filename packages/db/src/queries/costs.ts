import { sql } from "drizzle-orm";
import { db } from "../client";

export interface ServiceCostRow {
  service: string;
  kind: "llm" | "api";
  units: number | null;
  costUsd: number;
}

export interface AgentCostRow {
  agent: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  p95DurationMs: number | null;
}

/** Month is 'YYYY-MM'. Union of llm_usage (by provider) and api_usage (by service) (doc 02 §7). */
export async function costsByServiceMonth(
  month: string,
): Promise<{ services: ServiceCostRow[]; agents: AgentCostRow[] }> {
  const services = (await db.execute(sql`
    select provider as service, 'llm' as kind,
           sum(coalesce(units, 0))::float as units, sum(cost_usd)::float as "costUsd"
    from llm_usage
    where to_char(at at time zone 'UTC', 'YYYY-MM') = ${month}
    group by provider
    union all
    select service, 'api' as kind,
           sum(units)::float as units, sum(cost_usd)::float as "costUsd"
    from api_usage
    where to_char(at at time zone 'UTC', 'YYYY-MM') = ${month}
    group by service
    order by "costUsd" desc
  `)) as unknown as ServiceCostRow[];

  const agents = (await db.execute(sql`
    select agent,
           count(*)::int as calls,
           sum(coalesce(input_tokens, 0))::bigint as "inputTokens",
           sum(coalesce(output_tokens, 0))::bigint as "outputTokens",
           sum(coalesce(cost_usd, 0))::float as "costUsd",
           (percentile_cont(0.95) within group (order by duration_ms))::int as "p95DurationMs"
    from agent_runs
    where to_char(started_at at time zone 'UTC', 'YYYY-MM') = ${month}
    group by agent
    order by "costUsd" desc
  `)) as unknown as AgentCostRow[];

  return { services, agents };
}

/** Month-to-date total spend in USD (llm + api) — budget guard input (doc 08 §7). */
export async function spendMonthToDate(): Promise<number> {
  const rows = (await db.execute(sql`
    select
      coalesce((select sum(cost_usd) from llm_usage
        where date_trunc('month', at) = date_trunc('month', now())), 0)::float
      +
      coalesce((select sum(cost_usd) from api_usage
        where date_trunc('month', at) = date_trunc('month', now())), 0)::float
      as total
  `)) as unknown as { total: number }[];
  return rows[0]?.total ?? 0;
}

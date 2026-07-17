// Costs route (doc 11 §3, doc 10 §3.8): MTD spend by service + per-agent table + revenue
// (campaign payouts + manual platform payouts from settings) + the budget guard snapshot.
import { zValidator } from "@hono/zod-validator";
import type { BudgetState } from "@ve/core";
import { costsByServiceMonth, db, getSetting, sql } from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";

const Query = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

function currentMonthUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const costsRoutes = new Hono<AuthedEnv>().get("/", zValidator("query", Query), async (c) => {
  const month = c.req.valid("query").month ?? currentMonthUtc();
  const { services, agents } = await costsByServiceMonth(month);

  const campaignRows = (await db.execute(sql`
    select coalesce(sum(payout_usd), 0)::float as total from campaign_clips
    where payout_at is not null and to_char(payout_at at time zone 'UTC', 'YYYY-MM') = ${month}
  `)) as unknown as { total: number }[];
  const campaignRevenue = campaignRows[0]?.total ?? 0;

  // manual platform payouts entered in Settings: { 'YYYY-MM': usd }
  const platformPayouts = (await getSetting<Record<string, number>>("platform_payouts")) ?? {};
  const platformRevenue = Number(platformPayouts[month] ?? 0);

  const spend = services.reduce((sum, s) => sum + s.costUsd, 0);
  const budget = (await getSetting<BudgetState>("budget_state")) ?? null;

  return c.json({
    month,
    services,
    agents,
    spend,
    revenue: {
      campaigns: campaignRevenue,
      platform: platformRevenue,
      total: campaignRevenue + platformRevenue,
    },
    netUsd: campaignRevenue + platformRevenue - spend,
    budget,
  });
});

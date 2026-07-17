// Dashboard data routes (doc 11 §3, doc 10 §3.1): the KPI bundle + presign helper for previews.
import { zValidator } from "@hono/zod-validator";
import { env } from "@ve/config";
import { dashboardKpis, dashboardTimeseries } from "@ve/db";
import { isKnownKey, presignGet } from "@ve/storage";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";

export const dashboardRoutes = new Hono<AuthedEnv>()
  .get("/kpis", async (c) => {
    // budget comes from config (packages/config) — the Overview spend tile reads it (doc 10 §3.1)
    return c.json({ ...(await dashboardKpis()), budgetMonthlyUsd: env.COST_BUDGET_MONTHLY_USD });
  })
  .get(
    "/timeseries",
    zValidator("query", z.object({ days: z.coerce.number().int().min(1).max(90).optional() })),
    async (c) => {
      return c.json(await dashboardTimeseries(c.req.valid("query").days ?? 14));
    },
  );

/** GET /assets/presign?key= — presigned GET for dashboard/TG previews (validates key prefix). */
export const assetsRoutes = new Hono<AuthedEnv>().get(
  "/presign",
  zValidator(
    "query",
    z.object({
      key: z.string().min(1),
      ttl: z.coerce.number().int().min(60).max(86_400).optional(),
    }),
  ),
  async (c) => {
    const { key, ttl } = c.req.valid("query");
    if (!isKnownKey(key)) {
      return c.json(
        { error: { code: "forbidden_key", message: "key not in a known namespace" } },
        403,
      );
    }
    const url = await presignGet(key, ttl ?? 3600);
    return c.json({ url });
  },
);

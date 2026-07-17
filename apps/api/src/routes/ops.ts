// Ops observability routes (doc 08 §10): GET /ops/summary (heartbeat, DLQ, queue depths, last
// crons, pending approvals, spend MTD, kill-switch, posts today) and GET /ops/jobs (recent
// pg-boss jobs, read-only). Both back the dashboard Ops widget and the bot /status command.
import { zValidator } from "@hono/zod-validator";
import { bossStarted, getBoss, opsSummary, recentJobs } from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";

const JobsQuery = z.object({
  state: z.enum(["created", "retry", "active", "completed", "cancelled", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const opsRoutes = new Hono<AuthedEnv>()
  .get("/summary", async (c) => {
    const summary = await opsSummary();
    // last cron firings from the boss schedules, when the boss is up in this process
    let schedules: { name: string; cron: string; tz?: string }[] = [];
    if (bossStarted()) {
      try {
        schedules = (await getBoss().getSchedules()).map((s) => ({
          name: s.name,
          cron: s.cron,
          ...(s.options?.tz ? { tz: s.options.tz } : {}),
        }));
      } catch {
        schedules = [];
      }
    }
    return c.json({ ...summary, schedules });
  })
  .get("/jobs", zValidator("query", JobsQuery), async (c) => {
    const q = c.req.valid("query");
    const items = await recentJobs({
      ...(q.state ? { state: q.state } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return c.json({ items });
  });

// Settings routes (doc 11 §3, doc 08 §6): the kill-switch toggle (fires a TG alert), plus the
// whitelisted read/write for the operator knobs (posting windows, engagement, caps, thresholds).
import { zValidator } from "@hono/zod-validator";
import { integrations } from "@ve/config";
import { Q, SettingsPostingWindowsSchema, ThresholdProgressSchema } from "@ve/core";
import { db, getSetting, inArray, setSetting, settings as settingsTable } from "@ve/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../auth";
import { enqueue } from "../enqueue";

// keys the dashboard may write, each with the schema its value must satisfy (doc 08 §5). Validating
// on write is what keeps a bad posting_windows from later crashing every publish.plan cron.
const WRITABLE_SETTINGS = {
  posting_windows: SettingsPostingWindowsSchema,
  engage_auto_reply: z.record(z.boolean()), // { [categorySlug]: true }
  x_monthly_read_cap_usd: z.number().nonnegative(),
  threshold_progress: ThresholdProgressSchema,
  warmup_until: z.record(z.string()), // { [platform]: ISO date }
  tiktok_weekend_am: z.boolean(),
  platform_payouts: z.record(z.number()), // { 'YYYY-MM': usd }
} as const;
const WHITELIST = Object.keys(WRITABLE_SETTINGS) as (keyof typeof WRITABLE_SETTINGS)[];
type WhitelistKey = keyof typeof WRITABLE_SETTINGS;
const isWhitelisted = (k: string): k is WhitelistKey => Object.hasOwn(WRITABLE_SETTINGS, k);

const KillBody = z.object({ on: z.boolean(), reason: z.string().max(200).optional() });
const PutBody = z.object({ value: z.unknown() });

export const settingsRoutes = new Hono<AuthedEnv>()
  // ── kill-switch (specific route first so PUT /:key never shadows it) ──
  .get("/kill-switch", async (c) => {
    return c.json({ on: (await getSetting<boolean>("kill_switch")) === true });
  })
  .put("/kill-switch", zValidator("json", KillBody), async (c) => {
    const { on, reason } = c.req.valid("json");
    await setSetting("kill_switch", on);
    const actor = c.get("admin").username;
    const text = on
      ? `🔴 Kill-switch ON${reason ? ` (${reason})` : ""} by ${actor} — publishing, factory, replies & approvals paused. Radar + metrics keep running.`
      : `🟢 Kill-switch OFF by ${actor} — resuming.`;
    await enqueue(Q.alertTelegram, { text, key: "kill-switch-toggle" }).catch(() => {});
    return c.json({ ok: true, killSwitch: on });
  })

  // ── whitelisted operator settings ──
  .get("/", async (c) => {
    const rows = await db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable)
      .where(inArray(settingsTable.key, [...WHITELIST]));
    const settings: Record<string, unknown> = {};
    for (const r of rows) settings[r.key] = r.value;
    return c.json({
      settings,
      killSwitch: (await getSetting<boolean>("kill_switch")) === true,
      integrations, // read-only feature flags from env (doc 10 §3.9)
    });
  })
  .put("/:key", zValidator("json", PutBody), async (c) => {
    const key = c.req.param("key");
    if (!isWhitelisted(key)) {
      return c.json(
        { error: { code: "forbidden_key", message: `setting ${key} is not writable` } },
        403,
      );
    }
    const parsed = WRITABLE_SETTINGS[key].safeParse(c.req.valid("json").value);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_setting",
            message: `invalid value for ${key}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
          },
        },
        422,
      );
    }
    await setSetting(key, parsed.data);
    return c.json({ ok: true, key });
  });

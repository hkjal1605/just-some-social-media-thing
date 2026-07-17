// Idempotent seed (doc 02 §6) — safe to run any number of times.
import { env, integrations } from "@ve/config";
import {
  CADENCE_CAPS_DEFAULT,
  type CategoryMode,
  newId,
  type Platform,
  type SourceKind,
  X_MONTHLY_READ_CAP_USD_DEFAULT,
} from "@ve/core";
import { eq } from "drizzle-orm";
import { closeDb, type Db, db } from "./client";
import { adminUsers, categories, policyPages, settings, sources } from "./schema";

const CATEGORY_SEED: { slug: string; name: string; mode: CategoryMode }[] = [
  { slug: "ai-tech", name: "AI / Tech", mode: "full_auto_candidate" },
  { slug: "football", name: "Football", mode: "human_gated" },
  { slug: "f1", name: "Formula 1", mode: "human_gated" },
  { slug: "politics", name: "Politics", mode: "human_gated" }, // human approval forever
  { slug: "music", name: "Music", mode: "radar_only" }, // radar intelligence only, never publishes
  { slug: "clip-studio", name: "Clip Studio", mode: "human_gated" }, // user-driven clip jobs, render-only
];

// Sources for ai-tech (doc 02 §6). YouTube channel ids are placeholders — editable in dashboard.
const AI_TECH_SOURCES: {
  platform: Platform;
  kind: SourceKind;
  value: string;
  scoutIntervalMin: number;
}[] = [
  { platform: "reddit", kind: "subreddit", value: "r/artificial", scoutIntervalMin: 30 },
  { platform: "reddit", kind: "subreddit", value: "r/LocalLLaMA", scoutIntervalMin: 30 },
  { platform: "reddit", kind: "subreddit", value: "r/OpenAI", scoutIntervalMin: 30 },
  { platform: "reddit", kind: "subreddit", value: "r/singularity", scoutIntervalMin: 30 },
  { platform: "youtube", kind: "yt_chart", value: "US", scoutIntervalMin: 60 },
  // placeholder AI/tech channels (Two Minute Papers, Matt Wolfe, AI Explained, Fireship, MattVidPro, WesRoth)
  {
    platform: "youtube",
    kind: "yt_channel",
    value: "UCbfYPyITQ-7l4upoX8nvctg",
    scoutIntervalMin: 60,
  },
  {
    platform: "youtube",
    kind: "yt_channel",
    value: "UChpleBmo18P08aKCIgti38g",
    scoutIntervalMin: 60,
  },
  {
    platform: "youtube",
    kind: "yt_channel",
    value: "UCNJ1Ymd5yFuUPtn21xtRbbw",
    scoutIntervalMin: 60,
  },
  {
    platform: "youtube",
    kind: "yt_channel",
    value: "UCsBjURrPoezykLs9EqgamOA",
    scoutIntervalMin: 60,
  },
  {
    platform: "youtube",
    kind: "yt_channel",
    value: "UCJIfeSCssxSC_Dhc5s7woww",
    scoutIntervalMin: 60,
  },
  {
    platform: "youtube",
    kind: "yt_channel",
    value: "UCUyDOdBWhC1MCxEjC46d-zw",
    scoutIntervalMin: 60,
  },
  {
    platform: "x",
    kind: "x_query",
    value: '("open source" OR launch OR model) (AI OR LLM) min_faves:500 -is:retweet',
    scoutIntervalMin: 60,
  },
  { platform: "tiktok", kind: "tiktok_hashtag", value: "ai", scoutIntervalMin: 360 },
  { platform: "tiktok", kind: "tiktok_hashtag", value: "aitools", scoutIntervalMin: 360 },
  { platform: "tiktok", kind: "tiktok_hashtag", value: "tech", scoutIntervalMin: 360 },
];

// The 12 governing policy pages (doc 02 §6, URLs from INITIAL_RESEARCH §12).
const POLICY_PAGES: { name: string; url: string }[] = [
  {
    name: "YouTube channel monetization policies (reused/inauthentic content)",
    url: "https://support.google.com/youtube/answer/1311392",
  },
  {
    name: "YouTube Shorts monetization policies",
    url: "https://support.google.com/youtube/answer/12504220",
  },
  {
    name: "YouTube Partner Program eligibility",
    url: "https://support.google.com/youtube/answer/72851",
  },
  {
    name: "YouTube AI disclosure (altered/synthetic content)",
    url: "https://support.google.com/youtube/answer/14328491",
  },
  {
    name: "TikTok Originality Policy",
    url: "https://www.tiktok.com/creator-academy/article/tiktok-originality-policy",
  },
  {
    name: "TikTok Creator Rewards Program",
    url: "https://support.tiktok.com/en/business-and-creator/creator-rewards-program",
  },
  {
    name: "X content monetization standards",
    url: "https://help.x.com/en/rules-and-policies/content-monetization-standards",
  },
  {
    name: "X creator revenue sharing",
    url: "https://help.x.com/en/using-x/creator-revenue-sharing",
  },
  {
    name: "Reddit Contributor Program",
    url: "https://support.reddithelp.com/hc/en-us/articles/17331620007572",
  },
  {
    name: "Reddit self-promotion / spam (9:1)",
    url: "https://support.reddithelp.com/hc/en-us/articles/360043504051",
  },
  { name: "Ayrshare changelog", url: "https://www.ayrshare.com/changelog" },
  {
    name: "Formula 1 fan content guidelines",
    url: "https://www.formula1.com/en/information/guidelines",
  },
];

// IST posting windows (doc 06 §4 defaults; overridable in Settings).
const DEFAULT_POSTING_WINDOWS = {
  tiktok: [
    { days: ["*"], start: "19:00", end: "23:00" },
    { days: ["sat", "sun"], start: "09:00", end: "11:00", flag: "tiktok_weekend_am" },
  ],
  youtube: [{ days: ["*"], start: "16:00", end: "18:00", bestDay: "fri" }],
  x: [
    { days: ["tue", "wed", "thu"], start: "09:00", end: "12:00" },
    { days: ["*"], start: "20:00", end: "21:30" },
  ],
  reddit: [{ days: ["*"], start: "16:30", end: "19:30" }],
};

export async function seed(
  dbx: Db = db,
): Promise<{ categories: number; sources: number; policyPages: number }> {
  // 1 · categories
  for (const c of CATEGORY_SEED) {
    await dbx
      .insert(categories)
      .values({
        id: newId(),
        slug: c.slug,
        name: c.name,
        mode: c.mode,
        autoApproveFormats: [],
        cadenceCaps: CADENCE_CAPS_DEFAULT,
      })
      .onConflictDoNothing({ target: categories.slug });
  }
  const catRows = await dbx.select().from(categories);
  const bySlug = new Map(catRows.map((c) => [c.slug, c.id]));

  // 2 · sources for ai-tech
  const aiTechId = bySlug.get("ai-tech");
  if (!aiTechId) throw new Error("seed: ai-tech category missing after upsert");
  for (const s of AI_TECH_SOURCES) {
    await dbx
      .insert(sources)
      .values({ id: newId(), categoryId: aiTechId, ...s })
      .onConflictDoNothing();
  }

  // 3 · settings (insert-only — never clobber operator changes)
  const settingDefaults: [string, unknown][] = [
    ["kill_switch", env.KILL_SWITCH_DEFAULT],
    ["posting_windows", DEFAULT_POSTING_WINDOWS],
    ["budget_state", { monthUsd: 0 }],
    ["integrations_status", integrations],
    ["x_monthly_read_cap_usd", X_MONTHLY_READ_CAP_USD_DEFAULT],
    ["engage_auto_reply", {}],
  ];
  for (const [key, value] of settingDefaults) {
    await dbx.insert(settings).values({ key, value }).onConflictDoNothing({ target: settings.key });
  }

  // 4 · policy pages
  for (const p of POLICY_PAGES) {
    await dbx
      .insert(policyPages)
      .values({ id: newId(), name: p.name, url: p.url })
      .onConflictDoNothing({ target: policyPages.url });
  }

  // 5 · admin user — env DASHBOARD_ADMIN_PASSWORD is the source of truth
  const [admin] = await dbx
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.username, "admin"))
    .limit(1);
  if (!admin) {
    await dbx.insert(adminUsers).values({
      id: newId(),
      username: "admin",
      passwordHash: await Bun.password.hash(env.DASHBOARD_ADMIN_PASSWORD, {
        algorithm: "argon2id",
      }),
    });
  } else if (!(await Bun.password.verify(env.DASHBOARD_ADMIN_PASSWORD, admin.passwordHash))) {
    await dbx
      .update(adminUsers)
      .set({
        passwordHash: await Bun.password.hash(env.DASHBOARD_ADMIN_PASSWORD, {
          algorithm: "argon2id",
        }),
      })
      .where(eq(adminUsers.id, admin.id));
  }

  const sourceRows = await dbx.select().from(sources);
  const policyRows = await dbx.select().from(policyPages);
  return { categories: catRows.length, sources: sourceRows.length, policyPages: policyRows.length };
}

if (import.meta.main) {
  const counts = await seed();
  console.log(
    `seeded: ${counts.categories} categories · ${counts.sources} sources · ${counts.policyPages} policy pages · admin user ready`,
  );
  await closeDb();
}

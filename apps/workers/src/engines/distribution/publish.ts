// publish.execute → publish.verify (doc 06 §5): guard, lock scheduled→publishing, presign
// media, call Ayrshare, land published, enqueue verify + metric snapshots. Failures follow
// the retry policy in doc 06 §2/§5. The payload builder is pure and unit-tested.
import { AyrshareError, type AyrsharePlatform, type AyrsharePost } from "@ve/connectors";
import {
  FORMATS,
  type FormatSlug,
  istParts,
  istWallToUtc,
  makeLogger,
  type PerPlatformCaptions,
  PerPlatformCaptionsSchema,
  type Platform,
  PUBLISH_RETRY_DELAY_MINUTES,
  PUBLISH_RETRY_MAX,
  PUBLISH_VERIFY_DELAY_MINUTES,
  Q,
  SNAPSHOT_OFFSET_HOURS,
  toAyrsharePlatform,
} from "@ve/core";
import {
  and,
  approvals,
  briefs,
  categories,
  complianceChecks,
  db,
  desc,
  eq,
  getSetting,
  posts,
  renders,
  scripts,
  sql,
  transitionPost,
} from "@ve/db";
import { METADATA_FINALIZER_SYSTEM, metadataFinalizerUser } from "@ve/llm";
import { type Enqueuer, enqueueAlert } from "../../harness";
import { distributionDeps as D } from "./deps";
import { effectiveCapResolver } from "./scheduler";

const log = makeLogger("distribution-publish");

const MEDIA_TTL_SEC = 24 * 3600; // Ayrshare fetches media server-side (doc 00 §5.5)

/** Split an x-thread script body ("tweet\n---\ntweet") into individual tweets. */
export function splitThread(body: string): string[] {
  return body
    .split(/\n?-{3,}\n?/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Build the single-platform Ayrshare payload (doc 06 §2). Pure. Throws if the platform has
 * no caption in the bundle. AI-disclosure flags come from the script's aiDisclosure.
 */
export function buildAyrsharePayload(input: {
  platform: Platform;
  captions: PerPlatformCaptions;
  scriptBody: string;
  formatSlug: string;
  aiDisclosure: boolean;
  mediaUrl: string | null;
}): AyrsharePost {
  const ayr: AyrsharePlatform = toAyrsharePlatform(input.platform);
  const media = input.mediaUrl ? { mediaUrls: [input.mediaUrl] } : {};

  if (input.platform === "tiktok") {
    const c = input.captions.tiktok;
    if (!c) throw new Error("buildAyrsharePayload: missing tiktok caption");
    const post = [c.caption, c.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")]
      .filter(Boolean)
      .join(" ");
    return {
      post,
      platforms: [ayr],
      ...media,
      tikTokOptions: {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        autoAddMusic: false,
        disableComments: false,
        isAiGenerated: input.aiDisclosure,
      },
    };
  }

  if (input.platform === "youtube") {
    const c = input.captions.youtube;
    if (!c) throw new Error("buildAyrsharePayload: missing youtube caption");
    return {
      post: c.description || c.title,
      platforms: [ayr],
      ...media,
      youTubeOptions: {
        title: c.title,
        visibility: "public",
        shorts: true,
        tags: c.tags,
        madeForKids: false,
        containsSyntheticMedia: input.aiDisclosure,
      },
    };
  }

  if (input.platform === "x") {
    const c = input.captions.x;
    const isThread = FORMATS[input.formatSlug as FormatSlug]?.render === "text-only";
    if (isThread) {
      const tweets = splitThread(input.scriptBody);
      const first = tweets[0] ?? c?.text ?? "";
      const rest = tweets.slice(1);
      return {
        post: first,
        platforms: [ayr],
        ...media,
        ...(rest.length > 0 ? { twitterOptions: { thread: rest } } : {}),
      };
    }
    if (!c) throw new Error("buildAyrsharePayload: missing x caption");
    return { post: c.text, platforms: [ayr], ...media };
  }

  // reddit
  const c = input.captions.reddit;
  if (!c) throw new Error("buildAyrsharePayload: missing reddit caption");
  return {
    post: c.body,
    platforms: [ayr],
    ...media,
    redditOptions: { subreddit: c.subreddit.replace(/^r\//, ""), title: c.title },
  };
}

/**
 * Finalize captions (doc 06 §3): re-run metadata-finalizer ONLY when the approval's edit
 * instructions touched captions; otherwise use the stored per-platform captions as-is.
 */
const CAPTION_EDIT_HINT = /caption|hook|title|hashtag|description|tweet|thread|body/i;

export async function finalizeCaptions(
  script: typeof scripts.$inferSelect,
  editInstructions: string | null,
): Promise<PerPlatformCaptions> {
  const base = (script.perPlatformCaptions ?? {}) as PerPlatformCaptions;
  if (!editInstructions || !CAPTION_EDIT_HINT.test(editInstructions)) return base;
  try {
    return await D.runStructured({
      agent: "metadata-finalizer",
      system: METADATA_FINALIZER_SYSTEM,
      user: metadataFinalizerUser({
        formatSlug: "",
        editInstructions,
        currentCaptions: base,
      }),
      schema: PerPlatformCaptionsSchema,
    });
  } catch (err) {
    log.warn({ err }, "metadata-finalizer failed — using stored captions");
    return base;
  }
}

/** Extract ayrshare post id + (optional) permalink/externalId for a platform from a result. */
function readPostResult(
  result: { id?: string; postIds?: { platform?: string; id?: string; postUrl?: string }[] },
  ayr: AyrsharePlatform,
): { ayrsharePostId: string | null; externalId: string | null; permalink: string | null } {
  const match = (result.postIds ?? []).find((p) => p.platform === ayr);
  return {
    ayrsharePostId: result.id ?? null,
    externalId: match?.id ?? null,
    permalink: match?.postUrl ?? null,
  };
}

interface PublishContext {
  post: typeof posts.$inferSelect;
  brief: typeof briefs.$inferSelect;
  script: typeof scripts.$inferSelect | null;
  render: typeof renders.$inferSelect | null;
}

async function loadContext(postId: string): Promise<PublishContext | null> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return null;
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, post.briefId)).limit(1);
  if (!brief) throw new Error(`publish: brief ${post.briefId} missing`);
  const [script] = await db
    .select()
    .from(scripts)
    .where(eq(scripts.briefId, brief.id))
    .orderBy(desc(scripts.version))
    .limit(1);
  const render = post.renderId
    ? ((await db.select().from(renders).where(eq(renders.id, post.renderId)).limit(1))[0] ?? null)
    : null;
  return { post, brief, script: script ?? null, render: render ?? null };
}

/**
 * Fire-time cadence count (doc 06 §7): posts in this (category, platform) lane already committed
 * today (IST) — matching the planner's per-lane daily cap. 'publishing' counts (a sibling is going
 * out right now); 'published' counts within today's IST window. Excludes this post.
 */
async function committedTodayCount(
  categoryId: string,
  platform: Platform,
  now: Date,
  excludePostId: string,
): Promise<number> {
  const p = istParts(now);
  const dayStart = istWallToUtc(p.year, p.month, p.day, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const rows = (await db.execute(sql`
    select count(*)::int as n from posts
    where category_id = ${categoryId} and platform = ${platform} and id <> ${excludePostId}
      and (
        (status = 'published' and published_at >= ${dayStart.toISOString()}::timestamptz
                              and published_at <  ${dayEnd.toISOString()}::timestamptz)
        or status = 'publishing'
      )
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Revert a scheduled post to approved (guard failure) with an alert (doc 06 §5.1). */
async function revertToApproved(postId: string, boss: Enqueuer, reason: string): Promise<void> {
  await transitionPost(db, postId, "approved", { scheduledFor: null }).catch(() => {});
  await enqueueAlert(
    boss,
    `⛔ publish.execute refused | post:${postId} | ${reason}`,
    `publish-guard:${postId}`,
  );
  log.warn({ postId, reason }, "publish guard failed — reverted to approved");
}

export async function publishExecuteHandler(
  payload: { postId: string },
  boss: Enqueuer,
): Promise<{ status: "published" | "failed" | "skipped" | "reverted" }> {
  const ctx = await loadContext(payload.postId);
  if (!ctx) throw new Error(`publish.execute: post ${payload.postId} missing`);
  const { post, brief, script, render } = ctx;

  // A redelivered job that finds the post already 'publishing' means a prior attempt got past the
  // lock — possibly after Ayrshare createPost succeeded but before we recorded 'published'. Since
  // createPost is not idempotent, re-sending would double-post. Fail safe instead and let a human
  // reconcile against the platform before retrying — a rare stuck post beats a duplicate one (H2).
  if (post.status === "publishing") {
    await transitionPost(db, post.id, "failed", {
      failReason: "interrupted mid-publish — check the platform before re-scheduling",
    }).catch(() => {});
    await enqueueAlert(
      boss,
      `⚠️ publish.execute interrupted mid-publish | post:${post.id} | verify on the platform before re-scheduling`,
      `publish-interrupted:${post.id}`,
    );
    log.warn({ postId: post.id }, "found post already 'publishing' — failed safe, no re-send");
    return { status: "failed" };
  }
  if (post.status !== "scheduled") {
    log.info({ postId: post.id, status: post.status }, "publish.execute no-op (not scheduled)");
    return { status: "skipped" };
  }

  // ── guards (doc 06 §5.1) — while still 'scheduled', any fail reverts to approved ──
  {
    // reslot self-heal (doc 11 PATCH /posts/:id): if the slot moved later after this job was
    // queued, re-arm for the new time instead of publishing early.
    if (post.scheduledFor && Date.now() < post.scheduledFor.getTime() - 60_000) {
      await boss.send(
        Q.publishExecute,
        { postId: post.id },
        { startAfter: post.scheduledFor, singletonKey: post.id },
      );
      log.info(
        { postId: post.id, scheduledFor: post.scheduledFor.toISOString() },
        "publish.execute re-armed for a moved slot",
      );
      return { status: "skipped" };
    }
    if ((await getSetting<boolean>("kill_switch")) === true) {
      await revertToApproved(post.id, boss, "kill-switch on");
      return { status: "reverted" };
    }
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.briefId, brief.id))
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    if (approval && !["approved", "auto_approved"].includes(approval.status)) {
      await revertToApproved(post.id, boss, `approval ${approval.status}`);
      return { status: "reverted" };
    }
    const [gate] = await db
      .select()
      .from(complianceChecks)
      .where(
        and(
          eq(complianceChecks.briefId, brief.id),
          eq(complianceChecks.stage, "pre_publish"),
          eq(complianceChecks.pass, true),
        ),
      )
      .orderBy(desc(complianceChecks.checkedAt))
      .limit(1);
    if (!gate) {
      await revertToApproved(post.id, boss, "no passing pre_publish compliance");
      return { status: "reverted" };
    }
    const [category] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, post.categoryId))
      .limit(1);
    if (!category?.active) {
      await revertToApproved(post.id, boss, "category inactive");
      return { status: "reverted" };
    }
    // fire-time cadence re-check (doc 06 §7): the plan-time cap can be stale after reslots, retries,
    // or a slot drifting into a new IST day — refuse if this platform already hit its daily cap.
    const now = new Date();
    const cap = (await effectiveCapResolver(now))(post.categoryId, post.platform as Platform);
    const committed = await committedTodayCount(
      post.categoryId,
      post.platform as Platform,
      now,
      post.id,
    );
    if (committed >= cap) {
      await revertToApproved(
        post.id,
        boss,
        `cadence cap reached (${committed}/${cap} today on ${post.platform})`,
      );
      return { status: "reverted" };
    }
    // acquire the publishing lock
    await transitionPost(db, post.id, "publishing");
  }

  // ── build + send ──
  const platform = post.platform as Platform;
  const ayr = toAyrsharePlatform(platform);
  const [latestApproval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.briefId, brief.id))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  const captions = script
    ? await finalizeCaptions(script, latestApproval?.editInstructions ?? null)
    : ({} as PerPlatformCaptions);

  let mediaUrl: string | null = null;
  if (render?.r2Key) mediaUrl = await D.presignGet(render.r2Key, MEDIA_TTL_SEC);

  let payloadToSend: AyrsharePost;
  try {
    payloadToSend = buildAyrsharePayload({
      platform,
      captions,
      scriptBody: script?.body ?? "",
      formatSlug: brief.formatSlug,
      aiDisclosure: script?.aiDisclosure ?? false,
      mediaUrl,
    });
  } catch (err) {
    // payload construction bug — not retryable
    await transitionPost(db, post.id, "failed", { failReason: String(err).slice(0, 500) });
    await enqueueAlert(
      boss,
      `🔥 publish.execute payload error | post:${post.id} | ${String(err).slice(0, 200)}`,
    );
    return { status: "failed" };
  }

  const captionUsed = { ...payloadToSend, mediaUrls: undefined };

  try {
    const result = await D.createPost(payloadToSend);
    const ids = readPostResult(result, ayr);
    // an Ayrshare result carrying platform errors is a failure even with 200
    if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
      throw new AyrshareError(422, JSON.stringify(result.errors).slice(0, 500));
    }
    await transitionPost(db, post.id, "published", {
      publishedAt: new Date(),
      ayrsharePostId: ids.ayrsharePostId,
      externalId: ids.externalId,
      permalink: ids.permalink,
      captionUsed,
    });
    const now = Date.now();
    await boss.send(
      Q.publishVerify,
      { postId: post.id },
      { startAfter: new Date(now + PUBLISH_VERIFY_DELAY_MINUTES * 60_000) },
    );
    for (const h of SNAPSHOT_OFFSET_HOURS) {
      await boss.send(
        Q.metricsSnapshot,
        { postId: post.id },
        { startAfter: new Date(now + h * 3_600_000) },
      );
    }
    log.info({ postId: post.id, platform, ayrsharePostId: ids.ayrsharePostId }, "published");
    return { status: "published" };
  } catch (err) {
    const status = err instanceof AyrshareError ? err.status : 0;
    const retryable = status === 0 || status >= 500;
    await transitionPost(db, post.id, "failed", { failReason: String(err).slice(0, 500) });
    if (retryable && post.retryCount < PUBLISH_RETRY_MAX) {
      await transitionPost(db, post.id, "scheduled", {
        retryCount: post.retryCount + 1,
        scheduledFor: new Date(Date.now() + PUBLISH_RETRY_DELAY_MINUTES * 60_000),
      });
      await boss.send(
        Q.publishExecute,
        { postId: post.id },
        {
          startAfter: new Date(Date.now() + PUBLISH_RETRY_DELAY_MINUTES * 60_000),
          singletonKey: post.id,
        },
      );
      log.warn(
        { postId: post.id, status, retryCount: post.retryCount + 1 },
        "publish retry scheduled",
      );
    } else {
      await enqueueAlert(
        boss,
        `🔥 publish.execute failed | post:${post.id} | ${status} ${String(err).slice(0, 200)}`,
      );
    }
    return { status: "failed" };
  }
}

/** publish.verify (doc 06 §5): confirm live via /history, fill permalink/externalId. */
export async function publishVerifyHandler(
  payload: { postId: string },
  boss: Enqueuer,
): Promise<{ verified: boolean }> {
  const [post] = await db.select().from(posts).where(eq(posts.id, payload.postId)).limit(1);
  if (!post) throw new Error(`publish.verify: post ${payload.postId} missing`);
  if (post.status !== "published") {
    log.info({ postId: post.id, status: post.status }, "publish.verify no-op (not published)");
    return { verified: false };
  }
  if (!post.ayrsharePostId) return { verified: false };

  const history = await D.getHistory(7);
  const entry = history.find((h) => (h as { id?: string }).id === post.ayrsharePostId) as
    | {
        id?: string;
        status?: string;
        postIds?: { platform?: string; id?: string; postUrl?: string; status?: string }[];
      }
    | undefined;
  if (!entry) {
    log.info({ postId: post.id }, "publish.verify: not in history yet");
    return { verified: false };
  }

  const ayr = toAyrsharePlatform(post.platform as Platform);
  const pid = (entry.postIds ?? []).find((p) => p.platform === ayr);
  const platformStatus = (pid?.status ?? entry.status ?? "").toLowerCase();
  if (
    platformStatus.includes("error") ||
    platformStatus.includes("reject") ||
    platformStatus.includes("fail")
  ) {
    await transitionPost(db, post.id, "failed", {
      failReason: `platform rejected: ${platformStatus}`,
    });
    await enqueueAlert(
      boss,
      `🔥 publish.verify: platform rejected | post:${post.id} | ${platformStatus}`,
    );
    return { verified: false };
  }

  await db
    .update(posts)
    .set({
      permalink: pid?.postUrl ?? post.permalink,
      externalId: pid?.id ?? post.externalId,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, post.id));
  log.info({ postId: post.id, permalink: pid?.postUrl }, "publish verified");
  return { verified: true };
}

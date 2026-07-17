// engage.scan (every 20 min, posts <3h old) + engage.reply (gated) — doc 06 §6.
// scan pulls comments, upserts engagements, classifies new ones (Gemini batch), and for
// categories that opted into auto-reply enqueues gated replies for praise/simple-questions
// up to the per-post cap. reply is the thin, kill-switch-gated sender (auto draft or manual).
import {
  type CommentClassification,
  CommentClassificationSchema,
  ENGAGE_AUTO_REPLY_CAP,
  ENGAGE_AUTO_REPLY_KINDS,
  ENGAGEMENT_WINDOW_HOURS,
  makeLogger,
  newId,
  type Platform,
  Q,
} from "@ve/core";
import { and, categories, db, engagements, eq, getSetting, gte, posts, sql } from "@ve/db";
import { COMMENT_CLASSIFIER_RUBRIC } from "@ve/llm";
import type { Enqueuer } from "../../harness";
import { distributionDeps as D } from "./deps";

const log = makeLogger("distribution-engage");

interface IncomingComment {
  externalCommentId: string;
  author: string | null;
  text: string;
}

/** Pull comments for a post from the right source (doc 06 §6). X is human-only in v1. */
async function fetchComments(post: typeof posts.$inferSelect): Promise<IncomingComment[]> {
  const platform = post.platform as Platform;
  if ((platform === "tiktok" || platform === "youtube") && post.ayrsharePostId) {
    const rows = await D.getComments(post.ayrsharePostId);
    return rows
      .filter((c) => c.platform === "tiktok" || c.platform === "youtube")
      .map((c) => ({
        externalCommentId: c.commentId,
        author: c.userName ?? null,
        text: c.comment,
      }));
  }
  if (platform === "reddit" && post.externalId) {
    const rows = await D.fetchRedditComments(post.externalId);
    return rows.map((c) => ({
      externalCommentId: c.externalCommentId,
      author: c.author,
      text: c.text,
    }));
  }
  return []; // x: reply-to-mentions is human-only in v1 (doc 06 §6)
}

/** Insert only comments we haven't seen; returns the newly inserted rows. */
async function upsertNewComments(
  postId: string,
  comments: IncomingComment[],
): Promise<(typeof engagements.$inferSelect)[]> {
  if (comments.length === 0) return [];
  const existing = await db
    .select({ externalCommentId: engagements.externalCommentId })
    .from(engagements)
    .where(eq(engagements.postId, postId));
  const have = new Set(existing.map((e) => e.externalCommentId));
  const fresh = comments.filter((c) => c.externalCommentId && !have.has(c.externalCommentId));
  if (fresh.length === 0) return [];
  const rows = fresh.map((c) => ({
    id: newId(),
    postId,
    externalCommentId: c.externalCommentId,
    author: c.author,
    text: c.text,
    needsHuman: false,
  }));
  // unique (post, externalCommentId) — ignore races
  await db.insert(engagements).values(rows).onConflictDoNothing();
  return rows as (typeof engagements.$inferSelect)[];
}

async function classify(
  comments: (typeof engagements.$inferSelect)[],
): Promise<Map<string, CommentClassification>> {
  if (comments.length === 0) return new Map();
  return D.scoreBatch({
    agent: "comment-classifier",
    items: comments.map((c) => ({ id: c.externalCommentId, text: c.text ?? "" })),
    rubricPrompt: COMMENT_CLASSIFIER_RUBRIC,
    schema: CommentClassificationSchema,
  });
}

/** Replies already sent for a post — the auto-reply cap counts these (doc 06 §6). */
async function repliedCount(postId: string): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n from engagements
    where post_id = ${postId} and replied_at is not null
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

export async function engageScanForPost(
  post: typeof posts.$inferSelect,
  boss: Enqueuer,
): Promise<{ newComments: number; autoReplies: number }> {
  const incoming = await fetchComments(post);
  const fresh = await upsertNewComments(post.id, incoming);
  if (fresh.length === 0) return { newComments: 0, autoReplies: 0 };

  const classifications = await classify(fresh);

  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, post.categoryId))
    .limit(1);
  const autoMap = (await getSetting<Record<string, boolean>>("engage_auto_reply")) ?? {};
  const autoEnabled = category ? autoMap[category.slug] === true : false;

  let budget = autoEnabled ? Math.max(0, ENGAGE_AUTO_REPLY_CAP - (await repliedCount(post.id))) : 0;
  let autoReplies = 0;

  for (const c of fresh) {
    const cls = classifications.get(c.externalCommentId);
    if (!cls) continue;
    if (cls.needsHuman || cls.kind === "criticism") {
      await db.update(engagements).set({ needsHuman: true }).where(eq(engagements.id, c.id));
      continue;
    }
    const eligible =
      autoEnabled &&
      budget > 0 &&
      ENGAGE_AUTO_REPLY_KINDS.includes(cls.kind) &&
      !!cls.draftReply &&
      cls.draftReply.trim().length > 0;
    if (eligible) {
      await boss.send(Q.engageReply, { engagementId: c.id, text: cls.draftReply });
      budget--;
      autoReplies++;
    } else if (cls.kind === "question") {
      // a question we couldn't confidently draft → surface for a human
      await db.update(engagements).set({ needsHuman: true }).where(eq(engagements.id, c.id));
    }
  }
  log.info({ postId: post.id, newComments: fresh.length, autoReplies }, "engagement scan complete");
  return { newComments: fresh.length, autoReplies };
}

/** engage.scan handler: one post, or the tick over all posts <3h old (doc 06 §6). */
export async function engageScanHandler(
  payload: { postId?: string | undefined },
  boss: Enqueuer,
): Promise<{ posts: number; newComments: number; autoReplies: number }> {
  let targets: (typeof posts.$inferSelect)[];
  if (payload.postId) {
    targets = await db.select().from(posts).where(eq(posts.id, payload.postId)).limit(1);
  } else {
    const cutoff = new Date(Date.now() - ENGAGEMENT_WINDOW_HOURS * 3_600_000);
    targets = await db
      .select()
      .from(posts)
      .where(and(eq(posts.status, "published"), gte(posts.publishedAt, cutoff)));
  }
  let newComments = 0;
  let autoReplies = 0;
  for (const post of targets) {
    try {
      const r = await engageScanForPost(post, boss);
      newComments += r.newComments;
      autoReplies += r.autoReplies;
    } catch (err) {
      log.warn({ err, postId: post.id }, "engage scan failed for post — continuing");
    }
  }
  return { posts: targets.length, newComments, autoReplies };
}

/** engage.reply handler (kill-switch gated by the harness): send one reply, auto or manual. */
export async function engageReplyHandler(payload: {
  engagementId: string;
  text?: string | undefined;
}): Promise<{ sent: boolean }> {
  const [eng] = await db
    .select()
    .from(engagements)
    .where(eq(engagements.id, payload.engagementId))
    .limit(1);
  if (!eng) throw new Error(`engage.reply: engagement ${payload.engagementId} missing`);
  if (eng.repliedAt) {
    log.info({ engagementId: eng.id }, "engage.reply no-op (already replied)");
    return { sent: false };
  }
  const text = payload.text?.trim();
  if (!text) {
    log.warn({ engagementId: eng.id }, "engage.reply: no text provided — skipping");
    return { sent: false };
  }

  const [post] = await db.select().from(posts).where(eq(posts.id, eng.postId)).limit(1);
  if (!post) throw new Error(`engage.reply: post ${eng.postId} missing`);

  // send via Ayrshare for tiktok/youtube/reddit; X replies are human-only in v1
  if ((post.platform as Platform) !== "x") {
    await D.replyComment(eng.externalCommentId, text);
  } else {
    log.info({ engagementId: eng.id }, "engage.reply: x is human-only — not sent");
    return { sent: false };
  }

  await db
    .update(engagements)
    .set({ repliedText: text, repliedAt: new Date() })
    .where(eq(engagements.id, eng.id));
  log.info({ engagementId: eng.id, postId: post.id }, "reply sent");
  return { sent: true };
}

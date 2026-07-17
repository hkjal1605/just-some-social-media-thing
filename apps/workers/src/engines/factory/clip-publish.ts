// clip.publish (Clip Studio "Post" button): publish a rendered clip to YouTube/TikTok/X through
// Buffer (buffer.com) — one 3rd-party integrator, no approval/cadence pipeline (the user clicked Post
// explicitly). The clip's per-platform captions were written by the same Gemini call that found the
// moment. Buffer FETCHES the clip from its public/presigned R2 URL — we never re-upload the bytes. On
// any error we mark the post `failed` and return (no pg-boss retry): posting isn't idempotent, so the
// user re-clicks to retry rather than risk a double-post.
import { env } from "@ve/config";
import { type BufferPlatform, bufferChannelId, createBufferVideoPost } from "@ve/connectors";
import { makeLogger, type PerPlatformCaptions, type Platform } from "@ve/core";
import { briefs, db, desc, eq, posts, renders, scripts } from "@ve/db";
import { presignGet, publicUrl } from "@ve/storage";
import type { Enqueuer } from "../../harness";

const log = makeLogger("clip-publish");

const BUFFER_PLATFORMS = new Set<Platform>(["youtube", "tiktok", "x"]);

async function fail(postId: string, reason: string): Promise<{ status: "failed" }> {
  await db
    .update(posts)
    .set({ status: "failed", failReason: reason.slice(0, 500), updatedAt: new Date() })
    .where(eq(posts.id, postId));
  return { status: "failed" };
}

/** Caption text + (for YouTube) title/privacy metadata, from the clip's per-platform captions. */
function buildContent(
  platform: BufferPlatform,
  captions: PerPlatformCaptions,
  fallbackTitle: string,
): { text: string; youtube?: { title: string; privacy: "public" | "unlisted" | "private" } } {
  if (platform === "youtube") {
    const yt = captions.youtube;
    const title = (yt?.title || fallbackTitle).slice(0, 100);
    const tags = (yt?.tags ?? []).map((t) => `#${t.replace(/^#/, "")}`).join(" ");
    const text = [yt?.description ?? "", tags].filter(Boolean).join("\n\n").trim() || title;
    return { text, youtube: { title, privacy: env.YOUTUBE_PRIVACY } };
  }
  if (platform === "tiktok") {
    const tk = captions.tiktok;
    const text = [
      tk?.caption ?? fallbackTitle,
      (tk?.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" "),
    ]
      .filter(Boolean)
      .join(" ");
    return { text };
  }
  // x — a single video post; keep the body within X's classic limit
  return { text: (captions.x?.text ?? fallbackTitle).slice(0, 280) };
}

export async function clipPublishHandler(
  payload: { postId: string },
  _boss: Enqueuer,
): Promise<{ status: "published" | "failed" | "skipped" }> {
  const [post] = await db.select().from(posts).where(eq(posts.id, payload.postId)).limit(1);
  if (!post) {
    log.warn({ postId: payload.postId }, "clip.publish: post gone — nothing to do");
    return { status: "skipped" };
  }
  if (post.status === "published") return { status: "skipped" };

  const platform = post.platform as Platform;
  if (!BUFFER_PLATFORMS.has(platform)) {
    return fail(post.id, `unsupported platform for Buffer posting: ${platform}`);
  }
  if (!post.renderId) return fail(post.id, "clip has no render to post");
  const [render] = await db.select().from(renders).where(eq(renders.id, post.renderId)).limit(1);
  if (!render?.r2Key || render.status !== "done") return fail(post.id, "clip render not ready");

  // captions written by the merged Gemini analyze call (stored on the clip's script)
  const [script] = await db
    .select()
    .from(scripts)
    .where(eq(scripts.briefId, post.briefId))
    .orderBy(desc(scripts.version))
    .limit(1);
  const captions = (script?.perPlatformCaptions ?? {}) as PerPlatformCaptions;
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, post.briefId)).limit(1);
  const fallbackTitle = brief?.angle?.slice(0, 90) ?? "Clip";

  await db
    .update(posts)
    .set({ status: "publishing", updatedAt: new Date() })
    .where(eq(posts.id, post.id));

  try {
    const bp = platform as BufferPlatform;
    const channelId = await bufferChannelId(bp);
    if (!channelId) {
      return fail(
        post.id,
        `no ${bp} channel connected in Buffer — connect it at publish.buffer.com, then retry`,
      );
    }
    // Buffer pulls the video from a public URL (no byte upload). Prefer the public bucket base;
    // fall back to a presigned GET (6 h) when R2_PUBLIC_BASE_URL is unset (dev/MinIO).
    const videoUrl = publicUrl(render.r2Key) ?? (await presignGet(render.r2Key, 6 * 3600));

    const { text, youtube } = buildContent(bp, captions, fallbackTitle);
    const result = await createBufferVideoPost({
      channelId,
      text,
      videoUrl,
      ...(youtube ? { youtube } : {}),
      // best-moment cover offset → Buffer sets the TikTok cover to that frame (ignored by YT/X)
      ...(render.thumbOffsetMs != null ? { thumbnailOffsetMs: render.thumbOffsetMs } : {}),
    });

    await db
      .update(posts)
      .set({
        status: "published",
        publishedAt: new Date(),
        // Buffer's post id — the final platform permalink isn't known until Buffer finishes the
        // async upload, so we leave permalink null (the user tracks it in Buffer / on the channel).
        externalId: result.postId,
        permalink: null,
        captionUsed: { text, ...(youtube ? { title: youtube.title } : {}) },
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));
    log.info({ postId: post.id, platform: bp, bufferPostId: result.postId }, "clip sent to buffer");
    return { status: "published" };
  } catch (err) {
    log.error({ postId: post.id, platform, err: String(err).slice(0, 300) }, "clip publish failed");
    return fail(post.id, String(err));
  }
}

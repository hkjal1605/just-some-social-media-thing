// Deterministic offline distribution deps — the credential-free demo + unit tests
// (doc 13 §2). An in-memory fake Ayrshare records posts so verify/analytics reflect them.
import type {
  AyrshareAnalytics,
  AyrshareComment,
  AyrsharePost,
  AyrsharePostResult,
  RedditComment,
} from "@ve/connectors";
import {
  type CommentClassification,
  type PerPlatformCaptions,
  PerPlatformCaptionsSchema,
} from "@ve/core";
import type { DistributionDeps } from "./deps";

interface StoredPost {
  id: string;
  platform: string;
  externalId: string;
  postUrl: string;
}

/** In-memory published store so getHistory/getPostAnalytics reflect what createPost sent. */
export class FakeAyrshare {
  private seq = 0;
  readonly posts = new Map<string, StoredPost>();
  readonly replies: { id: string; text: string }[] = [];
  comments = new Map<string, AyrshareComment[]>();

  createPost = async (p: AyrsharePost): Promise<AyrsharePostResult> => {
    this.seq++;
    const id = `ayr_${this.seq}`;
    const platform = p.platforms[0] ?? "tiktok";
    const stored: StoredPost = {
      id,
      platform,
      externalId: `ext_${this.seq}`,
      postUrl: `https://example.test/${platform}/${this.seq}`,
    };
    this.posts.set(id, stored);
    return {
      id,
      status: "success",
      postIds: [{ platform, id: stored.externalId, postUrl: stored.postUrl, status: "success" }],
    };
  };

  getHistory = async (): Promise<Record<string, unknown>[]> =>
    [...this.posts.values()].map((s) => ({
      id: s.id,
      status: "success",
      postIds: [{ platform: s.platform, id: s.externalId, postUrl: s.postUrl, status: "success" }],
    }));

  getPostAnalytics = async (id: string): Promise<AyrshareAnalytics> => {
    const n = Number(id.replace(/\D/g, "")) || 1;
    const views = 1000 * n;
    return {
      views,
      likes: Math.round(views * 0.08),
      comments: Math.round(views * 0.01),
      shares: Math.round(views * 0.005),
      watchTimeSec: views * 12,
      avgViewDurationSec: 18.5,
      raw: { source: "offline-fake", id },
    };
  };

  getComments = async (id: string): Promise<AyrshareComment[]> => this.comments.get(id) ?? [];

  replyComment = async (id: string, text: string): Promise<void> => {
    this.replies.push({ id, text });
  };
}

/** Heuristic offline comment classifier for scoreBatch (praise/question get drafts). */
export function offlineClassifyComment(text: string): CommentClassification {
  const t = text.toLowerCase();
  if (/(love|amazing|great|awesome|nice|thank|🔥|❤️)/.test(t)) {
    return { kind: "praise", needsHuman: false, draftReply: "Thank you — glad it landed! 🙏" };
  }
  if (/(scam|hate|wrong|terrible|worst|stupid|fake)/.test(t)) {
    return { kind: "criticism", needsHuman: true };
  }
  if (t.includes("?")) {
    // a simple, answerable question gets a draft; anything with numbers/health/money → human
    if (/(price|cost|\$|medical|invest|legal|dose)/.test(t))
      return { kind: "question", needsHuman: true };
    return {
      kind: "question",
      needsHuman: false,
      draftReply: "Good question — full breakdown is in the video!",
    };
  }
  if (/(buy now|promo|click here|http)/.test(t)) return { kind: "spam", needsHuman: false };
  return { kind: "other", needsHuman: false };
}

const offlineScoreBatch: DistributionDeps["scoreBatch"] = async (opts) => {
  const out = new Map();
  for (const item of opts.items)
    out.set(item.id, opts.schema.parse(offlineClassifyComment(item.text)));
  return out;
};

const offlineFinalizer: DistributionDeps["runStructured"] = async <T>(opts: {
  agent: string;
  user: string;
  schema: { parse: (v: unknown) => T };
}): Promise<T> => {
  // metadata-finalizer offline: echo the current captions (no real edits applied)
  const m = opts.user.match(/## Current captions \(JSON\)\n([\s\S]*?)\n\nReturn/);
  const captions: PerPlatformCaptions = m?.[1] ? JSON.parse(m[1]) : {};
  return opts.schema.parse(PerPlatformCaptionsSchema.parse(captions));
};

/** Build an offline DistributionDeps backed by a fresh FakeAyrshare (or a supplied one). */
export function offlineDistributionDeps(fake: FakeAyrshare = new FakeAyrshare()): DistributionDeps {
  return {
    createPost: fake.createPost,
    getHistory: fake.getHistory,
    getPostAnalytics: fake.getPostAnalytics,
    getComments: fake.getComments,
    replyComment: fake.replyComment,
    fetchRedditComments: async (): Promise<RedditComment[]> => [],
    presignGet: async (key: string, ttl?: number) => `memory://${key}?ttl=${ttl ?? 3600}`,
    runStructured: offlineFinalizer,
    scoreBatch: offlineScoreBatch,
  };
}

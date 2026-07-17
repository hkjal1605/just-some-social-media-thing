// Buffer (buffer.com) GraphQL API — the single 3rd-party integrator for Clip Studio direct posting
// to YouTube Shorts, TikTok, and X. Replaces the per-platform OAuth connectors: you connect each
// social account ONCE in Buffer's own UI, then this posts on your behalf with one access token.
//
// Facts that shape this client (developers.buffer.com):
//   • endpoint https://api.buffer.com; auth `Authorization: Bearer <token>` — a key you mint at
//     publish.buffer.com/settings/api.
//   • Buffer accepts NO byte uploads — a video is attached by PUBLIC URL and Buffer pulls it. We hand
//     it the render's R2 public (or presigned) URL, so nothing is re-uploaded through us.
//   • createPost(input){ text, channelId, schedulingType, mode, assets, metadata } → a union of
//     PostActionSuccess | MutationError. mode:shareNow publishes immediately; the actual platform
//     upload then happens asynchronously inside Buffer.
//   • channels are discovered from the account; the `service` field names the network
//     (youtube | tiktok | twitter). We map our Platform onto that.
import { env } from "@ve/config";

const ENDPOINT = "https://api.buffer.com";

export type BufferPlatform = "youtube" | "tiktok" | "x";

// our Platform → Buffer `service` value(s). X is still "twitter" in Buffer's service enum; accept a
// bare "x" too in case they rename it. Compared case-insensitively.
const SERVICE_ALIASES: Record<BufferPlatform, string[]> = {
  youtube: ["youtube"],
  tiktok: ["tiktok"],
  x: ["twitter", "x"],
};

export interface BufferChannel {
  id: string;
  name: string;
  service: string;
}

export function bufferConfigured(): boolean {
  return env.BUFFER_ACCESS_TOKEN !== "";
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/** POST a GraphQL op to Buffer; throw on transport errors or a non-empty `errors` array. */
async function bufferGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.BUFFER_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => ({}))) as GraphQLResponse<T>;
  if (!res.ok || body.errors?.length) {
    const msg = body.errors?.map((e) => e.message).join("; ") || `http ${res.status}`;
    throw new Error(`buffer graphql: ${msg}`);
  }
  if (!body.data) throw new Error("buffer graphql: empty response");
  return body.data;
}

// ── channel discovery (cached) ───────────────────────────────────────────────
// Channels rarely change; cache for a few minutes so social-targets + every publish don't re-hit
// Buffer. Cleared implicitly on process restart.
let channelCache: { at: number; channels: BufferChannel[] } | null = null;
const CHANNEL_TTL_MS = 5 * 60_000;

async function organizationId(): Promise<string> {
  if (env.BUFFER_ORGANIZATION_ID !== "") return env.BUFFER_ORGANIZATION_ID;
  const data = await bufferGraphQL<{ account?: { organizations?: { id: string }[] } }>(
    "query { account { organizations { id } } }",
    {},
  );
  const id = data.account?.organizations?.[0]?.id;
  if (!id) throw new Error("buffer: no organization found on this account");
  return id;
}

/** All social channels connected to the Buffer account (cached). */
export async function bufferChannels(force = false): Promise<BufferChannel[]> {
  if (!force && channelCache && Date.now() - channelCache.at < CHANNEL_TTL_MS) {
    return channelCache.channels;
  }
  const orgId = await organizationId();
  // orgId is inlined as a JSON string literal (trusted, from env or Buffer itself) so we don't have
  // to hard-code Buffer's input type name for a $variable — JSON.stringify escapes it safely.
  const data = await bufferGraphQL<{ channels?: BufferChannel[] }>(
    `query { channels(input: { organizationId: ${JSON.stringify(orgId)} }) { id name service } }`,
    {},
  );
  const channels = data.channels ?? [];
  channelCache = { at: Date.now(), channels };
  return channels;
}

/** The Buffer channel id for one of our platforms, or null if that network isn't connected. */
export async function bufferChannelId(platform: BufferPlatform): Promise<string | null> {
  const aliases = SERVICE_ALIASES[platform];
  const channels = await bufferChannels();
  return channels.find((c) => aliases.includes(c.service.toLowerCase()))?.id ?? null;
}

/** Which of our platforms currently have a connected Buffer channel (drives the Post buttons). */
export async function bufferConnectedPlatforms(): Promise<Record<BufferPlatform, boolean>> {
  const channels = await bufferChannels();
  const has = (p: BufferPlatform) =>
    channels.some((c) => SERVICE_ALIASES[p].includes(c.service.toLowerCase()));
  return { youtube: has("youtube"), tiktok: has("tiktok"), x: has("x") };
}

// ── posting ──────────────────────────────────────────────────────────────────
export interface BufferVideoPost {
  channelId: string;
  text: string;
  /** Publicly fetchable video URL (R2 public/presigned) — Buffer pulls it; no byte upload. */
  videoUrl: string;
  /** YouTube requires a title + category on create; privacy comes from env. */
  youtube?: { title: string; privacy: "public" | "unlisted" | "private" };
  /** Best-moment cover offset (ms). Buffer forwards this to TikTok/IG/Pinterest only (the cover);
   *  YouTube/X ignore it and auto-pick an in-video frame. Buffer accepts NO custom cover IMAGE. */
  thumbnailOffsetMs?: number;
}
export interface BufferPostResult {
  postId: string;
}

const CREATE_POST = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id } }
    ... on MutationError { message }
  }
}`;

/**
 * Create + immediately publish (mode: shareNow) a video post to one Buffer channel. Enum inputs are
 * passed as plain strings inside the typed $input variable — GraphQL coerces them.
 */
export async function createBufferVideoPost(p: BufferVideoPost): Promise<BufferPostResult> {
  const video: Record<string, unknown> = { url: p.videoUrl };
  if (typeof p.thumbnailOffsetMs === "number") {
    video.metadata = { thumbnailOffset: Math.max(0, Math.round(p.thumbnailOffsetMs)) };
  }
  const input: Record<string, unknown> = {
    channelId: p.channelId,
    text: p.text,
    schedulingType: "automatic", // publish natively/automatically (vs "notification" reminders)
    mode: "shareNow", // publish right away rather than queueing
    assets: [{ video }],
  };
  if (p.youtube) {
    input.metadata = {
      youtube: {
        title: p.youtube.title.slice(0, 100),
        privacy: p.youtube.privacy,
        categoryId: "24", // Entertainment — Buffer requires a category on YouTube create
        madeForKids: false,
      },
    };
  }
  const data = await bufferGraphQL<{
    createPost: { __typename: string; post?: { id: string }; message?: string };
  }>(CREATE_POST, { input });
  const r = data.createPost;
  if (r.__typename !== "PostActionSuccess" || !r.post?.id) {
    throw new Error(`buffer createPost: ${r.message ?? "unknown error"}`);
  }
  return { postId: r.post.id };
}

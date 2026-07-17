// External bindings for the distribution engine, overridable for tests + the offline demo
// (doc 13 §2: mock at the connector/LLM boundary). Ayrshare is the single posting rail;
// reddit comments come from the reddit connector; the metadata-finalizer + comment-classifier
// are the only LLM calls in this engine.
import {
  type AyrshareAnalytics,
  type AyrshareComment,
  type AyrsharePost,
  type AyrsharePostResult,
  createPost,
  getComments,
  getHistory,
  getPostAnalytics,
  type RedditComment,
  reddit,
  replyComment,
} from "@ve/connectors";
import { runStructured, scoreBatch } from "@ve/llm";
import { presignGet } from "@ve/storage";

export interface DistributionDeps {
  createPost: (p: AyrsharePost) => Promise<AyrsharePostResult>;
  getHistory: (lastDays?: number) => Promise<Record<string, unknown>[]>;
  getPostAnalytics: (id: string) => Promise<AyrshareAnalytics>;
  getComments: (id: string) => Promise<AyrshareComment[]>;
  replyComment: (id: string, text: string) => Promise<void>;
  fetchRedditComments: (postId: string, limit?: number) => Promise<RedditComment[]>;
  presignGet: (key: string, ttlSec?: number) => Promise<string>;
  runStructured: typeof runStructured;
  scoreBatch: typeof scoreBatch;
}

export const distributionDeps: DistributionDeps = {
  createPost,
  getHistory,
  getPostAnalytics,
  getComments,
  replyComment,
  fetchRedditComments: reddit.fetchComments,
  presignGet,
  runStructured,
  scoreBatch,
};

export function setDistributionDeps(overrides: Partial<DistributionDeps>): void {
  Object.assign(distributionDeps, overrides);
}

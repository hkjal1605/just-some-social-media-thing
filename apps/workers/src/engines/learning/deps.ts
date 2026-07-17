// External bindings for the learning engine (doc 07). metrics.snapshot reads owned
// analytics (Ayrshare for tiktok/youtube/reddit, X own-posts for x); attribution +
// playbook are single structured LLM calls. Overridable for tests + the offline demo.
import type { AyrshareAnalytics, NormalizedItem } from "@ve/connectors";
import { getPostAnalytics, x } from "@ve/connectors";
import { runStructured } from "@ve/llm";

export interface LearningDeps {
  getPostAnalytics: (id: string) => Promise<AyrshareAnalytics>;
  getOwnXMetrics: (ids: string[]) => Promise<Map<string, NormalizedItem["metrics"]>>;
  runStructured: typeof runStructured;
}

export const learningDeps: LearningDeps = {
  getPostAnalytics,
  getOwnXMetrics: x.getOwnPostsMetrics,
  runStructured,
};

export function setLearningDeps(overrides: Partial<LearningDeps>): void {
  Object.assign(learningDeps, overrides);
}

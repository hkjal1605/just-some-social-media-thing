// Deterministic offline LLM bindings — used by tests (doc 13 §2: mock at the @ve/llm
// boundary) and by scripts/radar-demo.ts so the whole radar runs with zero credentials.
// NOT used in normal operation: setRadarDeps() must be called explicitly.
import type { EditorDecision, RubricResult, ScoredItem, TrendHeadline } from "@ve/core";
import type { RadarDeps } from "./deps";

/** Bag-of-words hash embedding: similar texts → similar vectors. 768-d, L2-normalized. */
export function offlineEmbed(texts: string[]): Promise<number[][]> {
  const vectors = texts.map((text) => {
    const v = new Array<number>(768).fill(0);
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const w of words) {
      const idx = Number(BigInt(Bun.hash(w)) % 768n);
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
  });
  return Promise.resolve(vectors);
}

const RED_HINTS = /(match footage|broadcast|full song|official video|movie clip|copyrighted)/i;
const AMBER_HINTS = /(quote|screenshot|statistic|according to|stated)/i;

export function offlineRubricFor(text: string): RubricResult {
  const rightsClass = RED_HINTS.test(text) ? "red" : AMBER_HINTS.test(text) ? "amber" : "green";
  // deterministic 70–90 so green items clear the editor threshold
  const llmScore = 70 + Number(BigInt(Bun.hash(text)) % 21n);
  return {
    whyViral: "offline heuristic: concrete claim + fresh angle",
    emotions: ["curiosity"],
    formatArchetype: "news",
    transferability: { tiktok: 80, youtube: 72, x: 76, reddit: 60 },
    longevity: "days",
    rightsClass,
    rightsNote: rightsClass === "green" ? "" : "offline heuristic flagged third-party material",
    llmScore,
  };
}

const offlineScoreBatch: RadarDeps["scoreBatch"] = async (opts) => {
  const out = new Map();
  for (const item of opts.items) {
    out.set(item.id, opts.schema.parse(offlineRubricFor(item.text)));
  }
  return out;
};

function extractCandidates(
  user: string,
): { trendId: string; headline: string; rightsClass: string }[] {
  const m = user.match(/## Candidate trends\n([\s\S]*?)\n\nReturn/);
  if (!m?.[1]) return [];
  try {
    return JSON.parse(m[1]) as { trendId: string; headline: string; rightsClass: string }[];
  } catch {
    return [];
  }
}

const offlineRunStructured: RadarDeps["runStructured"] = async <T>(opts: {
  agent: string;
  system: string;
  user: string;
  schema: { parse: (v: unknown) => T } | import("zod").ZodType<T>;
}): Promise<T> => {
  const parse = (v: unknown): T => (opts.schema as { parse: (x: unknown) => T }).parse(v);
  if (opts.agent === "trend-headline") {
    const firstLine = opts.user.split("\n").find((l) => /^\d+\./.test(l)) ?? "Detected trend";
    const cleaned = firstLine
      .replace(/^\d+\.\s*\[[a-z]+\]\s*/i, "")
      .split(" | why-viral:")[0]
      ?.trim();
    const headline: TrendHeadline = {
      headline: (cleaned ?? "Detected trend").slice(0, 120) || "Detected trend",
      summary: "Offline summary: cross-platform story detected by the radar fixture pipeline.",
    };
    return parse(headline);
  }
  if (opts.agent === "editor-in-chief") {
    const candidates = extractCandidates(opts.user);
    const decision: EditorDecision = {
      decisions: candidates.map((c, i) => ({
        trendId: c.trendId,
        act: i === 0 ? "brief" : "skip",
        reason: i === 0 ? "strongest candidate (offline)" : "offline: one brief per run",
        formatSlug: "faceless-explainer-60s",
        targetPlatforms: ["tiktok", "youtube"],
        angle: `Original take: what ${c.headline.slice(0, 80)} means in practice`,
      })),
    };
    return parse(decision);
  }
  throw new Error(`offlineRunStructured: unknown agent ${opts.agent}`);
};

export const offlineRadarDeps: RadarDeps = {
  embed: offlineEmbed,
  scoreBatch: offlineScoreBatch,
  runStructured: offlineRunStructured as RadarDeps["runStructured"],
};

export type { ScoredItem };

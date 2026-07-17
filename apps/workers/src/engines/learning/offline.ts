// Deterministic offline learning deps — the credential-free demo + unit tests (doc 13 §2).
// The offline analyst derives a killList straight from the tables (formats ≥3 weeks under
// median) and one playbook edit; the offline playbook-editor folds edits into the markdown.
import type { AyrshareAnalytics, NormalizedItem } from "@ve/connectors";
import {
  type AttributionReport,
  KILL_LIST_WEEKS_UNDER_MEDIAN,
  type PlaybookRewrite,
} from "@ve/core";
import type { AnalystTables } from "@ve/llm";
import type { LearningDeps } from "./deps";

/** Offline performance-analyst: kill formats ≥3 weeks under median, note top correlations. */
export function offlineAnalystReport(tables: AnalystTables[]): AttributionReport {
  const killList: AttributionReport["killList"] = [];
  const wins: AttributionReport["wins"] = [];
  const playbookEdits: AttributionReport["playbookEdits"] = [];

  for (const t of tables) {
    for (const [fmt, weeks] of Object.entries(
      t.formatsUnderMedianWeeks as Record<string, number>,
    )) {
      if (weeks >= KILL_LIST_WEEKS_UNDER_MEDIAN) {
        killList.push({
          categorySlug: t.categorySlug,
          formatSlug: fmt,
          reason: `${weeks} consecutive weeks below category median`,
        });
      }
    }
    const corr = t.numericCorrelations as Record<string, number | null>;
    const best = Object.entries(corr)
      .filter((e): e is [string, number] => e[1] !== null)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    if (best) {
      wins.push({
        finding: `${best[0]} correlates with 7d views (ρ=${best[1]})`,
        evidence: `spearman over ${t.postCount} posts in ${t.categorySlug}`,
        confidence: Math.abs(best[1]) > 0.5 ? "strong" : "tentative",
      });
      playbookEdits.push({
        categorySlug: t.categorySlug,
        section: "Hooks that work",
        edit: `Lean into ${best[0]} (ρ=${best[1]} vs 7d views).`,
        rationale: `strongest numeric correlation this window`,
      });
    }
  }

  return {
    headline: `Offline attribution over ${tables.length} categories`,
    wins,
    losses: [],
    playbookEdits,
    killList,
    experiments: [],
  };
}

/** Offline playbook-editor: fold edits + kill list into the existing markdown, preserving sections. */
export function offlineApplyPlaybook(input: {
  currentMarkdown: string;
  edits: { section: string; edit: string }[];
  killList: { formatSlug: string; reason: string }[];
}): PlaybookRewrite {
  const lines = input.currentMarkdown.split("\n");
  const insertUnder = (heading: string, additions: string[]) => {
    const idx = lines.findIndex((l) => l.trim().toLowerCase() === `# ${heading}`.toLowerCase());
    if (idx === -1) {
      lines.push(`# ${heading}`, ...additions);
    } else {
      lines.splice(idx + 1, 0, ...additions);
    }
  };
  for (const e of input.edits) insertUnder(e.section, [`- ${e.edit}`]);
  if (input.killList.length > 0) {
    insertUnder(
      "Kill list",
      input.killList.map((k) => `- ${k.formatSlug} — ${k.reason}`),
    );
  }
  return {
    markdown: lines.join("\n"),
    changeSummary: `applied ${input.edits.length} edits, ${input.killList.length} kills`,
  };
}

const offlineRunStructured: LearningDeps["runStructured"] = async <T>(opts: {
  agent: string;
  user: string;
  schema: { parse: (v: unknown) => T };
}): Promise<T> => {
  if (opts.agent === "performance-analyst") {
    const m = opts.user.match(/reason only from these\)\n([\s\S]*?)\n\nReturn the attribution/);
    const tables = m?.[1] ? (JSON.parse(m[1]) as AnalystTables[]) : [];
    return opts.schema.parse(offlineAnalystReport(tables));
  }
  if (opts.agent === "playbook-editor") {
    const cur = opts.user.match(/## Current playbook\n([\s\S]*?)\n\n## Edits to apply/)?.[1] ?? "";
    const editLines = [...opts.user.matchAll(/^- \[[^\]]+\] (.+?) \(why:/gm)].map((x) => ({
      section: "Hooks that work",
      edit: x[1] as string,
    }));
    const killLines = [...opts.user.matchAll(/^- (\S+) — (.+)$/gm)].map((x) => ({
      formatSlug: x[1] as string,
      reason: x[2] as string,
    }));
    return opts.schema.parse(
      offlineApplyPlaybook({ currentMarkdown: cur, edits: editLines, killList: killLines }),
    );
  }
  throw new Error(`offline learning runStructured: unknown agent ${opts.agent}`);
};

function syntheticAnalytics(id: string): AyrshareAnalytics {
  const n = Number(id.replace(/\D/g, "")) || 1;
  const views = 1000 * n;
  return {
    views,
    likes: Math.round(views * 0.08),
    comments: Math.round(views * 0.01),
    shares: Math.round(views * 0.005),
    watchTimeSec: views * 12,
    avgViewDurationSec: 18.5,
    raw: { source: "offline", id },
  };
}

export function offlineLearningDeps(opts?: Partial<LearningDeps>): LearningDeps {
  return {
    getPostAnalytics: opts?.getPostAnalytics ?? (async (id) => syntheticAnalytics(id)),
    getOwnXMetrics:
      opts?.getOwnXMetrics ??
      (async (ids: string[]) => {
        const out = new Map<string, NormalizedItem["metrics"]>();
        for (const id of ids) {
          const a = syntheticAnalytics(id);
          out.set(id, {
            views: a.views ?? 0,
            likes: a.likes ?? 0,
            comments: a.comments ?? 0,
            shares: a.shares ?? 0,
          });
        }
        return out;
      }),
    runStructured: opts?.runStructured ?? offlineRunStructured,
  };
}

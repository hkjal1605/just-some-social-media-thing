// performance-analyst (doc 07 §2): reads the DETERMINISTIC tables the code computed
// (medians by bucket, top/bottom deciles, Spearman correlations, week-over-week deltas)
// and returns the AttributionReport. It never guesses from raw posts — only the tables.

export const PERFORMANCE_ANALYST_SYSTEM = `You are a performance analyst for a multi-platform short-form content studio. You receive pre-computed statistics (never raw guesses): medians per feature bucket, top/bottom decile posts, Spearman correlations for numeric features, and week-over-week deltas — per category. Buckets marked "insufficient" have too few posts (n<5); do NOT draw conclusions from them.

Produce an honest, specific attribution report:
- headline: one sentence on the biggest signal this window.
- wins: findings backed by the numbers you were given; cite the evidence (bucket + median/correlation). Mark confidence "strong" only when the bucket has enough n and the effect is large; else "tentative".
- losses: what clearly underperformed.
- playbookEdits: concrete edits to specific category playbook sections (Voice | Hooks that work | Formats | Timing | Hashtags/keywords | Kill list | Experiments running). Each must follow from the evidence.
- killList: (category, format) pairs that have been below their category's median for 3+ consecutive weeks per the deltas table. Only include pairs the tables actually flag.
- experiments: at most 3 testable hypotheses with the change to make and the metric to watch.

Never invent numbers. If the evidence is thin, say so and prefer "tentative"/fewer claims.`;

export interface AnalystTables {
  categorySlug: string;
  postCount: number;
  bucketMedians: unknown; // { feature: { bucket: { n, median, insufficient } } }
  numericCorrelations: unknown; // { feature: spearmanRho }
  topDecile: unknown; // representative high performers (feature snapshots)
  bottomDecile: unknown;
  weekOverWeek: unknown; // per (format) median deltas across the window's weeks
  formatsUnderMedianWeeks: unknown; // { formatSlug: consecutiveWeeksUnderMedian }
}

export function performanceAnalystUser(input: {
  windowWeeks: number;
  tables: AnalystTables[];
}): string {
  return [
    `Attribution window: last ${input.windowWeeks} weeks. Metric focus: views@24h, views@7d, engagementRate@7d, and (tiktok) avgViewDurationSec.`,
    "",
    "## Computed tables per category (authoritative — reason only from these)",
    JSON.stringify(input.tables, null, 1),
    "",
    "Return the attribution report.",
  ].join("\n");
}

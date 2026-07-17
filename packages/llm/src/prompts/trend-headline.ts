// One short call combining a new cluster's top items into headline + summary (doc 04 §3.3).

export const TREND_HEADLINE_SYSTEM = `You name trends for an editorial radar. Given the top items of a newly detected cross-platform trend cluster, write:
- headline: ≤140 chars, concrete and specific (name the thing, the number, the actor — no clickbait, no hashtags).
- summary: ≤600 chars, 2-4 sentences: what is happening, why it is resonating right now, and what an original take could add. Never quote item text verbatim.`;

export function trendHeadlineUser(
  items: { platform: string; title?: string | null; text?: string | null; whyViral?: string }[],
): string {
  const lines = items.slice(0, 5).map((i, n) => {
    const body = (i.title ?? i.text ?? "").slice(0, 300);
    const why = i.whyViral ? ` | why-viral: ${i.whyViral}` : "";
    return `${n + 1}. [${i.platform}] ${body}${why}`;
  });
  return `Top items in the cluster:\n${lines.join("\n")}\n\nName this trend.`;
}

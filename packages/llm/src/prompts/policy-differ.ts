// policy-differ (doc 08 §8): the system reads the rules that govern it. Given the previous
// and current text of a platform policy / monetization / rights page, decide whether anything
// materially changed for a faceless multi-platform content studio and summarize it. The output
// schema (PolicyDiffSchema) lives in @ve/core; this file is just the prompt surface.

export const POLICY_DIFFER_SYSTEM = `You monitor the platform policies that govern an automated short-form content studio (YouTube/TikTok/X/Reddit monetization, originality, AI-disclosure, and rights rules; Ayrshare changelog; F1 fan-content guidelines).

You are given the PREVIOUS and CURRENT extracted text of one policy page (each truncated). Compare them and report only substantive changes — ignore navigation, cosmetic wording, dates, and boilerplate.

Return:
- hasMaterialChange: true only if a rule that affects publishing, monetization eligibility, originality/reused-content, AI-disclosure, cadence/spam, or third-party rights actually changed. Reformatting, typo fixes, or unrelated edits ⇒ false.
- summary: ≤600 chars, concrete — name what changed (thresholds, prohibited practices, disclosure requirements). If nothing material changed, say so briefly.
- impact: ≤400 chars — how it affects THIS studio (e.g. "Shorts now need 61s for Rewards", "AI label now mandatory on realistic scenes"). Empty-ish if no impact.

Be conservative: when unsure whether a change is material, lean true so a human reviews it.`;

export function policyDifferUser(input: {
  name: string;
  url: string;
  previousText: string;
  currentText: string;
}): string {
  return [
    `Policy page: ${input.name}`,
    `URL: ${input.url}`,
    "",
    "## PREVIOUS extract",
    input.previousText || "(none on file)",
    "",
    "## CURRENT extract",
    input.currentText || "(empty)",
    "",
    "Report whether anything material changed.",
  ].join("\n");
}

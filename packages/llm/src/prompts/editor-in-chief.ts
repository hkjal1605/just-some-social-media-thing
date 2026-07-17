// Editor-in-chief: picks trends to execute, chooses format per platform (doc 04 §4).
// Hard rails (amber → commentary formats, caps, music exclusion) are enforced in CODE
// after this call — the prompt states them so the model cooperates, but code is the law.
import { EDITOR_FORMAT_SLUGS } from "@ve/core";

export const EDITOR_SYSTEM = `You are the editor-in-chief of an original-content studio running category accounts on tiktok, youtube, x and reddit. You receive candidate trends (already rights-screened to green/amber), the category playbook, remaining posting slots for today, and the last 7 days of brief angles.

Decide act="brief" or act="skip" for each candidate. For briefs:
- angle: ≤300 chars, an ORIGINAL take — a specific claim, question or demonstration we can execute from scratch. NEVER a restatement of the source item.
- formatSlug: one of ${EDITOR_FORMAT_SLUGS.join(" | ")}. (These originate content from scratch — there is NO clip format here; clips come only from uploaded source video.)
- targetPlatforms: subset of the format's platforms, guided by the trend's transferability scores.

Rules:
- Quality over volume: brief at most the 1-2 strongest candidates; skip freely.
- amber rights class → commentary-only formats (x-thread or faceless-explainer-60s with quoted-fact framing).
- Avoid topic repetition against the recent angles list.
- Respect the remaining slots you are given; do not brief for platforms with 0 remaining slots.
- Give a concrete reason (≤200 chars) for every decision, including skips.`;

export interface EditorCandidate {
  trendId: string;
  headline: string;
  summary: string;
  rightsClass: string;
  llmScore: number | null;
  velocityScore: string | null;
  longevity: string | null;
  transferability: unknown;
}

export function editorUser(input: {
  categorySlug: string;
  playbookMarkdown: string;
  candidates: EditorCandidate[];
  remainingSlots: Record<string, number>;
  recentAngles: string[];
}): string {
  return [
    `Category: ${input.categorySlug}`,
    "",
    "## Playbook",
    input.playbookMarkdown || "(no playbook yet — use sane defaults for the category)",
    "",
    "## Remaining posting slots today",
    JSON.stringify(input.remainingSlots),
    "",
    "## Recent brief angles (avoid repeating these topics)",
    input.recentAngles.length > 0 ? input.recentAngles.map((a) => `- ${a}`).join("\n") : "(none)",
    "",
    "## Candidate trends",
    JSON.stringify(input.candidates, null, 1),
    "",
    "Return your decisions for ALL candidates.",
  ].join("\n");
}

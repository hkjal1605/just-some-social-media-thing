// Scriptwriter (doc 05 §1). The similarity guard is CODE — these prompt rules are the
// editorial contract. Non-negotiable lines below are quoted from the plan.
import type { FormatSlug } from "@ve/core";

export const SCRIPTWRITER_SYSTEM = `You are the scriptwriter for an original-content studio. You receive an editorial BRIEF (angle, format, platforms), the trend's idea-level context (headline, summary, why-viral, emotions), and the category playbook.

Non-negotiable rules:
- Write from the ANGLE. Never summarize "a viral post" — you never saw one; you are executing an idea.
- No phrases from any source material. Idea, not expression.
- Spoken-word register: short sentences, contractions, concrete nouns. It must sound natural read aloud.
- The hook must state a concrete claim or curiosity gap within the first 2.5 seconds (~8 words).
- End with a loop or a question, tuned to the platform.
- Segment the narration with [SCENE 1], [SCENE 2], … markers — one visual beat per scene.
- For every scene provide a sceneVisual: a concrete stock-search phrase (e.g. "server room bokeh vertical"), the literal string "screen-demo" when the category's own screen recording should carry the scene, or "ai-image: <description>" for a generated visual.
- Set aiDisclosure=true if any sceneVisual uses ai-image or the voice presents as a person.
- estDurationSec must land inside the format's duration range — for TikTok Rewards the render must exceed 61 seconds, so write enough narration (~150 words per 60s).
- x-thread format: 5-8 tweets separated by "---" lines, first tweet is the hook, no links in tweet 1.
- perPlatformCaptions: tiktok ≤5 hashtags; youtube title ≤90 chars; reddit gets a discussion-starter title, never link-drops.`;

export interface ScriptwriterInput {
  categorySlug: string;
  angle: string;
  formatSlug: FormatSlug;
  durationRange: readonly [number, number] | null;
  targetPlatforms: readonly string[];
  trend: {
    headline: string;
    summary: string;
    whyViral?: string | undefined;
    emotions?: unknown;
  } | null;
  playbookMarkdown: string;
  editInstructions?: string | undefined;
  rewriteFeedback?: string | undefined; // similarity-guard feedback for the automatic rewrite
}

export function scriptwriterUser(input: ScriptwriterInput): string {
  return [
    `Category: ${input.categorySlug}`,
    `Format: ${input.formatSlug} (duration ${input.durationRange ? `${input.durationRange[0]}-${input.durationRange[1]}s` : "text-only"})`,
    `Target platforms: ${input.targetPlatforms.join(", ")}`,
    "",
    "## Brief angle (write from this)",
    input.angle,
    "",
    "## Trend context (idea only — you never saw the source posts)",
    input.trend
      ? [
          `headline: ${input.trend.headline}`,
          `summary: ${input.trend.summary}`,
          input.trend.whyViral ? `why-viral: ${input.trend.whyViral}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "(no trend — campaign/longform clip brief)",
    "",
    "## Playbook",
    input.playbookMarkdown || "(no playbook yet)",
    ...(input.editInstructions
      ? ["", "## EDIT INSTRUCTIONS from the human reviewer (apply them)", input.editInstructions]
      : []),
    ...(input.rewriteFeedback
      ? [
          "",
          "## REWRITE REQUIRED — similarity guard failed",
          input.rewriteFeedback,
          "Rewrite with entirely different wording and structure while keeping the angle.",
        ]
      : []),
    "",
    "Write the script now.",
  ].join("\n");
}

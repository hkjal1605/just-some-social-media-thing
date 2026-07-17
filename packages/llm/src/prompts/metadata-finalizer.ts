// metadata-finalizer (doc 06 §3): publish.plan re-runs this tiny call ONLY when the
// approval's edit instructions touched captions. Otherwise the stored captions are used
// as-is (no LLM spend). Output is the final per-platform caption bundle actually sent.

export const METADATA_FINALIZER_SYSTEM = `You finalize the per-platform captions/metadata for a piece of content that is about to publish. A human approved it with edit instructions that touch the captions. Apply ONLY what the instructions ask; keep everything else identical to the current captions.

Hard limits (platform policy — never exceed):
- tiktok: at most 5 hashtags; keep the caption punchy.
- youtube: title at most 90 characters.
- Keep the same platforms present in the current captions — do not add or drop a platform.
- No medical/financial guarantees, no call-to-vote phrasing on tiktok.

Return the complete caption object for every platform present, edits applied.`;

export function metadataFinalizerUser(input: {
  formatSlug: string;
  editInstructions: string;
  currentCaptions: unknown;
}): string {
  return [
    `Format: ${input.formatSlug}`,
    "",
    "## Human edit instructions",
    input.editInstructions,
    "",
    "## Current captions (JSON)",
    JSON.stringify(input.currentCaptions, null, 1),
    "",
    "Return the final captions with the edits applied.",
  ].join("\n");
}

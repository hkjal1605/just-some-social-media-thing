// playbook-editor (doc 07 §3): applies the attribution report's edits/killList/experiments
// to the current per-category playbook markdown and returns the FULL rewritten markdown
// (≤ 1500 words), keeping the fixed section structure.

import { PLAYBOOK_MAX_WORDS, PLAYBOOK_SECTIONS } from "@ve/core";

export const PLAYBOOK_EDITOR_SYSTEM = `You maintain a single category's content playbook — the operating manual the editor-in-chief, scriptwriter, and scheduler read. You are given the current playbook markdown and a set of edits, kill-list entries, and experiments derived from real performance data. Apply them and return the complete rewritten markdown.

Rules:
- Keep EXACTLY these H1 sections, in this order: ${PLAYBOOK_SECTIONS.map((s) => `# ${s}`).join(", ")}.
- Apply every playbook edit to the right section; fold kill-list entries into "# Kill list" as "(format) — reason"; list experiments under "# Experiments running".
- Preserve still-valid existing guidance; don't discard institutional knowledge that wasn't contradicted.
- Be concrete and imperative ("Open on a number in the first 2s"), not vague.
- Total length ≤ ${PLAYBOOK_MAX_WORDS} words. Tighten prose to fit; never drop a section.

Return the full markdown plus a one-line changeSummary of what changed.`;

export interface PlaybookEditInput {
  categorySlug: string;
  currentMarkdown: string;
  edits: { section: string; edit: string; rationale: string }[];
  killList: { formatSlug: string; reason: string }[];
  experiments: { hypothesis: string; change: string; metric: string }[];
}

export function playbookEditorUser(input: PlaybookEditInput): string {
  return [
    `Category: ${input.categorySlug}`,
    "",
    "## Current playbook",
    input.currentMarkdown || "(no playbook yet — create one with all sections)",
    "",
    "## Edits to apply",
    input.edits.length > 0
      ? input.edits.map((e) => `- [${e.section}] ${e.edit} (why: ${e.rationale})`).join("\n")
      : "(none)",
    "",
    "## Kill list additions",
    input.killList.length > 0
      ? input.killList.map((k) => `- ${k.formatSlug} — ${k.reason}`).join("\n")
      : "(none)",
    "",
    "## Experiments to run",
    input.experiments.length > 0
      ? input.experiments
          .map((x) => `- ${x.hypothesis} → change: ${x.change}; watch: ${x.metric}`)
          .join("\n")
      : "(none)",
    "",
    "Return the full rewritten playbook markdown.",
  ].join("\n");
}

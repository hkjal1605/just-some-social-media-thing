# Agent prompts

One file per agent prompt (doc 03 §5, doc 08 §4). Prompts are code-reviewed artifacts,
versioned in git, and interpolate the current playbook markdown where the engine docs note it.

Inventory (added as each engine lands — docs 04–08):

| File | Agent | Engine doc |
|---|---|---|
| `radar-rubric.ts` | Layer-B scoring rubric (Gemini batch) | 04 §2 |
| `trend-headline.ts` | Trend headline/summary combiner | 04 §3 |
| `editor-in-chief.ts` | Trend → brief decisions | 04 §4 |
| `scriptwriter.ts` | Brief → script + hooks + captions | 05 §1 |
| `metadata-finalizer.ts` | Caption rewrite after edit-approvals | 06 §3 |
| `clip-analyzer.ts` | Long-form moment finding (video) | 05 §5 |
| `comment-classifier.ts` | Engagement triage (Gemini batch) | 06 §6 |
| `performance-analyst.ts` | Weekly attribution narrative | 07 §2 |
| `playbook-editor.ts` | Playbook rewrite from edits | 07 §3 |
| `policy-differ.ts` | Policy page diff summaries | 08 §8 |

Rules that apply to every prompt here:

- The Scriptwriter **never** sees source transcripts or member texts beyond the stored
  ≤600-char snippets — briefs carry the trend's *idea*, not its wording (doc 04 §6).
- Rights rubric wording (green/amber/red) is quoted verbatim from doc 04 §2 and must not drift.
- Category `music` → always `red`. When unsure → `red` (bias to safe).

// comment-classifier (doc 06 §6): cheap Gemini-batch classification of new comments on
// our own posts. Used via scoreBatch — this is the rubric string prepended to each batch.
// Output per item validated against CommentClassificationSchema (@ve/core).

export const COMMENT_CLASSIFIER_RUBRIC = `You classify viewer comments on our own short-form videos so we can engage well and safely.

For each comment return:
- kind: one of "question" | "praise" | "criticism" | "spam" | "other".
- needsHuman: true when the comment deserves a human touch — controversy, a specific factual question we cannot answer confidently, a complaint, anything sensitive (health, money, politics, legal). Criticism ALWAYS needs a human.
- draftReply: OPTIONAL. Provide a short, warm, on-brand reply (≤ 240 chars, no links, no hashtags) ONLY for:
    • praise → a brief genuine thank-you, or
    • a simple question we can answer confidently from general knowledge.
  Do NOT draft a reply for criticism, spam, controversy, or anything you're unsure about — leave draftReply empty and set needsHuman.

Never draft replies that make medical/financial guarantees or take political sides. When in doubt, set needsHuman and omit draftReply.`;

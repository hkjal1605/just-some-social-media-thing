// R2 key conventions (doc 00 §5.5). All keys are built here — never hand-rolled.

export const r2Key = {
  asset: (briefId: string, assetId: string, ext: string): string =>
    `assets/${briefId}/${assetId}.${ext}`,
  render: (briefId: string, renderId: string, platform: string): string =>
    `renders/${briefId}/${renderId}_${platform}.mp4`,
  longformSource: (longFormId: string): string => `longforms/${longFormId}/source.mp4`,
  longformTranscript: (longFormId: string): string => `longforms/${longFormId}/transcript.json`,
  longformClip: (longFormId: string, clipId: string): string =>
    `longforms/${longFormId}/clips/${clipId}.mp4`,
  campaignSource: (campaignId: string, fileId: string, ext = "mp4"): string =>
    `campaigns/${campaignId}/source/${fileId}.${ext}`,
  thumb: (renderId: string): string => `thumbs/${renderId}.jpg`,
  attributionReport: (dateIso: string): string => `reports/attribution/${dateIso}.md`,
  // policy.watch stores each page's extracted text so the next run can diff old vs new (doc 08 §8)
  policySnapshot: (policyPageId: string): string => `policy/${policyPageId}.txt`,
} as const;

/** Prefixes the presign API route will accept (doc 11 route inventory). */
export const KNOWN_KEY_PREFIXES = [
  "assets/",
  "renders/",
  "longforms/",
  "campaigns/",
  "thumbs/",
  "reports/",
] as const;

export function isKnownKey(key: string): boolean {
  return KNOWN_KEY_PREFIXES.some((p) => key.startsWith(p));
}

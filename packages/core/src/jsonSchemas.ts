// Every JSONB column has a zod schema named <Table><Column>Schema (doc 02 §1).
import { z } from "zod";
import { COMPLIANCE_CHECK, PlatformSchema } from "./enums";

const score0to100 = z.number().min(0).max(100);

export const CategoriesAutoApproveFormatsSchema = z.array(z.string());
export type CategoriesAutoApproveFormats = z.infer<typeof CategoriesAutoApproveFormatsSchema>;

export const CategoriesCadenceCapsSchema = z.object({
  tiktok: z.number().int().min(0),
  youtube: z.number().int().min(0),
  x: z.number().int().min(0),
  reddit: z.number().int().min(0),
});
export type CategoriesCadenceCaps = z.infer<typeof CategoriesCadenceCapsSchema>;

export const RawItemsEmbeddingSchema = z.array(z.number()); // 768-d (doc 02 §4)
export type RawItemsEmbedding = z.infer<typeof RawItemsEmbeddingSchema>;

export const TrendsEmotionsSchema = z.array(z.string());
export type TrendsEmotions = z.infer<typeof TrendsEmotionsSchema>;

export const TrendsTransferabilitySchema = z.object({
  tiktok: score0to100,
  youtube: score0to100,
  x: score0to100,
  reddit: score0to100,
});
export type TrendsTransferability = z.infer<typeof TrendsTransferabilitySchema>;

export const BriefsTargetPlatformsSchema = z.array(PlatformSchema);
export type BriefsTargetPlatforms = z.infer<typeof BriefsTargetPlatformsSchema>;

export const ScriptsHookVariantsSchema = z
  .array(z.object({ id: z.enum(["a", "b", "c"]), text: z.string() }))
  .max(3);
export type ScriptsHookVariants = z.infer<typeof ScriptsHookVariantsSchema>;

export const PerPlatformCaptionsSchema = z.object({
  tiktok: z.object({ caption: z.string(), hashtags: z.array(z.string()).max(5) }).optional(),
  youtube: z
    .object({
      title: z.string().max(100),
      description: z.string(),
      tags: z.array(z.string()),
    })
    .optional(),
  x: z.object({ text: z.string() }).optional(),
  reddit: z.object({ title: z.string(), subreddit: z.string(), body: z.string() }).optional(),
});
export type PerPlatformCaptions = z.infer<typeof PerPlatformCaptionsSchema>;
/** Alias matching the <Table><Column>Schema convention. */
export const ScriptsPerPlatformCaptionsSchema = PerPlatformCaptionsSchema;

export const ScriptsSimilarityReportSchema = z.object({
  maxCosine: z.number(),
  maxNgramOverlap: z.number(),
  vsRawItemId: z.string().nullable(),
  pass: z.boolean(),
});
export type ScriptsSimilarityReport = z.infer<typeof ScriptsSimilarityReportSchema>;

export const AssetsMetaSchema = z
  .object({
    sceneIndex: z.number().optional(),
    pexelsId: z.union([z.string(), z.number()]).optional(),
    license: z.string().optional(),
    voiceId: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    demo: z.boolean().optional(),
    music: z.boolean().optional(),
  })
  .passthrough();
export type AssetsMeta = z.infer<typeof AssetsMetaSchema>;

export const ComplianceChecksResultsSchema = z.array(
  z.object({
    check: z.enum(COMPLIANCE_CHECK),
    pass: z.boolean(),
    detail: z.string().optional(),
  }),
);
export type ComplianceChecksResults = z.infer<typeof ComplianceChecksResultsSchema>;

export const ApprovalEventsDetailSchema = z.record(z.unknown());
export type ApprovalEventsDetail = z.infer<typeof ApprovalEventsDetailSchema>;

/** Final metadata actually sent to the platform at publish time (audit trail). */
export const PostsCaptionUsedSchema = z.record(z.unknown());
export type PostsCaptionUsed = z.infer<typeof PostsCaptionUsedSchema>;

export const PostSnapshotsRawSchema = z.record(z.unknown());
export type PostSnapshotsRaw = z.infer<typeof PostSnapshotsRawSchema>;

/** settings.value is free-form JSON; well-known keys have their own schemas below. */
export const SettingsValueSchema = z.unknown();

// 'HH:MM' 24h, range-checked (00:00–23:59) so a bad window can never reach the scheduler's parseHhMm.
const HhMm = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "expected HH:MM in 24h time (00:00–23:59)");
const WeekdayToken = z.enum(["*", "sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const PostingWindowSchema = z.object({
  days: z.array(WeekdayToken).min(1), // ['*'] or ['sat','sun'] / ['tue','wed','thu']
  start: HhMm, // 'HH:MM' in IST
  end: HhMm,
  flag: z.string().optional(), // A/B flag gating this window (e.g. tiktok_weekend_am)
  bestDay: z.string().optional(),
});
export const SettingsPostingWindowsSchema = z.object({
  tiktok: z.array(PostingWindowSchema),
  youtube: z.array(PostingWindowSchema),
  x: z.array(PostingWindowSchema),
  reddit: z.array(PostingWindowSchema),
});
export type SettingsPostingWindows = z.infer<typeof SettingsPostingWindowsSchema>;

export const SettingsBudgetStateSchema = z.object({
  monthUsd: z.number(),
  warnedAt: z.string().nullable().optional(),
  killedAt: z.string().nullable().optional(),
});
export type SettingsBudgetState = z.infer<typeof SettingsBudgetStateSchema>;

export const SettingsYoutubeQuotaSchema = z.object({
  date: z.string(), // UTC YYYY-MM-DD the counter applies to
  used: z.number().int().min(0),
});
export type SettingsYoutubeQuota = z.infer<typeof SettingsYoutubeQuotaSchema>;

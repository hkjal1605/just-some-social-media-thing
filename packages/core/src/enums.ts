// Single source of truth for every status enum (doc 00 §5.2).
// Postgres stores plain text; these zod enums validate app-side.
import { z } from "zod";

export const RIGHTS_CLASS = ["green", "amber", "red"] as const;
export const TREND_STATUS = ["active", "briefed", "expired", "suppressed"] as const;
export const BRIEF_STATUS = [
  "draft",
  "scripted",
  "producing",
  "blocked",
  "ready",
  "abandoned",
] as const;
export const ASSET_KIND = [
  "tts_audio",
  "image",
  "broll_video",
  "captions_ass",
  "thumbnail",
  "source_video",
] as const;
export const RENDER_STATUS = ["pending", "rendering", "done", "failed"] as const;
export const APPROVAL_STATUS = [
  "pending",
  "approved",
  "rejected",
  "edit_requested",
  "expired",
  "auto_approved",
] as const;
export const POST_STATUS = [
  "draft",
  "awaiting_approval",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "deleted",
] as const;
export const PLATFORM = ["reddit", "youtube", "x", "tiktok"] as const;
// politics=human_gated forever, music=radar_only
export const CATEGORY_MODE = ["full_auto_candidate", "human_gated", "radar_only"] as const;

// Secondary enums referenced by doc 02 column comments.
export const SOURCE_KIND = [
  "subreddit",
  "yt_channel",
  "yt_chart",
  "x_query",
  "tiktok_hashtag",
  "tiktok_creator",
] as const;
export const MEDIA_TYPE = ["video", "image", "text", "link"] as const;
export const LONGEVITY = ["flash", "days", "evergreen"] as const;
export const FORMAT_ARCHETYPE = [
  "explainer",
  "hot-take",
  "demo",
  "listicle",
  "reaction",
  "news",
  "meme",
] as const;
export const BRIEF_ORIGIN = ["trend", "longform_clip", "campaign_clip"] as const;
export const COMPLIANCE_STAGE = ["pre_render", "pre_publish"] as const;
export const COMPLIANCE_CHECK = [
  "rights",
  "similarity",
  "ai_disclosure",
  "music",
  "category_rules",
  "platform_policy",
] as const;
export const LONG_FORM_STATUS = ["uploaded", "transcribed", "analyzed", "clipped"] as const;
export const AGENT_RUN_STATUS = ["ok", "error", "validation_retry"] as const;
export const DECIDED_VIA = ["telegram", "dashboard", "auto"] as const;
export const APPROVAL_EVENT = [
  "created",
  "reminded",
  "approved",
  "rejected",
  "edit_requested",
  "expired",
  "race_ignored",
  "renewed",
] as const;

export const RightsClassSchema = z.enum(RIGHTS_CLASS);
export const TrendStatusSchema = z.enum(TREND_STATUS);
export const BriefStatusSchema = z.enum(BRIEF_STATUS);
export const AssetKindSchema = z.enum(ASSET_KIND);
export const RenderStatusSchema = z.enum(RENDER_STATUS);
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUS);
export const PostStatusSchema = z.enum(POST_STATUS);
export const PlatformSchema = z.enum(PLATFORM);
export const CategoryModeSchema = z.enum(CATEGORY_MODE);
export const SourceKindSchema = z.enum(SOURCE_KIND);
export const MediaTypeSchema = z.enum(MEDIA_TYPE);
export const LongevitySchema = z.enum(LONGEVITY);
export const FormatArchetypeSchema = z.enum(FORMAT_ARCHETYPE);
export const BriefOriginSchema = z.enum(BRIEF_ORIGIN);
export const ComplianceStageSchema = z.enum(COMPLIANCE_STAGE);
export const ComplianceCheckSchema = z.enum(COMPLIANCE_CHECK);
export const LongFormStatusSchema = z.enum(LONG_FORM_STATUS);
export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUS);
export const DecidedViaSchema = z.enum(DECIDED_VIA);
export const ApprovalEventSchema = z.enum(APPROVAL_EVENT);

export type RightsClass = z.infer<typeof RightsClassSchema>;
export type TrendStatus = z.infer<typeof TrendStatusSchema>;
export type BriefStatus = z.infer<typeof BriefStatusSchema>;
export type AssetKind = z.infer<typeof AssetKindSchema>;
export type RenderStatus = z.infer<typeof RenderStatusSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type PostStatus = z.infer<typeof PostStatusSchema>;
export type Platform = z.infer<typeof PlatformSchema>;
export type CategoryMode = z.infer<typeof CategoryModeSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type MediaType = z.infer<typeof MediaTypeSchema>;
export type Longevity = z.infer<typeof LongevitySchema>;
export type FormatArchetype = z.infer<typeof FormatArchetypeSchema>;
export type BriefOrigin = z.infer<typeof BriefOriginSchema>;
export type ComplianceStage = z.infer<typeof ComplianceStageSchema>;
export type ComplianceCheck = z.infer<typeof ComplianceCheckSchema>;
export type LongFormStatus = z.infer<typeof LongFormStatusSchema>;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type DecidedVia = z.infer<typeof DecidedViaSchema>;
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

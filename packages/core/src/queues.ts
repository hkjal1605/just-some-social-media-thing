// Queue name constants + payload zod schemas (doc 00 §5.1, doc 03 §2).
// Every boss.send / boss.work goes through these — workers parse payloads before acting.
import { z } from "zod";
import { COMPLIANCE_STAGE } from "./enums";
import { ScoredItemSchema } from "./radar";

export const Q = {
  scoutReddit: "scout.reddit",
  scoutYoutube: "scout.youtube",
  scoutX: "scout.x",
  scoutTiktok: "scout.tiktok",
  radarScore: "radar.score",
  radarCluster: "radar.cluster",
  radarDigest: "radar.digest",
  factoryBrief: "factory.brief",
  factoryScript: "factory.script",
  factoryTts: "factory.tts",
  factoryVisuals: "factory.visuals",
  factoryCaptions: "factory.captions",
  factoryRender: "factory.render",
  factoryCompliance: "factory.compliance",
  clipIngestUrl: "clip.ingestUrl",
  clipTranscribe: "clip.transcribe",
  clipAnalyze: "clip.analyze",
  clipCut: "clip.cut",
  clipPublish: "clip.publish",
  approvalRequest: "approval.request",
  approvalRemind: "approval.remind",
  publishPlan: "publish.plan",
  publishExecute: "publish.execute",
  publishVerify: "publish.verify",
  engageScan: "engage.scan",
  engageReply: "engage.reply",
  metricsSnapshot: "metrics.snapshot",
  learnAttribute: "learn.attribute",
  playbookUpdate: "playbook.update",
  policyWatch: "policy.watch",
  costsRollup: "costs.rollup",
  alertTelegram: "alert.telegram",
} as const;

export type QueueName = (typeof Q)[keyof typeof Q];
export const ALL_QUEUES: readonly QueueName[] = Object.values(Q);

const uuid = z.string().uuid();

export const EmptyPayload = z.object({});
// sourceId absent = the every-15-min cron tick: scan due sources for the platform
// and fan out one job per due source (doc 04 §1)
export const ScoutPayload = z.object({ sourceId: uuid.optional() });
export const RadarScorePayload = z.object({ categoryId: uuid, rawItemIds: z.array(uuid) });
export const RadarClusterPayload = z.object({
  categoryId: uuid.optional(),
  // scored items carried from radar.score (doc 04 §2 → §3); empty for the maintenance tick
  items: z.array(ScoredItemSchema).default([]),
  maintenance: z.boolean().default(false), // expiry tick (doc 04 §3.5)
});
export const FactoryBriefPayload = z.object({ categoryId: uuid.optional() });
export const FactoryScriptPayload = z.object({
  briefId: uuid,
  editInstructions: z.string().optional(), // set by the edit-requested flow (doc 09 §1)
});
export const FactoryAssetPayload = z.object({ briefId: uuid, scriptId: uuid });
export const FactoryRenderPayload = z.object({ briefId: uuid });
export const FactoryCompliancePayload = z.object({
  briefId: uuid,
  stage: z.enum(COMPLIANCE_STAGE),
});
export const ClipIngestPayload = z.object({
  kind: z.enum(["longform", "campaign"]),
  id: uuid,
});
export const ClipIngestUrlPayload = z.object({ longFormId: uuid });
export const ClipCutPayload = z.object({ clipCandidateId: uuid, briefId: uuid });
// direct social post of a rendered clip (Clip Studio "Post" button) — bypasses the approval/cadence
// pipeline; platform is read from the post row
export const ClipPublishPayload = z.object({ postId: uuid });
export const ApprovalRequestPayload = z.object({ briefId: uuid });
export const PublishPlanPayload = z.object({ fastPathBriefId: uuid.optional() });
export const PublishExecutePayload = z.object({ postId: uuid });
export const PublishVerifyPayload = z.object({ postId: uuid });
export const EngageScanPayload = z.object({ postId: uuid.optional() });
export const EngageReplyPayload = z.object({ engagementId: uuid, text: z.string().optional() });
export const MetricsSnapshotPayload = z.object({ postId: uuid.optional() });
export const PlaybookUpdatePayload = z.object({ attributionReportKey: z.string().optional() });
export const AlertTelegramPayload = z.object({
  key: z.string().optional(), // dedupe key (≤1/hour per key, doc 08 §9)
  text: z.string(),
});

export const QueuePayloadSchemas: Record<QueueName, z.ZodTypeAny> = {
  [Q.scoutReddit]: ScoutPayload,
  [Q.scoutYoutube]: ScoutPayload,
  [Q.scoutX]: ScoutPayload,
  [Q.scoutTiktok]: ScoutPayload,
  [Q.radarScore]: RadarScorePayload,
  [Q.radarCluster]: RadarClusterPayload,
  [Q.radarDigest]: EmptyPayload,
  [Q.factoryBrief]: FactoryBriefPayload,
  [Q.factoryScript]: FactoryScriptPayload,
  [Q.factoryTts]: FactoryAssetPayload,
  [Q.factoryVisuals]: FactoryAssetPayload,
  [Q.factoryCaptions]: FactoryAssetPayload,
  [Q.factoryRender]: FactoryRenderPayload,
  [Q.factoryCompliance]: FactoryCompliancePayload,
  [Q.clipIngestUrl]: ClipIngestUrlPayload,
  [Q.clipTranscribe]: ClipIngestPayload,
  [Q.clipAnalyze]: ClipIngestPayload,
  [Q.clipCut]: ClipCutPayload,
  [Q.clipPublish]: ClipPublishPayload,
  [Q.approvalRequest]: ApprovalRequestPayload,
  [Q.approvalRemind]: EmptyPayload,
  [Q.publishPlan]: PublishPlanPayload,
  [Q.publishExecute]: PublishExecutePayload,
  [Q.publishVerify]: PublishVerifyPayload,
  [Q.engageScan]: EngageScanPayload,
  [Q.engageReply]: EngageReplyPayload,
  [Q.metricsSnapshot]: MetricsSnapshotPayload,
  [Q.learnAttribute]: EmptyPayload,
  [Q.playbookUpdate]: PlaybookUpdatePayload,
  [Q.policyWatch]: EmptyPayload,
  [Q.costsRollup]: EmptyPayload,
  [Q.alertTelegram]: AlertTelegramPayload,
};

// Queue workers + cron schedules (doc 08 §3 subset live so far: radar + factory + alerts).
import {
  AlertTelegramPayload,
  ApprovalRequestPayload,
  ClipCutPayload,
  ClipIngestPayload,
  ClipIngestUrlPayload,
  ClipPublishPayload,
  EmptyPayload,
  EngageReplyPayload,
  EngageScanPayload,
  FactoryAssetPayload,
  FactoryBriefPayload,
  FactoryCompliancePayload,
  FactoryRenderPayload,
  FactoryScriptPayload,
  MetricsSnapshotPayload,
  makeLogger,
  type Platform,
  PlaybookUpdatePayload,
  PublishExecutePayload,
  PublishPlanPayload,
  PublishVerifyPayload,
  Q,
  RadarClusterPayload,
  RadarScorePayload,
  SCOUT_TICK_CRON,
  ScoutPayload,
} from "@ve/core";
import { getSetting, setSetting } from "@ve/db";
import { sendAlert } from "@ve/telegram";
import type PgBoss from "pg-boss";
import { approvalRemindHandler } from "./engines/approvals/remind";
import { approvalRequestHandler } from "./engines/approvals/request";
import { engageReplyHandler, engageScanHandler } from "./engines/distribution/engagement";
import { publishExecuteHandler, publishVerifyHandler } from "./engines/distribution/publish";
import { publishPlanHandler } from "./engines/distribution/scheduler";
import { captionsHandler, ttsHandler, visualsHandler } from "./engines/factory/assets";
import { clipPublishHandler } from "./engines/factory/clip-publish";
import {
  clipAnalyzeHandler,
  clipCutHandler,
  clipIngestUrlHandler,
  clipTranscribeHandler,
} from "./engines/factory/clips";
import { complianceHandler } from "./engines/factory/compliance";
import { renderHandler } from "./engines/factory/render";
import { scriptHandler } from "./engines/factory/scriptwriter";
import { attributionHandler } from "./engines/learning/attribution";
import { metricsSnapshotHandler } from "./engines/learning/metrics";
import { playbookUpdateHandler } from "./engines/learning/playbook";
import { costsRollupHandler } from "./engines/ops/costs-rollup";
import { policyWatchHandler } from "./engines/ops/policy-watch";
import { clusterHandler } from "./engines/radar/cluster";
import { digestHandler } from "./engines/radar/digest";
import { editorTick } from "./engines/radar/editor";
import { scoreHandler } from "./engines/radar/score";
import { SCOUT_QUEUE_BY_PLATFORM, scoutSource, scoutTick } from "./engines/radar/scouts";
import { registerWorker } from "./harness";

const log = makeLogger("workers");

const IST = "Asia/Kolkata";

/** alert.telegram consumer (doc 08 §9): dedupe same key ≤1/hour, then send. */
export async function alertHandler(data: {
  key?: string | undefined;
  text: string;
}): Promise<void> {
  const key = data.key ?? `h:${Bun.hash(data.text).toString(36)}`;
  const settingKey = `alert_sent:${key}`;
  const last = await getSetting<string>(settingKey);
  if (last && Date.now() - new Date(last).getTime() < 3_600_000) {
    log.debug({ key }, "alert deduped (<1h)");
    return;
  }
  await sendAlert(data.text);
  await setSetting(settingKey, new Date().toISOString());
}

export async function registerAllWorkers(boss: PgBoss): Promise<void> {
  // scouts — sourceId absent means "tick": fan out due sources for the platform (doc 04 §1)
  for (const platform of Object.keys(SCOUT_QUEUE_BY_PLATFORM) as Platform[]) {
    await registerWorker(boss, SCOUT_QUEUE_BY_PLATFORM[platform], ScoutPayload, async (data) => {
      if (data.sourceId) await scoutSource(data.sourceId, boss);
      else await scoutTick(platform, boss);
    });
  }

  await registerWorker(boss, Q.radarScore, RadarScorePayload, async (data) => {
    await scoreHandler(data, boss);
  });
  await registerWorker(boss, Q.radarCluster, RadarClusterPayload, async (data) => {
    await clusterHandler(data);
  });
  await registerWorker(boss, Q.factoryBrief, FactoryBriefPayload, async () => {
    await editorTick(boss);
  });
  await registerWorker(boss, Q.radarDigest, EmptyPayload, async () => {
    await digestHandler();
  });
  await registerWorker(boss, Q.alertTelegram, AlertTelegramPayload, alertHandler);

  // ── factory engine (doc 05) ──────────────────────────────────────
  await registerWorker(boss, Q.factoryScript, FactoryScriptPayload, async (data) => {
    await scriptHandler(data, boss);
  });
  await registerWorker(boss, Q.factoryCompliance, FactoryCompliancePayload, async (data) => {
    await complianceHandler(data, boss);
  });
  await registerWorker(boss, Q.factoryTts, FactoryAssetPayload, async (data) => {
    await ttsHandler(data, boss);
  });
  await registerWorker(boss, Q.factoryVisuals, FactoryAssetPayload, async (data) => {
    await visualsHandler(data, boss);
  });
  await registerWorker(boss, Q.factoryCaptions, FactoryAssetPayload, async (data) => {
    await captionsHandler(data, boss);
  });
  await registerWorker(boss, Q.factoryRender, FactoryRenderPayload, async (data) => {
    await renderHandler(data, boss);
  });
  await registerWorker(boss, Q.clipIngestUrl, ClipIngestUrlPayload, async (data) => {
    await clipIngestUrlHandler(data, boss);
  });
  await registerWorker(boss, Q.clipTranscribe, ClipIngestPayload, async (data) => {
    await clipTranscribeHandler(data, boss);
  });
  await registerWorker(boss, Q.clipAnalyze, ClipIngestPayload, async (data) => {
    await clipAnalyzeHandler(data, boss);
  });
  await registerWorker(boss, Q.clipCut, ClipCutPayload, async (data) => {
    await clipCutHandler(data, boss);
  });
  await registerWorker(boss, Q.clipPublish, ClipPublishPayload, async (data) => {
    await clipPublishHandler(data, boss);
  });

  // ── approvals bridge (doc 09 §1 worker) ──────────────────────────
  await registerWorker(boss, Q.approvalRequest, ApprovalRequestPayload, async (data) => {
    await approvalRequestHandler(data, boss);
  });

  // ── distribution engine (doc 06) ─────────────────────────────────
  await registerWorker(boss, Q.publishPlan, PublishPlanPayload, async (data) => {
    await publishPlanHandler(data, boss);
  });
  await registerWorker(boss, Q.publishExecute, PublishExecutePayload, async (data) => {
    await publishExecuteHandler(data, boss);
  });
  await registerWorker(boss, Q.publishVerify, PublishVerifyPayload, async (data) => {
    await publishVerifyHandler(data, boss);
  });
  await registerWorker(boss, Q.engageScan, EngageScanPayload, async (data) => {
    await engageScanHandler(data, boss);
  });
  await registerWorker(boss, Q.engageReply, EngageReplyPayload, async (data) => {
    await engageReplyHandler(data);
  });

  // ── learning engine (doc 07) ─────────────────────────────────────
  await registerWorker(boss, Q.metricsSnapshot, MetricsSnapshotPayload, async (data) => {
    await metricsSnapshotHandler(data, boss);
  });
  await registerWorker(boss, Q.learnAttribute, EmptyPayload, async () => {
    await attributionHandler({}, boss);
  });
  await registerWorker(boss, Q.playbookUpdate, PlaybookUpdatePayload, async (data) => {
    await playbookUpdateHandler(data, boss);
  });

  // ── ops / safety rails (doc 08 §7/§8, §3 approval.remind) ─────────
  await registerWorker(boss, Q.costsRollup, EmptyPayload, async () => {
    await costsRollupHandler(boss);
  });
  await registerWorker(boss, Q.policyWatch, EmptyPayload, async () => {
    await policyWatchHandler(boss);
  });
  await registerWorker(boss, Q.approvalRemind, EmptyPayload, async () => {
    await approvalRemindHandler({}, boss);
  });
}

/** Cron table (doc 08 §3 — radar rows). pg-boss upserts one schedule per queue. */
export async function registerSchedules(boss: PgBoss): Promise<void> {
  for (const queue of Object.values(SCOUT_QUEUE_BY_PLATFORM)) {
    await boss.schedule(queue, SCOUT_TICK_CRON, {}, { tz: IST });
  }
  await boss.schedule(Q.radarCluster, "7,37 * * * *", { maintenance: true }, { tz: IST });
  await boss.schedule(Q.factoryBrief, "0 * * * *", {}, { tz: IST });
  await boss.schedule(Q.approvalRemind, "30 * * * *", {}, { tz: IST });
  await boss.schedule(Q.radarDigest, "0 8,20 * * *", {}, { tz: IST });
  // distribution + learning crons (doc 08 §3)
  await boss.schedule(Q.publishPlan, "30 0 * * *", {}, { tz: IST });
  await boss.schedule(Q.engageScan, "*/20 * * * *", {}, { tz: IST });
  await boss.schedule(Q.metricsSnapshot, "0 6 * * *", {}, { tz: IST });
  await boss.schedule(Q.costsRollup, "0 5 * * *", {}, { tz: IST });
  await boss.schedule(Q.learnAttribute, "0 7 * * 1", {}, { tz: IST });
  await boss.schedule(Q.policyWatch, "0 9 1 * *", {}, { tz: IST });
  log.info("cron schedules registered (radar + distribution + learning + ops)");
}

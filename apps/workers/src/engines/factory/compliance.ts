// factory.compliance (doc 05 §2) — the blocking gate, run twice (pre_render, pre_publish).
// Any fail → brief blocked + alert with the failing detail. Pass at pre_render →
// asset fan-out (or straight to pre_publish for text-only formats); pass at
// pre_publish → approval.request.
import {
  AMBER_ALLOWED_FORMATS,
  BANNED_CLAIM_PATTERNS,
  briefAssetsDoneKey,
  CAPTION_LIMITS,
  type ComplianceChecksResults,
  type ComplianceStage,
  FORMATS,
  type FormatSlug,
  licenseRefAllowed,
  makeLogger,
  newId,
  type PerPlatformCaptions,
  type Platform,
  POLITICS_TIKTOK_PATTERNS,
  Q,
} from "@ve/core";
import {
  and,
  assets,
  briefs,
  campaigns,
  categories,
  complianceChecks,
  db,
  desc,
  eq,
  inArray,
  posts,
  scripts,
  setSetting,
  transitionBrief,
  trends,
} from "@ve/db";
import { type Enqueuer, enqueueAlert } from "../../harness";

const log = makeLogger("factory-compliance");

type CheckResult = ComplianceChecksResults[number];

interface ComplianceContext {
  stage: ComplianceStage;
  brief: typeof briefs.$inferSelect;
  category: typeof categories.$inferSelect;
  trend: typeof trends.$inferSelect | null;
  script: typeof scripts.$inferSelect | null;
  briefAssets: (typeof assets.$inferSelect)[];
  /** campaign ids referenced by the assets that are still active (rights check, M9). */
  activeCampaignIds: Set<string>;
}

/** rights (both stages): licenseRefs allowed, trend ≠ red, amber ⇒ commentary format. */
export function checkRights(ctx: ComplianceContext): CheckResult {
  for (const a of ctx.briefAssets) {
    if (!licenseRefAllowed(a.licenseRef)) {
      return {
        check: "rights",
        pass: false,
        detail: `asset ${a.id} has disallowed licenseRef ${a.licenseRef ?? "(none)"}`,
      };
    }
    // a campaign licenseRef only licenses the footage while that campaign is active (doc 05 §2) —
    // a paused/ended or unknown campaign is not a valid license to publish its clips (M9)
    if (a.licenseRef?.startsWith("campaign:")) {
      const campaignId = a.licenseRef.slice("campaign:".length);
      if (!ctx.activeCampaignIds.has(campaignId)) {
        return {
          check: "rights",
          pass: false,
          detail: `asset ${a.id} references campaign ${campaignId}, which is not active`,
        };
      }
    }
  }
  if (ctx.trend?.rightsClass === "red") {
    return { check: "rights", pass: false, detail: "trend rights class is red" };
  }
  if (
    ctx.trend?.rightsClass === "amber" &&
    !(AMBER_ALLOWED_FORMATS as readonly string[]).includes(ctx.brief.formatSlug)
  ) {
    return {
      check: "rights",
      pass: false,
      detail: `amber trend requires commentary format, got ${ctx.brief.formatSlug}`,
    };
  }
  return { check: "rights", pass: true };
}

/** similarity (pre_render): the stored report must pass (doc 05 §1). */
export function checkSimilarity(ctx: ComplianceContext): CheckResult {
  const report = ctx.script?.similarityReport as { pass?: boolean } | null;
  if (report?.pass !== true) {
    return { check: "similarity", pass: false, detail: "similarityReport missing or failed" };
  }
  return { check: "similarity", pass: true };
}

/** music (both): zero third-party audio, full stop — v1 has no music beds. */
export function checkMusic(ctx: ComplianceContext): CheckResult {
  for (const a of ctx.briefAssets) {
    const meta = a.meta as { music?: boolean } | null;
    if (a.kind === "tts_audio" && meta?.music === true) {
      return { check: "music", pass: false, detail: `asset ${a.id} carries a music bed` };
    }
  }
  return { check: "music", pass: true };
}

/**
 * ai_disclosure (pre_publish): an AI-generated VISUAL ⇒ script.aiDisclosure must be true so the
 * platform AI flags get set at publish (doc 00 §1, doc 05 §2). Synthetic TTS narration is labelled
 * ai-gen:tts for cost/rights tracking but is faceless and does NOT by itself require disclosure —
 * gating on it would block every video at the last gate after full spend (the scriptwriter, per its
 * own prompt, legitimately sets aiDisclosure=false for stock-visual shorts).
 */
export function checkAiDisclosure(ctx: ComplianceContext): CheckResult {
  const hasAiVisual = ctx.briefAssets.some(
    (a) => a.kind !== "tts_audio" && a.licenseRef?.startsWith("ai-gen:"),
  );
  if (hasAiVisual && ctx.script?.aiDisclosure !== true) {
    return {
      check: "ai_disclosure",
      pass: false,
      detail: "ai-generated visual present but script.aiDisclosure is false",
    };
  }
  return {
    check: "ai_disclosure",
    pass: true,
    detail: ctx.script?.aiDisclosure ? "platform AI flags will be set at publish" : "no AI visuals",
  };
}

/** category_rules (both): radar_only ⇒ hard fail; human_gated noted (no auto-approve). */
export function checkCategoryRules(ctx: ComplianceContext): CheckResult {
  if (ctx.category.mode === "radar_only") {
    return {
      check: "category_rules",
      pass: false,
      detail: `category ${ctx.category.slug} is radar_only — publishing disabled`,
    };
  }
  return {
    check: "category_rules",
    pass: true,
    detail: ctx.category.mode === "human_gated" ? "human approval required, never auto" : undefined,
  };
}

/** platform_policy (pre_publish): caption lint (doc 05 §2). */
export function checkPlatformPolicy(ctx: ComplianceContext): CheckResult {
  const captions = (ctx.script?.perPlatformCaptions ?? {}) as PerPlatformCaptions;
  const texts: string[] = [ctx.script?.body ?? ""];
  if (captions.tiktok) texts.push(captions.tiktok.caption, ...captions.tiktok.hashtags);
  if (captions.youtube)
    texts.push(captions.youtube.title, captions.youtube.description, ...captions.youtube.tags);
  if (captions.x) texts.push(captions.x.text);
  if (captions.reddit) texts.push(captions.reddit.title, captions.reddit.body);
  const joined = texts.join("\n");

  for (const pattern of BANNED_CLAIM_PATTERNS) {
    if (pattern.test(joined)) {
      return { check: "platform_policy", pass: false, detail: `banned claim matched: ${pattern}` };
    }
  }
  const targets = ctx.brief.targetPlatforms as Platform[];
  if (ctx.category.slug === "politics" && targets.includes("tiktok")) {
    for (const pattern of POLITICS_TIKTOK_PATTERNS) {
      if (pattern.test(joined)) {
        return {
          check: "platform_policy",
          pass: false,
          detail: `politics on tiktok: call-to-vote phrasing matched ${pattern}`,
        };
      }
    }
  }
  if ((captions.tiktok?.hashtags.length ?? 0) > CAPTION_LIMITS.tiktokHashtagsMax) {
    return { check: "platform_policy", pass: false, detail: "tiktok hashtags > 5" };
  }
  if ((captions.youtube?.title.length ?? 0) > CAPTION_LIMITS.youtubeTitleMax) {
    return { check: "platform_policy", pass: false, detail: "youtube title > 90 chars" };
  }
  return { check: "platform_policy", pass: true };
}

export function runChecks(ctx: ComplianceContext): ComplianceChecksResults {
  const results: ComplianceChecksResults = [];
  results.push(checkRights(ctx));
  if (ctx.stage === "pre_render") results.push(checkSimilarity(ctx));
  results.push(checkMusic(ctx));
  if (ctx.stage === "pre_publish") results.push(checkAiDisclosure(ctx));
  results.push(checkCategoryRules(ctx));
  if (ctx.stage === "pre_publish") results.push(checkPlatformPolicy(ctx));
  return results;
}

/** Create draft posts rows per target platform, idempotently (doc 05 §4). */
async function createPostsDrafts(
  brief: typeof briefs.$inferSelect,
  renderIdByPlatform: Map<string, string>,
): Promise<number> {
  const format = FORMATS[brief.formatSlug as FormatSlug];
  const platforms = (brief.targetPlatforms as Platform[]).filter((p) =>
    (format.platforms as readonly Platform[]).includes(p),
  );
  const existing = await db
    .select({ platform: posts.platform })
    .from(posts)
    .where(eq(posts.briefId, brief.id));
  const have = new Set(existing.map((p) => p.platform));
  let created = 0;
  for (const platform of platforms) {
    if (have.has(platform)) continue;
    await db.insert(posts).values({
      id: newId(),
      briefId: brief.id,
      renderId: renderIdByPlatform.get(platform) ?? null,
      categoryId: brief.categoryId,
      platform,
      status: "draft",
    });
    created++;
  }
  return created;
}

export async function complianceHandler(
  payload: { briefId: string; stage: ComplianceStage },
  boss: Enqueuer,
): Promise<{ pass: boolean; results: ComplianceChecksResults }> {
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, payload.briefId)).limit(1);
  if (!brief) throw new Error(`compliance: brief ${payload.briefId} missing`);
  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, brief.categoryId))
    .limit(1);
  if (!category) throw new Error(`compliance: category missing for brief ${brief.id}`);
  const trend = brief.trendId
    ? ((await db.select().from(trends).where(eq(trends.id, brief.trendId)).limit(1))[0] ?? null)
    : null;
  const [script] = await db
    .select()
    .from(scripts)
    .where(eq(scripts.briefId, brief.id))
    .orderBy(desc(scripts.version))
    .limit(1);
  const briefAssets = await db.select().from(assets).where(eq(assets.briefId, brief.id));

  // which campaigns referenced by these assets are still active (rights check, M9)
  const campaignIds = [
    ...new Set(
      briefAssets
        .map((a) => a.licenseRef)
        .filter((r): r is string => !!r && r.startsWith("campaign:"))
        .map((r) => r.slice("campaign:".length)),
    ),
  ];
  const activeCampaignIds = new Set<string>();
  if (campaignIds.length > 0) {
    const active = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(inArray(campaigns.id, campaignIds), eq(campaigns.active, true)));
    for (const r of active) activeCampaignIds.add(r.id);
  }

  const ctx: ComplianceContext = {
    stage: payload.stage,
    brief,
    category,
    trend,
    script: script ?? null,
    briefAssets,
    activeCampaignIds,
  };
  const results = runChecks(ctx);
  const pass = results.every((r) => r.pass);

  await db.insert(complianceChecks).values({
    id: newId(),
    briefId: brief.id,
    stage: payload.stage,
    pass,
    results,
  });

  if (!pass) {
    const failing = results.find((r) => !r.pass);
    if (brief.status !== "blocked") {
      await transitionBrief(db, brief.id, "blocked", {
        blockedReason: failing?.check ?? "compliance",
      });
    }
    // doc 09 §5: a pre_publish compliance failure revokes any earned auto-approval for the pair
    if (payload.stage === "pre_publish") {
      const earned = (category.autoApproveFormats ?? []) as string[];
      if (earned.includes(brief.formatSlug)) {
        await db
          .update(categories)
          .set({
            autoApproveFormats: earned.filter((f) => f !== brief.formatSlug),
            updatedAt: new Date(),
          })
          .where(eq(categories.id, category.id));
        await enqueueAlert(
          boss,
          `🛑 auto-approve revoked (compliance fail) | ${category.slug} · ${brief.formatSlug}`,
          `autoapprove-revoke:${category.slug}:${brief.formatSlug}`,
        );
      }
    }
    await enqueueAlert(
      boss,
      `🚫 compliance ${payload.stage} failed | brief:${brief.id} | ${failing?.check}: ${failing?.detail ?? ""}`,
      `compliance:${brief.id}:${payload.stage}`,
    );
    log.warn({ briefId: brief.id, stage: payload.stage, failing }, "compliance blocked");
    return { pass, results };
  }

  const format = FORMATS[brief.formatSlug as FormatSlug];
  if (payload.stage === "pre_render") {
    if (brief.status === "scripted") await transitionBrief(db, brief.id, "producing");
    if (format.render === "text-only") {
      // no assets/renders for text formats (doc 05 §4) — drafts now, straight to pre_publish
      await createPostsDrafts(brief, new Map());
      await boss.send(Q.factoryCompliance, { briefId: brief.id, stage: "pre_publish" });
    } else if (format.render === "clip-captions") {
      // clip briefs cut the source directly — no tts/visuals/captions assets (doc 05 §5)
      await boss.send(Q.factoryRender, { briefId: brief.id }, { singletonKey: brief.id });
    } else if (!script) {
      throw new Error(`compliance: no script for renderable brief ${brief.id}`);
    } else {
      // asset fan-out (doc 05 §3): tts + visuals now; captions chases the tts audio.
      // Completion tracked by the deterministic settings counter.
      await setSetting(briefAssetsDoneKey(brief.id), {
        tts: false,
        visuals: false,
        captions: false,
      });
      await boss.send(Q.factoryTts, { briefId: brief.id, scriptId: script.id });
      await boss.send(Q.factoryVisuals, { briefId: brief.id, scriptId: script.id });
    }
  } else {
    // pre_publish pass → human approval (doc 05 §2); brief is fully ready
    if (brief.status === "producing") await transitionBrief(db, brief.id, "ready");
    await boss.send(Q.approvalRequest, { briefId: brief.id });
  }
  log.info({ briefId: brief.id, stage: payload.stage }, "compliance passed");
  return { pass, results };
}

export { createPostsDrafts };

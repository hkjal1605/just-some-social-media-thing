// factory.script (doc 05 §1): brief → original script. The Scriptwriter sees the
// trend's IDEA (headline/summary/why-viral) — never member source texts. The
// similarity guard then compares its output against those sources in code; one
// automatic rewrite with feedback, second fail → brief blocked + alert.
import {
  briefAssetsDoneKey,
  ClipScriptDataSchema,
  FORMATS,
  type FormatSlug,
  makeLogger,
  newId,
  Q,
  type ScriptOut,
  ScriptOutSchema,
} from "@ve/core";
import {
  and,
  assets,
  briefs,
  categories,
  clipCandidates,
  db,
  desc,
  eq,
  playbookVersions,
  posts,
  rawItems,
  renders,
  scripts,
  settings,
  sql,
  transitionBrief,
  trends,
} from "@ve/db";
import { SCRIPTWRITER_SYSTEM, scriptwriterUser } from "@ve/llm";
import { type Enqueuer, enqueueAlert } from "../../harness";
import { factoryDeps } from "./deps";
import { type MemberForGuard, similarityReport } from "./similarity";

const log = makeLogger("factory-script");

async function loadMembersForGuard(trendId: string): Promise<MemberForGuard[]> {
  const rows = await db
    .select({
      id: rawItems.id,
      title: rawItems.title,
      text: rawItems.text,
      embedding: rawItems.embedding,
    })
    .from(rawItems)
    .where(eq(rawItems.trendId, trendId));
  return rows.map((r) => ({
    rawItemId: r.id,
    text: `${r.title ?? ""} ${r.text ?? ""}`.slice(0, 600).trim(),
    embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : null,
  }));
}

export async function scriptHandler(
  payload: { briefId: string; editInstructions?: string | undefined },
  boss: Enqueuer,
): Promise<{ scriptId: string | null; blocked: boolean }> {
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, payload.briefId)).limit(1);
  if (!brief) {
    log.warn({ briefId: payload.briefId }, "script skipped: brief missing");
    return { scriptId: null, blocked: false };
  }
  if (!["draft", "scripted", "ready"].includes(brief.status)) {
    log.warn({ briefId: brief.id, status: brief.status }, "script skipped: brief not scriptable");
    return { scriptId: null, blocked: false };
  }

  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, brief.categoryId))
    .limit(1);
  if (!category) throw new Error(`brief ${brief.id} has no category`);

  const trend = brief.trendId
    ? (await db.select().from(trends).where(eq(trends.id, brief.trendId)).limit(1))[0]
    : undefined;

  const [playbook] = await db
    .select()
    .from(playbookVersions)
    .where(and(eq(playbookVersions.categoryId, category.id), sql`approved_at is not null`))
    .orderBy(desc(playbookVersions.version))
    .limit(1);

  const formatSlug = brief.formatSlug as FormatSlug;
  const format = FORMATS[formatSlug];
  const isClipBrief = brief.originKind !== "trend";

  // idempotency (doc 08 §11): skip if a script already exists for this brief state —
  // an explicit edit request always writes a new version
  const [latest] = await db
    .select()
    .from(scripts)
    .where(eq(scripts.briefId, brief.id))
    .orderBy(desc(scripts.version))
    .limit(1);
  if (latest && !payload.editInstructions) {
    log.info({ briefId: brief.id, version: latest.version }, "script exists — skipping");
    return { scriptId: latest.id, blocked: false };
  }
  const nextVersion = (latest?.version ?? 0) + 1;

  const members = brief.trendId ? await loadMembersForGuard(brief.trendId) : [];

  // clip briefs: the merged Gemini analyze call already wrote this moment's copy (hooks + captions)
  // onto the candidate. Reuse it — no scriptwriter call — except for edits or legacy candidates,
  // which fall through to the scriptwriter loop below (doc 05 §5).
  const [clipCand] = isClipBrief
    ? await db.select().from(clipCandidates).where(eq(clipCandidates.briefId, brief.id)).limit(1)
    : [undefined];
  const merged =
    isClipBrief && clipCand?.scriptData && !payload.editInstructions
      ? ClipScriptDataSchema.safeParse(clipCand.scriptData)
      : null;

  let out: ScriptOut | null = null;
  let report: ReturnType<typeof similarityReport> | null = null;

  if (merged?.success) {
    out = {
      hookVariants: merged.data.hookVariants,
      body: clipCand?.transcriptSlice ?? "",
      sceneCount: 1,
      sceneVisuals: [],
      estDurationSec: Math.max(1, Number(clipCand?.endSec ?? 0) - Number(clipCand?.startSec ?? 0)),
      perPlatformCaptions: merged.data.perPlatformCaptions,
      aiDisclosure: false, // clips are real footage, not AI-generated
    };
    report = { maxCosine: 0, maxNgramOverlap: 0, vsRawItemId: null, pass: true };
  } else {
    let rewriteFeedback: string | undefined;
    const attempts = isClipBrief ? 1 : 2; // clip briefs skip the guard (we own the content)
    for (let attempt = 0; attempt < attempts; attempt++) {
      out = await factoryDeps.runStructured({
        agent: "scriptwriter",
        system: SCRIPTWRITER_SYSTEM,
        user: scriptwriterUser({
          categorySlug: category.slug,
          angle: brief.angle,
          formatSlug,
          durationRange: format.durationSec,
          targetPlatforms: brief.targetPlatforms as string[],
          trend: trend
            ? { headline: trend.headline, summary: trend.summary, whyViral: undefined }
            : null,
          playbookMarkdown: playbook?.markdown ?? "",
          editInstructions: payload.editInstructions,
          rewriteFeedback,
        }),
        schema: ScriptOutSchema,
        entity: { kind: "brief", id: brief.id },
      });

      if (isClipBrief || members.length === 0) {
        // similarity guard skipped: own/licensed content, or nothing to compare against
        report = { maxCosine: 0, maxNgramOverlap: 0, vsRawItemId: null, pass: true };
        break;
      }

      const [bodyEmbedding] = await factoryDeps.embed([out.body.slice(0, 2000)]);
      report = similarityReport(bodyEmbedding ?? [], out.body, members);
      if (report.pass) break;

      rewriteFeedback =
        `Previous draft failed: maxCosine=${report.maxCosine} (limit 0.86), ` +
        `ngramOverlap=${report.maxNgramOverlap} (limit 0.25) vs source ${report.vsRawItemId}.`;
      log.warn({ briefId: brief.id, attempt, report }, "similarity guard failed");
    }
  }

  if (!out || !report) throw new Error(`scriptwriter produced no output for brief ${brief.id}`);

  // clip briefs: body = the candidate's transcriptSlice — we own/are licensed for those words
  let body = out.body;
  if (isClipBrief && clipCand?.transcriptSlice) body = clipCand.transcriptSlice;

  const scriptId = newId();
  await db.insert(scripts).values({
    id: scriptId,
    briefId: brief.id,
    version: nextVersion,
    hookVariants: out.hookVariants,
    body,
    sceneCount: out.sceneCount,
    estDurationSec: Math.round(out.estDurationSec),
    perPlatformCaptions: out.perPlatformCaptions,
    sceneVisuals: out.sceneVisuals,
    similarityReport: report, // stored either way (doc 05 §1)
    aiDisclosure: out.aiDisclosure,
  });

  if (!report.pass) {
    await transitionBrief(db, brief.id, "blocked", { blockedReason: "similarity" });
    await enqueueAlert(
      boss,
      `✍️ scriptwriter blocked | brief:${brief.id} | similarity guard failed twice (cosine ${report.maxCosine}, ngram ${report.maxNgramOverlap})`,
      `similarity:${brief.id}`,
    );
    return { scriptId, blocked: true };
  }

  // edit re-script (v2+): the asset/render idempotency guards are keyed by brief, so unless we clear
  // v1's artifacts the fan-out reuses the old audio/captions/render and the reviewer's requested
  // change never reaches the published video. Drop them so the pipeline regenerates from v2 (H4a).
  if (nextVersion > 1) {
    await clearBriefArtifacts(brief.id);
  }

  if (brief.status !== "scripted") {
    await transitionBrief(db, brief.id, "scripted");
  }
  await boss.send(Q.factoryCompliance, { briefId: brief.id, stage: "pre_render" });
  log.info({ briefId: brief.id, scriptId, version: nextVersion }, "script written");
  return { scriptId, blocked: false };
}

/**
 * Delete a brief's produced artifacts so an edit re-script regenerates them (H4a). In the edit flow
 * every post is still 'draft' (never published), so this is safe; FK order is posts → renders →
 * assets, then the asset-done counter. post_snapshots/engagements cascade on the post delete.
 */
async function clearBriefArtifacts(briefId: string): Promise<void> {
  await db.delete(posts).where(eq(posts.briefId, briefId));
  await db.delete(renders).where(eq(renders.briefId, briefId));
  await db.delete(assets).where(eq(assets.briefId, briefId));
  await db.delete(settings).where(eq(settings.key, briefAssetsDoneKey(briefId)));
}

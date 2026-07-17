// policy.watch (doc 08 §8, monthly): the system watching the rules that govern it.
// For each policy_pages row: fetch → strip to text → sha256. Hash changed vs last run →
// hand the old + new extracts to the policy-differ agent → store lastDiffSummary + TG alert.
// Blocked fetches are marked and rolled into one summary alert. The extracted text is kept in
// R2 so the next run can diff old vs new (the table only stores the hash).
import { createHash } from "node:crypto";
import { makeLogger, POLICY_EXTRACT_MAX_CHARS, PolicyDiffSchema } from "@ve/core";
import { db, eq, policyPages } from "@ve/db";
import { POLICY_DIFFER_SYSTEM, policyDifferUser } from "@ve/llm";
import { getObjectBytes, putObject, r2Key } from "@ve/storage";
import { type Enqueuer, enqueueAlert } from "../../harness";
import { opsDeps } from "./deps";

const log = makeLogger("ops-policy-watch");

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

/** Strip scripts/styles/comments/tags and collapse whitespace to comparable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Each extract handed to the differ is capped (doc 08 §8). */
export function extractForDiff(text: string, max = POLICY_EXTRACT_MAX_CHARS): string {
  return text.slice(0, max);
}

// ── handler ─────────────────────────────────────────────────────────────────

export type PolicyPageStatus = "unchanged" | "changed" | "cosmetic" | "baseline" | "blocked";

export interface PolicyPageResult {
  id: string;
  name: string;
  status: PolicyPageStatus;
  summary?: string;
}

type PolicyRow = typeof policyPages.$inferSelect;

export async function checkPolicyPage(
  page: PolicyRow,
  boss: Enqueuer,
  deps = opsDeps,
): Promise<PolicyPageResult> {
  const now = new Date();
  const fetched = await deps.fetchPolicy(page.url);

  if (!fetched.ok || fetched.text.length === 0) {
    await db
      .update(policyPages)
      .set({ lastCheckedAt: now, lastDiffSummary: `⛔ fetch_blocked (status ${fetched.status})` })
      .where(eq(policyPages.id, page.id));
    log.warn({ page: page.name, status: fetched.status }, "policy fetch blocked");
    return { id: page.id, name: page.name, status: "blocked", summary: `status ${fetched.status}` };
  }

  const text = htmlToText(fetched.text);
  const hash = sha256Hex(text);
  const snapKey = r2Key.policySnapshot(page.id);

  // first sighting: capture baseline snapshot + hash, no alert (nothing to diff against yet)
  if (!page.lastHash) {
    await putObject(snapKey, new TextEncoder().encode(text), "text/plain");
    await db
      .update(policyPages)
      .set({ lastHash: hash, lastCheckedAt: now })
      .where(eq(policyPages.id, page.id));
    return { id: page.id, name: page.name, status: "baseline" };
  }

  if (hash === page.lastHash) {
    await db.update(policyPages).set({ lastCheckedAt: now }).where(eq(policyPages.id, page.id));
    return { id: page.id, name: page.name, status: "unchanged" };
  }

  // hash changed → diff previous vs current with the policy-differ agent
  let previousText = "";
  try {
    previousText = new TextDecoder().decode(await getObjectBytes(snapKey));
  } catch {
    previousText = ""; // snapshot missing (older row) — differ sees "(none on file)"
  }
  const diff = await deps.runStructured({
    agent: "policy-differ",
    system: POLICY_DIFFER_SYSTEM,
    user: policyDifferUser({
      name: page.name,
      url: page.url,
      previousText: extractForDiff(previousText),
      currentText: extractForDiff(text),
    }),
    schema: PolicyDiffSchema,
    maxTokens: 1024,
    entity: { kind: "policy_page", id: page.id },
  });

  // persist the new snapshot + hash regardless of materiality (so we don't re-diff the same text)
  await putObject(snapKey, new TextEncoder().encode(text), "text/plain");
  await db
    .update(policyPages)
    .set({
      lastHash: hash,
      lastCheckedAt: now,
      lastChangedAt: now,
      lastDiffSummary: diff.summary,
    })
    .where(eq(policyPages.id, page.id));

  if (diff.hasMaterialChange) {
    await enqueueAlert(
      boss,
      `⚠️ ${page.name} changed: ${diff.summary}${diff.impact ? ` — impact: ${diff.impact}` : ""}`.slice(
        0,
        900,
      ),
      `policy-change:${page.id}`,
    );
    log.warn({ page: page.name }, "material policy change detected");
    return { id: page.id, name: page.name, status: "changed", summary: diff.summary };
  }
  return { id: page.id, name: page.name, status: "cosmetic", summary: diff.summary };
}

export interface PolicyWatchResult {
  checked: number;
  changed: number;
  cosmetic: number;
  baseline: number;
  blocked: number;
  results: PolicyPageResult[];
}

export async function policyWatchHandler(
  boss: Enqueuer,
  deps = opsDeps,
): Promise<PolicyWatchResult> {
  const pages = await db.select().from(policyPages);
  const results: PolicyPageResult[] = [];
  for (const page of pages) {
    try {
      results.push(await checkPolicyPage(page, boss, deps));
    } catch (err) {
      // one page's differ/storage failure shouldn't abort the sweep
      log.error({ err, page: page.name }, "policy page check failed");
      results.push({
        id: page.id,
        name: page.name,
        status: "blocked",
        summary: String(err).slice(0, 120),
      });
    }
  }

  const blocked = results.filter((r) => r.status === "blocked");
  if (blocked.length > 0) {
    await enqueueAlert(
      boss,
      `⛔ policy.watch: ${blocked.length}/${pages.length} page(s) fetch_blocked — ${blocked
        .map((b) => b.name)
        .join(", ")
        .slice(0, 400)}`,
      "policy-watch-blocked",
    );
  }

  const summary: PolicyWatchResult = {
    checked: results.length,
    changed: results.filter((r) => r.status === "changed").length,
    cosmetic: results.filter((r) => r.status === "cosmetic").length,
    baseline: results.filter((r) => r.status === "baseline").length,
    blocked: blocked.length,
    results,
  };
  log.info(
    { checked: summary.checked, changed: summary.changed, blocked: summary.blocked },
    "policy.watch complete",
  );
  return summary;
}

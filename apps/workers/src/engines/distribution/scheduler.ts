// publish.plan (doc 06 §4): fill qualified slots for approved posts. Runs daily at
// 00:30 IST and as an on-approval fast-path. The slot algorithm (planSchedule) is pure
// and unit-tested; the handler just gathers DB state, calls it, and writes results.
import {
  type CategoriesCadenceCaps,
  FAST_PATH_DELAY_MINUTES,
  istParts,
  istWallToUtc,
  MIN_SAME_PLATFORM_GAP_HOURS,
  makeLogger,
  type Platform,
  type PostingWindow,
  parseHhMm,
  Q,
  SCHEDULE_HORIZON_DAYS,
  type SettingsPostingWindows,
  SLOT_JITTER_MINUTES,
  WARMUP_DAILY_CAP,
  windowActiveOnDay,
} from "@ve/core";
import { categories, db, getSetting, sql, transitionPost } from "@ve/db";
import type { Enqueuer } from "../../harness";

const log = makeLogger("distribution-scheduler");

const GAP_MS = MIN_SAME_PLATFORM_GAP_HOURS * 3_600_000;

export interface PlanPost {
  postId: string;
  categoryId: string;
  platform: Platform;
  briefId: string;
  /** sort key: trend peakEstimateAt (ms) then brief age — smaller schedules first (doc 06 §4). */
  orderKey: number;
  longevity: string | null; // 'flash' trends get the fast-path
}

export interface PlanInput {
  now: Date;
  posts: PlanPost[];
  windows: SettingsPostingWindows;
  /** effective daily cap per (categoryId, platform) — already warm-up-adjusted. */
  capFor: (categoryId: string, platform: Platform) => number;
  /** existing scheduled/published times per lane `${categoryId}:${platform}` (gap + cap input). */
  existingByLane: Map<string, Date[]>;
  fastPathBriefId?: string | undefined;
  jitterFn?: (postId: string) => number; // minutes in [-SLOT_JITTER, +SLOT_JITTER]
  activeFlags?: Set<string>; // A/B window flags currently on (e.g. tiktok_weekend_am)
  /** platforms currently warming up → the whole account is capped at 1/day (doc 06 §7). */
  warmupPlatforms?: Set<string>;
  horizonDays?: number;
}

export interface PlanResult {
  postId: string;
  scheduledFor: Date;
  fastPath: boolean;
}

const laneKey = (categoryId: string, platform: string) => `${categoryId}:${platform}`;
const istDayKey = (d: Date) => {
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}`;
};

/** Append to a Map-of-arrays, creating the array on first use (no non-null assertions). */
function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** Deterministic ±SLOT_JITTER_MINUTES from the post id (repeatable across planner runs). */
export function defaultJitter(postId: string): number {
  const span = SLOT_JITTER_MINUTES * 2 + 1;
  return Number(BigInt(Bun.hash(postId)) % BigInt(span)) - SLOT_JITTER_MINUTES;
}

/** Candidate slot grid for one platform across the horizon: window start, +3h, … ≤ window end. */
export function windowSlots(
  windows: PostingWindow[],
  now: Date,
  horizonDays: number,
  activeFlags: Set<string>,
): Date[] {
  const slots: Date[] = [];
  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    const dayInstant = new Date(now.getTime() + dayOffset * 86_400_000);
    const { year, month, day, weekday } = istParts(dayInstant);
    for (const w of windows) {
      if (!windowActiveOnDay(w, weekday)) continue;
      if (w.flag && !activeFlags.has(w.flag)) continue;
      const s = parseHhMm(w.start);
      const e = parseHhMm(w.end);
      const startMs = istWallToUtc(year, month, day, s.hour, s.minute).getTime();
      const endMs = istWallToUtc(year, month, day, e.hour, e.minute).getTime();
      for (let t = startMs; t <= endMs; t += GAP_MS) slots.push(new Date(t));
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}

function respectsGap(candidate: Date, taken: Date[]): boolean {
  return taken.every((t) => Math.abs(candidate.getTime() - t.getTime()) >= GAP_MS);
}

/**
 * Assign a scheduledFor to each post respecting: per-lane daily cap, ≥3h same-lane gap,
 * ±jitter, and the flash-trend fast-path. Posts with no open slot in the horizon are left
 * out of the result (they retry on the next planner run). Pure — no I/O.
 */
export function planSchedule(input: PlanInput): PlanResult[] {
  const jitter = input.jitterFn ?? defaultJitter;
  const flags = input.activeFlags ?? new Set<string>();
  const horizon = input.horizonDays ?? SCHEDULE_HORIZON_DAYS;
  const results: PlanResult[] = [];

  // Two levels of accounting (doc 06 §7): the daily cap is per (category, platform) — each category
  // has its own budget — while the ≥3h gap is per PLATFORM, because there is one shared brand
  // account per platform and it must never bunch posts regardless of category. During warm-up the
  // whole account is additionally capped at 1/day per platform.
  const byLane = new Map<string, PlanPost[]>();
  for (const p of input.posts) pushInto(byLane, laneKey(p.categoryId, p.platform), p);

  const platformFromLane = (lane: string) => lane.slice(lane.indexOf(":") + 1);
  const warmup = input.warmupPlatforms ?? new Set<string>();
  const takenByPlatform = new Map<string, Date[]>(); // gap accounting (per platform)
  const dayCountByLane = new Map<string, Map<string, number>>(); // cap accounting (per lane)
  const warmupCountByPlatform = new Map<string, Map<string, number>>(); // warm-up total (per platform)
  const bump = (m: Map<string, Map<string, number>>, k: string, dk: string) => {
    const inner = m.get(k) ?? new Map<string, number>();
    if (!m.has(k)) m.set(k, inner);
    inner.set(dk, (inner.get(dk) ?? 0) + 1);
  };
  const takenFor = (platform: string) => {
    const a = takenByPlatform.get(platform) ?? [];
    if (!takenByPlatform.has(platform)) takenByPlatform.set(platform, a);
    return a;
  };
  for (const [lane, times] of input.existingByLane) {
    const platform = platformFromLane(lane);
    const taken = takenFor(platform);
    for (const t of times) {
      taken.push(t);
      const dk = istDayKey(t);
      bump(dayCountByLane, lane, dk);
      bump(warmupCountByPlatform, platform, dk);
    }
  }

  for (const [lane, lanePosts] of byLane) {
    lanePosts.sort((a, b) => a.orderKey - b.orderKey || a.postId.localeCompare(b.postId));
    const first = lanePosts[0];
    if (!first) continue;
    const { platform, categoryId } = first;
    const cap = input.capFor(categoryId, platform);
    const taken = takenFor(platform);
    const laneDay = dayCountByLane.get(lane) ?? new Map<string, number>();
    if (!dayCountByLane.has(lane)) dayCountByLane.set(lane, laneDay);
    const warmDay = warmupCountByPlatform.get(platform) ?? new Map<string, number>();
    if (!warmupCountByPlatform.has(platform)) warmupCountByPlatform.set(platform, warmDay);
    const grid = windowSlots(input.windows[platform], input.now, horizon, flags);

    // a day is full for this post if its lane hit the cap, or (warm-up) the account hit 1/day
    const dayFull = (dk: string) =>
      (laneDay.get(dk) ?? 0) >= cap ||
      (warmup.has(platform) && (warmDay.get(dk) ?? 0) >= WARMUP_DAILY_CAP);

    for (const post of lanePosts) {
      if (cap <= 0) continue;
      let assigned: { time: Date; fastPath: boolean } | null = null;

      // fast-path: flash trend on approval → now + 10 min if today has room + gap holds
      if (
        input.fastPathBriefId &&
        post.briefId === input.fastPathBriefId &&
        post.longevity === "flash"
      ) {
        const candidate = new Date(input.now.getTime() + FAST_PATH_DELAY_MINUTES * 60_000);
        if (!dayFull(istDayKey(candidate)) && respectsGap(candidate, taken)) {
          assigned = { time: candidate, fastPath: true };
        }
      }

      // normal: earliest grid slot with room + ≥3h same-platform gap (on the jittered time)
      if (!assigned) {
        for (const base of grid) {
          if (dayFull(istDayKey(base))) continue;
          const candidate = new Date(base.getTime() + jitter(post.postId) * 60_000);
          if (candidate.getTime() <= input.now.getTime()) continue;
          if (!respectsGap(candidate, taken)) continue;
          assigned = { time: candidate, fastPath: false };
          break;
        }
      }

      if (!assigned) continue; // no slot in horizon — retries next run
      taken.push(assigned.time);
      const dk = istDayKey(assigned.time);
      laneDay.set(dk, (laneDay.get(dk) ?? 0) + 1);
      warmDay.set(dk, (warmDay.get(dk) ?? 0) + 1);
      results.push({
        postId: post.postId,
        scheduledFor: assigned.time,
        fastPath: assigned.fastPath,
      });
    }
  }

  // cross-trend stagger (doc 06 §7): same brief across platforms ≥30 min apart, tiktok first.
  return staggerSameBrief(results, input.posts, takenByPlatform);
}

const STAGGER_MS = 30 * 60_000;
const PLATFORM_ORDER: Record<string, number> = { tiktok: 0, youtube: 1, x: 2, reddit: 3 };

/**
 * Push same-brief posts ≥30 min apart, preferring tiktok earliest (doc 06 §7). Best-effort — and
 * a stagger move is only applied when it keeps the ≥3h same-platform gap, so fixing a cross-platform
 * stagger can never introduce a same-platform gap violation (M6). `takenByPlatform` carries every
 * planned + pre-existing time per platform; omit it (e.g. in a unit test) to move unconditionally.
 */
export function staggerSameBrief(
  results: PlanResult[],
  allPosts: PlanPost[],
  takenByPlatform?: Map<string, Date[]>,
): PlanResult[] {
  const briefOf = new Map(allPosts.map((p) => [p.postId, p.briefId] as const));
  const platformOf = new Map(allPosts.map((p) => [p.postId, p.platform] as const));
  const byBrief = new Map<string, PlanResult[]>();
  for (const r of results) pushInto(byBrief, briefOf.get(r.postId) ?? "", r);
  const orderOf = (postId: string) => PLATFORM_ORDER[platformOf.get(postId) ?? ""] ?? 9;
  for (const group of byBrief.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) =>
        orderOf(a.postId) - orderOf(b.postId) ||
        a.scheduledFor.getTime() - b.scheduledFor.getTime(),
    );
    for (let i = 1; i < group.length; i++) {
      const prevItem = group[i - 1];
      const cur = group[i];
      if (!prevItem || !cur) continue;
      const prev = prevItem.scheduledFor.getTime();
      if (cur.scheduledFor.getTime() - prev >= STAGGER_MS) continue;
      const newTime = new Date(prev + STAGGER_MS);
      const platform = platformOf.get(cur.postId) ?? "";
      const taken = takenByPlatform?.get(platform);
      if (taken) {
        const others = taken.filter((t) => t.getTime() !== cur.scheduledFor.getTime());
        if (!others.every((t) => Math.abs(newTime.getTime() - t.getTime()) >= GAP_MS)) {
          continue; // moving here would break the same-platform gap — leave the post where it is
        }
        const idx = taken.findIndex((t) => t.getTime() === cur.scheduledFor.getTime());
        if (idx >= 0) taken[idx] = newTime; // keep the platform's taken set current for later moves
      }
      cur.scheduledFor = newTime;
    }
  }
  return results;
}

/** Effective daily caps: warm-up forces 1/day per platform until warmup_until (doc 06 §7). */
export async function effectiveCapResolver(
  now: Date,
): Promise<(categoryId: string, platform: Platform) => number> {
  const capsByCategory = new Map<string, CategoriesCadenceCaps>();
  const rows = await db
    .select({ id: categories.id, caps: categories.cadenceCaps })
    .from(categories);
  for (const r of rows) capsByCategory.set(r.id, r.caps as CategoriesCadenceCaps);

  const warmup = (await getSetting<Record<string, string>>("warmup_until")) ?? {};
  return (categoryId, platform) => {
    const until = warmup[platform];
    if (until && new Date(until).getTime() > now.getTime()) return WARMUP_DAILY_CAP;
    return capsByCategory.get(categoryId)?.[platform] ?? 0;
  };
}

/** Active A/B window flags (e.g. tiktok_weekend_am) read from settings. */
async function activeWindowFlags(): Promise<Set<string>> {
  const flags = new Set<string>();
  if ((await getSetting<boolean>("tiktok_weekend_am")) === true) flags.add("tiktok_weekend_am");
  return flags;
}

/** Platforms whose warm-up window is still open (doc 06 §7) — account capped at 1/day each. */
async function warmupPlatforms(now: Date): Promise<Set<string>> {
  const warmup = (await getSetting<Record<string, string>>("warmup_until")) ?? {};
  const set = new Set<string>();
  for (const [platform, until] of Object.entries(warmup)) {
    if (until && new Date(until).getTime() > now.getTime()) set.add(platform);
  }
  return set;
}

/** publish.plan handler — schedule approved, unscheduled posts (doc 06 §4). */
export async function publishPlanHandler(
  payload: { fastPathBriefId?: string | undefined },
  boss: Enqueuer,
): Promise<{ scheduled: number }> {
  const now = new Date();
  const windows = (await getSetting<SettingsPostingWindows>(
    "posting_windows",
  )) as SettingsPostingWindows | null;
  if (!windows) throw new Error("publish.plan: posting_windows setting missing");

  // approved posts lacking a slot (+ brief/trend context for ordering and fast-path)
  const rows = (await db.execute(sql`
    select p.id as "postId", p.category_id as "categoryId", p.platform,
           p.brief_id as "briefId",
           b.created_at as "briefCreatedAt",
           t.peak_estimate_at as "peakEstimateAt", t.longevity
    from posts p
    join briefs b on b.id = p.brief_id
    left join trends t on t.id = b.trend_id
    where p.status = 'approved' and p.scheduled_for is null
      ${payload.fastPathBriefId ? sql`and p.brief_id = ${payload.fastPathBriefId}` : sql``}
    order by coalesce(t.peak_estimate_at, b.created_at) asc, b.created_at asc
  `)) as unknown as {
    postId: string;
    categoryId: string;
    platform: Platform;
    briefId: string;
    briefCreatedAt: string | Date;
    peakEstimateAt: string | Date | null;
    longevity: string | null;
  }[];
  if (rows.length === 0) return { scheduled: 0 };

  // db.execute returns timestamps as raw driver values (strings) — coerce for ordering
  const planPosts: PlanPost[] = rows.map((r) => ({
    postId: r.postId,
    categoryId: r.categoryId,
    platform: r.platform,
    briefId: r.briefId,
    orderKey: new Date(r.peakEstimateAt ?? r.briefCreatedAt).getTime(),
    longevity: r.longevity,
  }));

  // existing scheduled/published times per lane, for gap + cap accounting
  const existRows = (await db.execute(sql`
    select category_id as "categoryId", platform, scheduled_for as "scheduledFor",
           published_at as "publishedAt"
    from posts
    where status in ('scheduled', 'publishing', 'published')
      and coalesce(scheduled_for, published_at) is not null
      and coalesce(scheduled_for, published_at) >= ${new Date(now.getTime() - 2 * 86_400_000).toISOString()}::timestamptz
  `)) as unknown as {
    categoryId: string;
    platform: string;
    scheduledFor: Date | null;
    publishedAt: Date | null;
  }[];
  const existingByLane = new Map<string, Date[]>();
  for (const r of existRows) {
    const when = r.scheduledFor ?? r.publishedAt;
    if (!when) continue;
    pushInto(existingByLane, laneKey(r.categoryId, r.platform), new Date(when));
  }

  const capFor = await effectiveCapResolver(now);
  const plan = planSchedule({
    now,
    posts: planPosts,
    windows,
    capFor,
    existingByLane,
    fastPathBriefId: payload.fastPathBriefId,
    activeFlags: await activeWindowFlags(),
    warmupPlatforms: await warmupPlatforms(now),
  });

  let scheduled = 0;
  for (const r of plan) {
    await transitionPost(db, r.postId, "scheduled", { scheduledFor: r.scheduledFor });
    await boss.send(
      Q.publishExecute,
      { postId: r.postId },
      { startAfter: r.scheduledFor, singletonKey: r.postId },
    );
    scheduled++;
    log.info(
      { postId: r.postId, scheduledFor: r.scheduledFor.toISOString(), fastPath: r.fastPath },
      "post scheduled",
    );
  }
  return { scheduled };
}

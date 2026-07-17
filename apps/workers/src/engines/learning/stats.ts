// Deterministic statistics for attribution (doc 07 §2). Pure + unit-tested against
// hand-computed values — the LLM analyst only ever sees these numbers, never raw guesses.

export function mean(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

/** 1-based average ranks (ties share the mean of their positions) — Spearman input. */
export function averageRanks(xs: number[]): number[] {
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.v === order[i]?.v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) {
      const item = order[k];
      if (item) ranks[item.i] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation. Returns null for n<3 or zero variance. */
export function spearman(pairs: [number, number][]): number | null {
  const clean = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = clean.length;
  if (n < 3) return null;
  const rx = averageRanks(clean.map((p) => p[0]));
  const ry = averageRanks(clean.map((p) => p[1]));
  const mx = mean(rx) as number;
  const my = mean(ry) as number;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (rx[i] as number) - mx;
    const b = (ry[i] as number) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Round to a fixed precision for stable report tables. */
export function round(x: number | null, dp = 3): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

export interface Bucket<T> {
  bucket: string;
  n: number;
  median: number | null;
  insufficient: boolean;
  items: T[];
}

/** Group items by a categorical key, median a numeric metric per bucket (doc 07 §2). */
export function bucketize<T>(
  items: T[],
  keyOf: (t: T) => string | null,
  metricOf: (t: T) => number | null,
  minN: number,
): Bucket<T>[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    if (k === null) continue;
    const arr = groups.get(k);
    if (arr) arr.push(it);
    else groups.set(k, [it]);
  }
  const out: Bucket<T>[] = [];
  for (const [bucket, group] of groups) {
    const vals = group.map(metricOf).filter((v): v is number => v !== null);
    out.push({
      bucket,
      n: group.length,
      median: round(median(vals)),
      insufficient: group.length < minN,
      items: group,
    });
  }
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Top/bottom fraction of items by a metric (doc 07 §2 deciles). fraction e.g. 0.1. */
export function extremeItems<T>(
  items: T[],
  metricOf: (t: T) => number | null,
  fraction: number,
): { top: T[]; bottom: T[] } {
  const withVal = items
    .map((t) => ({ t, v: metricOf(t) }))
    .filter((x): x is { t: T; v: number } => x.v !== null)
    .sort((a, b) => a.v - b.v);
  if (withVal.length === 0) return { top: [], bottom: [] };
  const k = Math.max(1, Math.ceil(withVal.length * fraction));
  return {
    bottom: withVal.slice(0, k).map((x) => x.t),
    top: withVal
      .slice(-k)
      .reverse()
      .map((x) => x.t),
  };
}

/** Whole weeks between `then` and `now` (0 = within last 7 days, 1 = 7–14 days ago, …). */
export function weeksAgo(then: Date, now: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / (7 * 86_400_000));
}

/** Count leading trues — "consecutive most-recent weeks under the median" (doc 07 §3 kill list). */
export function leadingTrue(flags: boolean[]): number {
  let n = 0;
  for (const f of flags) {
    if (!f) break;
    n++;
  }
  return n;
}

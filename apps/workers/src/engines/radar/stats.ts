// Layer-A statistics + vector math (doc 04 §2-§3). Pure functions — unit-tested directly.

export interface SnapshotPoint {
  capturedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  score: number | null;
}

/** Platform-primary popularity metric: views where the platform has them, else score (reddit). */
export function primaryMetric(p: SnapshotPoint): number | null {
  return p.views ?? p.score ?? null;
}

const MIN_SPAN_HOURS = 0.25; // floor so a burst of near-simultaneous snapshots can't explode the rate

/** Growth of the primary metric per hour across the snapshot span; null when <2 usable points. */
export function viewsPerHour(snapshots: SnapshotPoint[]): number | null {
  if (snapshots.length < 2) return null;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  if (!first || !last) return null;
  const m0 = primaryMetric(first);
  const m1 = primaryMetric(last);
  if (m0 === null || m1 === null) return null;
  const hours = Math.max(
    (last.capturedAt.getTime() - first.capturedAt.getTime()) / 3_600_000,
    MIN_SPAN_HOURS,
  );
  return (m1 - m0) / hours;
}

/** 2nd derivative over the last 3 snapshots: rate(b→c) − rate(a→b) (doc 04 §2). */
export function acceleration(snapshots: SnapshotPoint[]): number | null {
  if (snapshots.length < 3) return null;
  const [a, b, c] = snapshots.slice(-3);
  if (!a || !b || !c) return null;
  const ma = primaryMetric(a);
  const mb = primaryMetric(b);
  const mc = primaryMetric(c);
  if (ma === null || mb === null || mc === null) return null;
  const h1 = Math.max(
    (b.capturedAt.getTime() - a.capturedAt.getTime()) / 3_600_000,
    MIN_SPAN_HOURS,
  );
  const h2 = Math.max(
    (c.capturedAt.getTime() - b.capturedAt.getTime()) / 3_600_000,
    MIN_SPAN_HOURS,
  );
  return (mc - mb) / h2 - (mb - ma) / h1;
}

/** (likes+comments+shares)/views from the latest snapshot (doc 04 §2). */
export function engagementRate(latest: SnapshotPoint | undefined): number | null {
  if (!latest) return null;
  const views = latest.views;
  if (views === null || views <= 0) return null;
  return ((latest.likes ?? 0) + (latest.comments ?? 0) + (latest.shares ?? 0)) / views;
}

export interface Baseline {
  mean: number;
  std: number;
  n: number;
  computedAt: string; // ISO
}

export function meanStd(xs: number[]): { mean: number; std: number } {
  if (xs.length === 0) return { mean: 0, std: 1 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, std: Math.sqrt(variance) };
}

/** z-score vs the category×platform baseline; σ floored at 1 so tiny baselines can't explode z. */
export function velocityZ(vph: number, baseline: { mean: number; std: number }): number {
  const std = Math.max(baseline.std, 1);
  return (vph - baseline.mean) / std;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Incremental centroid: mean of n members extended with one new vector (doc 04 §3.3). */
export function updateCentroid(centroid: number[], n: number, v: number[]): number[] {
  if (centroid.length !== v.length || n <= 0) return v.slice();
  return centroid.map((c, i) => (c * n + (v[i] ?? 0)) / (n + 1));
}

export interface Transferability {
  tiktok: number;
  youtube: number;
  x: number;
  reddit: number;
}

/** Element-wise max rollup (doc 04 §3.4). */
export function maxTransferability(
  a: Transferability | null | undefined,
  b: Transferability,
): Transferability {
  if (!a) return { ...b };
  return {
    tiktok: Math.max(a.tiktok, b.tiktok),
    youtube: Math.max(a.youtube, b.youtube),
    x: Math.max(a.x, b.x),
    reddit: Math.max(a.reddit, b.reddit),
  };
}

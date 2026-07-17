// Silence/filler trimming for clips (research §Part-1: "the single most-repeated advice"). Uses the
// Whisper word timestamps to keep only the spoken spans within a clip window, removing internal
// silences longer than a threshold — then a time-mapper re-syncs the karaoke captions to the shorter
// (concatenated) timeline. Small pauses are preserved so speech doesn't sound machine-gunned.

export interface KeepSegment {
  start: number;
  end: number;
}

interface WordTime {
  start: number;
  end: number;
}

/** Build the spoken-audio keep-spans within [startSec,endSec], dropping silences > maxGapSec. */
export function computeKeepSegments(
  words: WordTime[],
  startSec: number,
  endSec: number,
  opts?: { padSec?: number; maxGapSec?: number },
): KeepSegment[] {
  const pad = opts?.padSec ?? 0.08; // keep consonant transients so cuts don't sound clipped
  const maxGap = opts?.maxGapSec ?? 0.4; // pauses shorter than this stay (natural rhythm)
  const inWindow = words
    .filter((w) => w.end > startSec && w.start < endSec)
    .map((w) => ({ start: Math.max(startSec, w.start - pad), end: Math.min(endSec, w.end + pad) }))
    .sort((a, b) => a.start - b.start);
  if (inWindow.length === 0) return [{ start: startSec, end: endSec }];

  const segs: KeepSegment[] = [];
  let cur = { ...(inWindow[0] as KeepSegment) };
  for (let i = 1; i < inWindow.length; i++) {
    const w = inWindow[i] as KeepSegment;
    if (w.start - cur.end <= maxGap) cur.end = Math.max(cur.end, w.end);
    else {
      segs.push(cur);
      cur = { ...w };
    }
  }
  segs.push(cur);
  return segs
    .map((s) => ({ start: Math.max(startSec, s.start), end: Math.min(endSec, s.end) }))
    .filter((s) => s.end - s.start > 0.05);
}

/** Total kept duration (the trimmed clip's length). */
export function keptDuration(keep: KeepSegment[]): number {
  return keep.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** Map a source-video timestamp onto the concatenated (silence-removed) timeline. */
export function makeTimeMapper(keep: KeepSegment[]): (t: number) => number {
  return (t: number) => {
    let acc = 0;
    for (const s of keep) {
      if (t < s.start) return acc; // inside a removed gap → snap to the next kept segment
      if (t <= s.end) return acc + (t - s.start);
      acc += s.end - s.start;
    }
    return acc; // past the final kept segment
  };
}

/** True when trimming actually removes a meaningful amount (≥0.4s) — else skip the concat entirely. */
export function worthTrimming(keep: KeepSegment[], startSec: number, endSec: number): boolean {
  return endSec - startSec - keptDuration(keep) >= 0.4;
}

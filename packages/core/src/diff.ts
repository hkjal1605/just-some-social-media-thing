// Plain LCS line diff (doc 10 §3.7 playbook diff — "no heavy dep"). Shared by the API's
// GET /playbooks/:id/diff and the dashboard's side-by-side view.

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

/** Longest-common-subsequence line diff: old→new as a same/add/del sequence. Pure. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = lcs[i] as number[];
    const rowNext = lcs[i + 1] as number[];
    for (let j = n - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j] ? (rowNext[j + 1] ?? 0) + 1 : Math.max(rowNext[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ type: "del", text: a[i] ?? "" });
      i++;
    } else {
      out.push({ type: "add", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < m) {
    out.push({ type: "del", text: a[i] ?? "" });
    i++;
  }
  while (j < n) {
    out.push({ type: "add", text: b[j] ?? "" });
    j++;
  }
  return out;
}

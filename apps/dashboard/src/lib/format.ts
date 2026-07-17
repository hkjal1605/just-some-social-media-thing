// Display helpers (doc 10 §2/§4). Times render in DISPLAY_TZ (IST); storage is UTC.
// Reimplemented locally (not imported from @ve/core) so the browser bundle stays free of
// the core barrel's node-only deps (pino). Types come from @ve/core as type-only imports.
const DISPLAY_TZ = "Asia/Kolkata";

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: DISPLAY_TZ,
    hour12: true,
  }).format(date);
}

export function fmtTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeStyle: "short",
    timeZone: DISPLAY_TZ,
    hour12: true,
  }).format(date);
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-IN").format(n);
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toFixed(digits)}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${Math.round(n * 100)}%`;
}

/** "3h ago" / "in 2d" relative to now. */
export function fmtAgo(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const unit = mins < 60 ? `${mins}m` : hours < 48 ? `${hours}h` : `${days}d`;
  return diffMs < 0 ? `${unit} ago` : `in ${unit}`;
}

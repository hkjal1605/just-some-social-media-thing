// Hand-rolled shadcn-style primitives (doc 10 §4) — no heavy UI kit. Tailwind v4.
import type { ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-medium text-zinc-500">{children}</h2>;
}

export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="mb-6 flex items-baseline justify-between">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {right}
    </header>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  size = "md",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger" | "success";
  type?: "button" | "submit";
  size?: "sm" | "md";
}) {
  const base =
    "inline-flex items-center justify-center rounded font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";
  const sizes = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  const variants = {
    primary:
      "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
    ghost:
      "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800",
    danger: "bg-red-600 text-white hover:bg-red-500",
    success: "bg-emerald-600 text-white hover:bg-emerald-500",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cx(base, sizes, variants)}>
      {children}
    </button>
  );
}

const CHIP_TONES: Record<string, string> = {
  // POST_STATUS + generic
  published: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  auto_approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  scheduled: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  publishing: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  awaiting_approval: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  edit_requested: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  blocked: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  expired: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  draft: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  deleted: "bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
  // RIGHTS_CLASS
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export function StatusChip({ status }: { status: string }) {
  const tone =
    CHIP_TONES[status] ?? "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={cx("inline-block rounded px-1.5 py-0.5 text-xs font-medium", tone)}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function Badge({
  children,
  tone = "zinc",
}: {
  children: ReactNode;
  tone?: "zinc" | "sky" | "emerald";
}) {
  const tones = {
    zinc: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    sky: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  }[tone];
  return (
    <span className={cx("inline-block rounded px-1.5 py-0.5 text-xs", tones)}>{children}</span>
  );
}

const PLATFORM_ICON: Record<string, string> = { tiktok: "🎵", youtube: "▶️", x: "𝕏", reddit: "🅡" };
export function PlatformIcon({ platform }: { platform: string }) {
  return <span title={platform}>{PLATFORM_ICON[platform] ?? platform}</span>;
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          {head}
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={cx("px-3 py-2 font-medium", right && "text-right")}>{children}</th>;
}
export function Td({
  children,
  right,
  mono,
}: {
  children: ReactNode;
  right?: boolean;
  mono?: boolean;
}) {
  return (
    <td className={cx("px-3 py-2", right && "text-right", mono && "tabular-nums")}>{children}</td>
  );
}

export function Spinner() {
  return <div className="animate-pulse text-sm text-zinc-400">loading…</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
      {children}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : "something went wrong";
  return (
    <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {msg}
    </div>
  );
}

export function KpiTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </Card>
  );
}

export function ProgressBar({
  ratio,
  tone = "sky",
}: {
  ratio: number;
  tone?: "sky" | "emerald" | "amber" | "red";
}) {
  const pct = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  const bar = {
    sky: "bg-sky-500",
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
  }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div className={cx("h-full rounded-full", bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-outside backdrop; Esc + ✕ also close
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops backdrop propagation; Esc/✕ close */}
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

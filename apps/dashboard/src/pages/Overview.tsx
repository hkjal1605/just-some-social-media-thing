// Overview (doc 10 §3.1): KPI tiles, spend-by-service, monetization thresholds, ops widget.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { fmtAgo, fmtCompact, fmtUsd } from "../lib/format";
import {
  Card,
  EmptyState,
  KpiTile,
  PageHeader,
  PlatformIcon,
  ProgressBar,
  SectionTitle,
  Spinner,
} from "../lib/ui";

interface Kpis {
  posts7d: number;
  views7d: number;
  pendingApprovals: number;
  spendMtd: number;
  budgetMonthlyUsd: number;
  topPost7d: {
    id: string;
    platform: string;
    views: number;
    permalink: string | null;
    thumbR2Key: string | null;
  } | null;
}
interface Ops {
  workersStale: boolean;
  workersHeartbeat: string | null;
  dlqCount: number;
  oldestPendingApprovalMinutes: number | null;
  killSwitch: boolean;
  queues: { name: string; pending: number; active: number; failed: number }[];
}
interface CostsResp {
  services: { service: string; kind: string; costUsd: number }[];
  spend: number;
}
interface SettingsResp {
  settings: { threshold_progress?: ThresholdProgress };
}
interface ThresholdProgress {
  tiktok?: { followers?: number; views30d?: number };
  youtube?: { subs?: number; shortsViews90d?: number };
  x?: { verifiedFollowers?: number; impressions3mo?: number };
}
interface Timeseries {
  viewsByDay: { day: string; platform: string; views: number }[];
  postsByDay: { day: string; status: string; n: number }[];
}

const PLATFORMS = ["tiktok", "youtube", "x", "reddit"] as const;
const STATUS_HUE: Record<string, string> = {
  published: "#10b981",
  scheduled: "#0ea5e9",
  awaiting_approval: "#f59e0b",
  failed: "#ef4444",
  draft: "#a1a1aa",
};

/** Pivot [{day,key,val}] rows into [{day, [key]:val, …}] for a multi-series chart. */
function pivot<T extends { day: string }>(
  rows: T[],
  keyOf: (r: T) => string,
  valOf: (r: T) => number,
): { rows: Record<string, number | string>[]; keys: string[] } {
  const byDay = new Map<string, Record<string, number | string>>();
  const keys = new Set<string>();
  for (const r of rows) {
    const k = keyOf(r);
    keys.add(k);
    const row = byDay.get(r.day) ?? { day: r.day };
    row[k] = ((row[k] as number) ?? 0) + valOf(r);
    byDay.set(r.day, row);
  }
  return { rows: [...byDay.values()], keys: [...keys] };
}

// monetization gate constants (research §; local to avoid the @ve/core barrel)
const GATES = {
  tiktokFollowers: 10_000,
  tiktokViews30d: 100_000,
  youtubeSubs: 500,
  youtubeShortsViews90d: 3_000_000,
  xVerifiedFollowers: 500,
  xImpressions3mo: 5_000_000,
};
const BUDGET_FALLBACK = 150; // used only if GET /dashboard/kpis omits budgetMonthlyUsd
const HUES = ["#0ea5e9", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#14b8a6"];

export function Overview() {
  const kpis = useQuery({ queryKey: ["kpis"], queryFn: () => api<Kpis>("/dashboard/kpis") });
  const ops = useQuery({ queryKey: ["ops"], queryFn: () => api<Ops>("/ops/summary") });
  const costs = useQuery({ queryKey: ["costs"], queryFn: () => api<CostsResp>("/costs") });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResp>("/settings"),
  });
  const series = useQuery({
    queryKey: ["timeseries"],
    queryFn: () => api<Timeseries>("/dashboard/timeseries?days=14"),
  });

  const th = settings.data?.settings.threshold_progress ?? {};
  const budget = kpis.data?.budgetMonthlyUsd ?? BUDGET_FALLBACK;
  const chartData = (costs.data?.services ?? [])
    .map((s) => ({ name: s.service, cost: Number(s.costUsd.toFixed(4)) }))
    .filter((s) => s.cost > 0)
    .slice(0, 8);
  const views = pivot(
    series.data?.viewsByDay ?? [],
    (r) => r.platform,
    (r) => r.views,
  );
  const postsByStatus = pivot(
    series.data?.postsByDay ?? [],
    (r) => r.status,
    (r) => r.n,
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" />

      {kpis.isLoading ? (
        <Spinner />
      ) : kpis.data ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <KpiTile label="Posts 7d" value={kpis.data.posts7d} />
          <KpiTile label="Views 7d" value={fmtCompact(kpis.data.views7d)} />
          <KpiTile
            label="Pending approvals"
            value={kpis.data.pendingApprovals}
            sub={
              <Link to="/approvals" className="underline">
                review →
              </Link>
            }
          />
          <KpiTile
            label="Spend MTD"
            value={fmtUsd(kpis.data.spendMtd)}
            sub={
              <span className="block">
                of {fmtUsd(budget, 0)}
                <ProgressBar
                  ratio={kpis.data.spendMtd / budget}
                  tone={kpis.data.spendMtd / budget > 0.8 ? "red" : "sky"}
                />
              </span>
            }
          />
          <TopPostTile post={kpis.data.topPost7d} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Views over time by platform (14d)</SectionTitle>
          {views.rows.length === 0 ? (
            <EmptyState>No snapshots yet.</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={views.rows}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-zinc-200 dark:stroke-zinc-800"
                />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend />
                {PLATFORMS.filter((p) => views.keys.includes(p)).map((p, i) => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={p}
                    stroke={HUES[i % HUES.length]}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card>
          <SectionTitle>Posts by status (14d)</SectionTitle>
          {postsByStatus.rows.length === 0 ? (
            <EmptyState>No posts yet.</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={postsByStatus.rows}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-zinc-200 dark:stroke-zinc-800"
                />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip />
                {postsByStatus.keys.map((s) => (
                  <Bar key={s} dataKey={s} stackId="posts" fill={STATUS_HUE[s] ?? "#a1a1aa"} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Spend by service (MTD)</SectionTitle>
          {chartData.length === 0 ? (
            <EmptyState>No spend recorded yet.</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} className="tabular-nums" />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                <Tooltip formatter={(v: number) => fmtUsd(v, 4)} />
                <Bar dataKey="cost" radius={[0, 3, 3, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={d.name} fill={HUES[i % HUES.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle>Monetization progress</SectionTitle>
          <div className="space-y-3 text-sm">
            <ThresholdRow
              label="TikTok followers"
              value={th.tiktok?.followers}
              gate={GATES.tiktokFollowers}
            />
            <ThresholdRow
              label="TikTok views 30d"
              value={th.tiktok?.views30d}
              gate={GATES.tiktokViews30d}
            />
            <ThresholdRow label="YouTube subs" value={th.youtube?.subs} gate={GATES.youtubeSubs} />
            <ThresholdRow
              label="YT Shorts views 90d"
              value={th.youtube?.shortsViews90d}
              gate={GATES.youtubeShortsViews90d}
            />
            <ThresholdRow
              label="X verified followers"
              value={th.x?.verifiedFollowers}
              gate={GATES.xVerifiedFollowers}
            />
            <ThresholdRow
              label="X impressions 3mo"
              value={th.x?.impressions3mo}
              gate={GATES.xImpressions3mo}
            />
          </div>
        </Card>
      </div>

      <Card>
        <SectionTitle>Ops</SectionTitle>
        {ops.data ? (
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <OpsStat
              label="Workers"
              value={ops.data.workersStale ? "⚠️ stale" : "🟢 live"}
              sub={fmtAgo(ops.data.workersHeartbeat)}
            />
            <OpsStat label="Dead-lettered" value={ops.data.dlqCount} sub="jobs failed" />
            <OpsStat
              label="Oldest pending"
              value={
                ops.data.oldestPendingApprovalMinutes === null
                  ? "—"
                  : `${ops.data.oldestPendingApprovalMinutes}m`
              }
              sub="approval age"
            />
            <OpsStat
              label="Kill-switch"
              value={ops.data.killSwitch ? "🔴 ON" : "🟢 off"}
              sub={
                <Link to="/settings" className="underline">
                  settings
                </Link>
              }
            />
          </div>
        ) : (
          <Spinner />
        )}
      </Card>
    </div>
  );
}

function ThresholdRow({
  label,
  value,
  gate,
}: {
  label: string;
  value: number | undefined;
  gate: number;
}) {
  const v = value ?? 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="tabular-nums">
          {fmtCompact(value)} / {fmtCompact(gate)}
        </span>
      </div>
      <ProgressBar ratio={v / gate} tone={v >= gate ? "emerald" : "sky"} />
    </div>
  );
}

function OpsStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
      <div className="text-xs text-zinc-400">{sub}</div>
    </div>
  );
}

/** Top-post-7d KPI tile (doc 10 §3.1): thumbnail + views, links to the post detail. */
function TopPostTile({ post }: { post: Kpis["topPost7d"] }) {
  const thumb = useQuery({
    queryKey: ["presign", post?.thumbR2Key],
    queryFn: () =>
      api<{ url: string }>(`/assets/presign?key=${encodeURIComponent(post?.thumbR2Key ?? "")}`),
    enabled: !!post?.thumbR2Key,
  });
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Top post 7d</div>
      {post ? (
        <Link
          to="/posts/$id"
          params={{ id: post.id }}
          className="mt-1 flex items-center gap-2 hover:opacity-80"
        >
          {thumb.data?.url ? (
            <img
              src={thumb.data.url}
              alt=""
              className="h-11 w-11 shrink-0 rounded bg-black object-cover"
            />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-zinc-100 dark:bg-zinc-800">
              <PlatformIcon platform={post.platform} />
            </div>
          )}
          <div className="min-w-0">
            <div className="text-2xl font-semibold leading-none tabular-nums">
              {fmtCompact(post.views)}
            </div>
            <div className="mt-0.5 truncate text-xs text-zinc-500">views · {post.platform}</div>
          </div>
        </Link>
      ) : (
        <div className="mt-2 text-sm text-zinc-400">No posts in the last 7 days.</div>
      )}
    </Card>
  );
}

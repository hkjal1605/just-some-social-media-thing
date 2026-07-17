// Trends (doc 10 §3.2): table with rights/score, detail drawer with members, suppress + brief.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../api";
import { useCategory } from "../lib/filters";
import { fmtAgo, fmtCompact } from "../lib/format";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
  Td,
  Th,
} from "../lib/ui";

interface TrendRow {
  id: string;
  categorySlug: string;
  status: string;
  headline: string;
  rightsClass: string;
  llmScore: number | null;
  memberCount: number;
  totalViews: number;
  firstDetectedAt: string;
}
const STATUSES = ["active", "briefed", "expired", "suppressed"];
const FORMATS = [
  "faceless-explainer-60s",
  "demo-screencast",
  "x-thread",
  "clip-vertical",
  "reddit-discussion",
];
const PLATFORMS = ["tiktok", "youtube", "x", "reddit"];

export function Trends() {
  const { category } = useCategory();
  const [status, setStatus] = useState("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["trends", category, status],
    queryFn: () =>
      api<{ items: TrendRow[] }>(
        `/trends?status=${status}${category ? `&category=${category}` : ""}`,
      ),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Trends"
        right={
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : !q.data || q.data.items.length === 0 ? (
        <EmptyState>No {status} trends yet — scouts run every 30 min.</EmptyState>
      ) : (
        <Table
          head={
            <tr>
              <Th>Headline</Th>
              <Th>Category</Th>
              <Th>Rights</Th>
              <Th right>Score</Th>
              <Th right>Members</Th>
              <Th right>Views</Th>
              <Th>Age</Th>
            </tr>
          }
        >
          {q.data.items.map((t) => (
            <tr
              key={t.id}
              onClick={() => setOpenId(t.id)}
              className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            >
              <Td>{t.headline}</Td>
              <Td>
                <Badge>{t.categorySlug}</Badge>
              </Td>
              <Td>
                <StatusChip status={t.rightsClass} />
              </Td>
              <Td right mono>
                {t.llmScore ?? "—"}
              </Td>
              <Td right mono>
                {t.memberCount}
              </Td>
              <Td right mono>
                {fmtCompact(t.totalViews)}
              </Td>
              <Td>{fmtAgo(t.firstDetectedAt)}</Td>
            </tr>
          ))}
        </Table>
      )}
      {openId && <TrendDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

interface TrendDetail {
  trend: {
    id: string;
    headline: string;
    summary: string;
    status: string;
    rightsClass: string;
    emotions: string[];
    transferability: Record<string, number> | null;
    formatArchetype: string | null;
  };
  members: {
    rawItemId: string;
    platform: string;
    url: string;
    title: string | null;
    latest: { views: number | null } | null;
  }[];
}

function TrendDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["trend", id], queryFn: () => api<TrendDetail>(`/trends/${id}`) });
  const [format, setFormat] = useState(FORMATS[0]);
  const [platforms, setPlatforms] = useState<string[]>(["tiktok"]);
  const [angle, setAngle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const suppress = useMutation({
    mutationFn: () => api(`/trends/${id}/suppress`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trends"] });
      onClose();
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : "failed"),
  });
  const brief = useMutation({
    mutationFn: () =>
      api("/briefs", {
        method: "POST",
        body: JSON.stringify({
          trendId: id,
          formatSlug: format,
          targetPlatforms: platforms,
          angle,
        }),
      }),
    onSuccess: () => {
      setMsg("✅ Brief created — the factory is producing it.");
      qc.invalidateQueries({ queryKey: ["trends"] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : "failed"),
  });

  return (
    <Modal title="Trend" onClose={onClose}>
      {q.isLoading || !q.data ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <StatusChip status={q.data.trend.rightsClass} />
              <StatusChip status={q.data.trend.status} />
              {q.data.trend.formatArchetype && (
                <Badge tone="sky">{q.data.trend.formatArchetype}</Badge>
              )}
            </div>
            <h4 className="text-base font-semibold">{q.data.trend.headline}</h4>
            <p className="mt-1 text-zinc-500">{q.data.trend.summary}</p>
            {q.data.trend.emotions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {q.data.trend.emotions.map((e) => (
                  <Badge key={e}>{e}</Badge>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 text-xs font-medium text-zinc-500">Member items</div>
            <ul className="space-y-1">
              {q.data.members.map((m) => (
                <li key={m.rawItemId} className="flex items-center justify-between gap-2">
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sky-600 hover:underline"
                  >
                    {m.platform} · {m.title ?? m.url}
                  </a>
                  <span className="shrink-0 tabular-nums text-zinc-400">
                    {fmtCompact(m.latest?.views ?? null)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {q.data.trend.rightsClass !== "red" && q.data.trend.status === "active" && (
            <div className="space-y-2 rounded border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="text-xs font-medium text-zinc-500">
                Create brief (manual override)
              </div>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2">
                {PLATFORMS.map((p) => (
                  <label key={p} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={platforms.includes(p)}
                      onChange={(e) =>
                        setPlatforms((prev) =>
                          e.target.checked ? [...prev, p] : prev.filter((x) => x !== p),
                        )
                      }
                    />
                    {p}
                  </label>
                ))}
              </div>
              <textarea
                value={angle}
                onChange={(e) => setAngle(e.target.value)}
                placeholder="Original angle (≥8 chars)…"
                className="h-16 w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
              />
              <Button
                onClick={() => brief.mutate()}
                disabled={brief.isPending || angle.length < 8 || platforms.length === 0}
              >
                Create brief
              </Button>
            </div>
          )}

          {msg && <div className="text-xs text-zinc-500">{msg}</div>}
          <div className="flex gap-2">
            {q.data.trend.status !== "suppressed" && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => suppress.mutate()}
                disabled={suppress.isPending}
              >
                Suppress
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

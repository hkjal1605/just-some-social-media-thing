// Post detail (doc 10 §3.3): render preview, metrics chart, engagements, lineage, retry/delete.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ApiError, api } from "../api";
import { fmtDateTime, fmtNum, fmtTime } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  PageHeader,
  SectionTitle,
  Spinner,
  StatusChip,
} from "../lib/ui";

interface Detail {
  post: {
    id: string;
    platform: string;
    status: string;
    permalink: string | null;
    scheduledFor: string | null;
    publishedAt: string | null;
    failReason: string | null;
    captionUsed: unknown;
    renderId: string | null;
  };
  brief: { id: string; angle: string; formatSlug: string } | null;
  script: { chosenHook: string | null; body: string } | null;
  render: { r2Key: string | null; thumbR2Key: string | null } | null;
  trend: { id: string; headline: string } | null;
  engagements: {
    id: string;
    author: string | null;
    text: string | null;
    repliedText: string | null;
    needsHuman: boolean;
  }[];
}
interface Snapshot {
  capturedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export function PostDetail() {
  const { id } = useParams({ from: "/authed/posts/$id" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["post", id], queryFn: () => api<Detail>(`/posts/${id}`) });
  const metrics = useQuery({
    queryKey: ["post-metrics", id],
    queryFn: () => api<{ series: Snapshot[] }>(`/posts/${id}/metrics`),
  });

  const retry = useMutation({
    mutationFn: () => api(`/posts/${id}/retry`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["post", id] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : "failed"),
  });
  const del = useMutation({
    mutationFn: () => api(`/posts/${id}`, { method: "DELETE" }),
    onSuccess: () => navigate({ to: "/posts" }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : "failed"),
  });

  async function loadPreview(key: string) {
    const { url } = await api<{ url: string }>(`/assets/presign?key=${encodeURIComponent(key)}`);
    setPreview(url);
  }

  if (q.isLoading || !q.data) return <Spinner />;
  const { post, brief, script, render, trend, engagements } = q.data;
  const cu = post.captionUsed;
  const hasCaption =
    cu != null && (typeof cu !== "object" || Object.keys(cu as Record<string, unknown>).length > 0);
  const series = (metrics.data?.series ?? []).map((s) => ({
    t: fmtTime(s.capturedAt),
    views: s.views,
    likes: s.likes,
    comments: s.comments,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Post · ${post.platform}`}
        right={
          <div className="flex items-center gap-2">
            <StatusChip status={post.status} />
            <Link to="/posts" className="text-sm text-zinc-500 hover:underline">
              ← all posts
            </Link>
          </div>
        }
      />
      {err && <ErrorNote error={new Error(err)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Metrics</SectionTitle>
          {series.length === 0 ? (
            <EmptyState>No snapshots yet (first lands +3h after publish).</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={series}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-zinc-200 dark:stroke-zinc-800"
                />
                <XAxis dataKey="t" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="views" stroke="#0ea5e9" dot={false} />
                <Line type="monotone" dataKey="likes" stroke="#10b981" dot={false} />
                <Line type="monotone" dataKey="comments" stroke="#f59e0b" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle>Details</SectionTitle>
          <dl className="space-y-1.5 text-sm">
            <Row k="Format" v={brief?.formatSlug ?? "—"} />
            <Row k="Angle" v={brief?.angle ?? "—"} />
            <Row k="Hook" v={script?.chosenHook ?? "—"} />
            <Row k="Scheduled" v={fmtDateTime(post.scheduledFor)} />
            <Row k="Published" v={fmtDateTime(post.publishedAt)} />
            {trend && (
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Trend</dt>
                <dd className="truncate text-right">{trend.headline}</dd>
              </div>
            )}
            {post.permalink && (
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500">Permalink</dt>
                <dd>
                  <a
                    href={post.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-600 hover:underline"
                  >
                    open ↗
                  </a>
                </dd>
              </div>
            )}
            {post.failReason && <Row k="Fail" v={post.failReason} />}
          </dl>

          <div className="mt-3 flex gap-2">
            {render?.r2Key && (
              <Button size="sm" variant="ghost" onClick={() => loadPreview(render.r2Key as string)}>
                Load preview
              </Button>
            )}
            {post.status === "failed" && (
              <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
                Retry
              </Button>
            )}
            {["draft", "scheduled", "approved", "failed", "published"].includes(post.status) && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => del.mutate()}
                disabled={del.isPending}
              >
                Delete
              </Button>
            )}
          </div>
          {preview?.startsWith("http") && (
            // biome-ignore lint/a11y/useMediaCaption: preview of our own rendered short — no caption track
            <video src={preview} controls className="mt-3 max-h-72 w-full rounded bg-black" />
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle>Engagement</SectionTitle>
        {engagements.length === 0 ? (
          <EmptyState>No comments captured yet.</EmptyState>
        ) : (
          <ul className="space-y-2 text-sm">
            {engagements.map((e) => (
              <EngagementRow key={e.id} e={e} postId={id} />
            ))}
          </ul>
        )}
      </Card>

      {hasCaption && (
        <Card>
          <SectionTitle>Caption (as sent)</SectionTitle>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
            {typeof cu === "string" ? cu : JSON.stringify(cu, null, 2)}
          </pre>
        </Card>
      )}

      {script && (
        <Card>
          <SectionTitle>Script</SectionTitle>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
            {script.body}
          </pre>
        </Card>
      )}
      <div className="text-xs text-zinc-400">
        views total: {fmtNum(series.at(-1)?.views ?? null)}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="truncate text-right">{v}</dd>
    </div>
  );
}

/** One engagement; needs-human comments get an inline reply box → POST /engagements/:id/reply. */
function EngagementRow({ e, postId }: { e: Detail["engagements"][number]; postId: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reply = useMutation({
    mutationFn: () =>
      api(`/engagements/${e.id}/reply`, { method: "POST", body: JSON.stringify({ text }) }),
    onSuccess: () => {
      setSent(true);
      setText("");
      qc.invalidateQueries({ queryKey: ["post", postId] });
    },
    onError: (error) => setErr(error instanceof ApiError ? error.message : "failed"),
  });
  return (
    <li className="rounded border border-zinc-100 p-2 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <span className="font-medium">{e.author ?? "anon"}</span>
        {e.needsHuman && <Badge>needs human</Badge>}
      </div>
      <p className="text-zinc-600 dark:text-zinc-400">{e.text}</p>
      {e.repliedText && <p className="mt-1 text-xs text-emerald-600">↳ {e.repliedText}</p>}
      {sent && !e.repliedText && <p className="mt-1 text-xs text-emerald-600">↳ reply queued</p>}
      {e.needsHuman && !e.repliedText && !sent && (
        <div className="mt-2 flex gap-2">
          <input
            value={text}
            onChange={(ev) => setText(ev.target.value)}
            placeholder="Write a reply…"
            className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
          />
          <Button
            size="sm"
            onClick={() => reply.mutate()}
            disabled={reply.isPending || text.trim().length === 0}
          >
            Send
          </Button>
        </div>
      )}
      {err && <p className="mt-1 text-xs text-red-500">{err}</p>}
    </li>
  );
}

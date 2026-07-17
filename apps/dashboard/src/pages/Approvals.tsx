// Approvals (doc 10 §3.4, doc 09): pending cards with preview + hook + approve/reject/edit.
// Decisions POST the same /decide endpoint the bot uses; list live-updates via 15s polling.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PerPlatformCaptions } from "@ve/core";
import { useState } from "react";
import { ApiError, api } from "../api";
import { fmtAgo } from "../lib/format";
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from "../lib/ui";

interface ApprovalSummary {
  id: string;
  categoryName: string;
  formatSlug: string;
  angle: string;
  hook: string;
  platforms: string[];
  trendHeadline: string | null;
  aiDisclosure: boolean;
  expiresAt: string;
  renderCount: number;
}
interface CardData {
  previewVideoUrl?: string;
  plannedSlotDisplay: string;
  bodyPreview: string;
  hookVariants?: { id: string; text: string }[];
  chosenHook?: string | null;
  captions?: PerPlatformCaptions | null;
}

export function Approvals() {
  const q = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api<{ items: ApprovalSummary[] }>("/approvals?status=pending"),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Approvals" />
      {q.isLoading ? (
        <Spinner />
      ) : !q.data || q.data.items.length === 0 ? (
        <EmptyState>✅ No pending approvals.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {q.data.items.map((a) => (
            <ApprovalCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ a }: { a: ApprovalSummary }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"idle" | "reject" | "edit">("idle");
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [hookChoice, setHookChoice] = useState<string | null>(null);
  const card = useQuery({
    queryKey: ["approval-card", a.id],
    queryFn: () => api<CardData>(`/approvals/${a.id}/card`),
  });

  const decide = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ ok?: boolean; raced?: boolean }>(`/approvals/${a.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ ...body, via: "dashboard" }),
      }),
    onSuccess: (r) => {
      if (r.raced) setErr("Already decided elsewhere.");
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["kpis"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "failed"),
  });

  // hook variants radio (doc 09 §4): default = chosen; picking another turns Approve into an edit
  // (v1 simplification: full re-render via the existing edit_requested path — no new route).
  const variants = card.data?.hookVariants ?? [];
  const chosenDefault = card.data?.chosenHook ?? variants[0]?.id ?? null;
  const selectedHook = hookChoice ?? chosenDefault;
  const isHookEdit = !!selectedHook && selectedHook !== chosenDefault;

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge tone="sky">{a.categoryName}</Badge>
          <span className="text-xs text-zinc-500">{a.formatSlug}</span>
          {a.aiDisclosure && <Badge>🏷 AI</Badge>}
        </div>
        <span className="text-xs text-zinc-400">expires {fmtAgo(a.expiresAt)}</span>
      </div>

      {card.data?.previewVideoUrl?.startsWith("http") ? (
        // biome-ignore lint/a11y/useMediaCaption: preview of our own rendered short — no caption track
        <video
          src={card.data.previewVideoUrl}
          controls
          className="mb-2 max-h-72 w-full rounded bg-black"
        />
      ) : a.renderCount === 0 ? (
        <pre className="mb-2 max-h-40 overflow-y-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">
          {card.data?.bodyPreview ?? "…"}
        </pre>
      ) : null}

      <div className="space-y-1 text-sm">
        {variants.length > 0 ? (
          <div>
            <span className="font-medium">Hook:</span>
            <div className="mt-1 space-y-1">
              {variants.map((v) => (
                <label key={v.id} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`hook-${a.id}`}
                    checked={selectedHook === v.id}
                    onChange={() => setHookChoice(v.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="uppercase text-zinc-400">{v.id}.</span> {v.text}
                  </span>
                </label>
              ))}
            </div>
            {isHookEdit && (
              <p className="mt-1 text-xs text-amber-600">
                Approving re-renders with hook {selectedHook} (edit flow).
              </p>
            )}
          </div>
        ) : (
          <p>
            <span className="font-medium">Hook:</span> {a.hook}
          </p>
        )}
        <p className="text-zinc-500">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Angle:</span> {a.angle}
        </p>
        {a.trendHeadline && <p className="text-xs text-zinc-400">Trend: {a.trendHeadline}</p>}
        <p className="text-xs text-zinc-400">
          {a.platforms.join(", ")} · slot: {card.data?.plannedSlotDisplay ?? "…"}
        </p>
        {card.data?.captions && <CaptionsView captions={card.data.captions} />}
      </div>

      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}

      {mode === "idle" ? (
        <div className="mt-3 flex gap-2">
          <Button
            variant="success"
            size="sm"
            onClick={() =>
              isHookEdit
                ? decide.mutate({
                    decision: "edit_requested",
                    editInstructions: `Use hook variant ${selectedHook}: ${
                      variants.find((v) => v.id === selectedHook)?.text ?? ""
                    }`,
                  })
                : decide.mutate({ decision: "approved" })
            }
            disabled={decide.isPending}
          >
            {isHookEdit ? `✅ Approve · hook ${selectedHook}` : "✅ Approve"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode("edit")}>
            ✏️ Edit
          </Button>
          <Button variant="danger" size="sm" onClick={() => setMode("reject")}>
            ❌ Reject
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === "reject" ? "Reject reason…" : "Edit instructions (hook/caption/scene)…"
            }
            className="h-16 w-full rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={mode === "reject" ? "danger" : "primary"}
              disabled={decide.isPending || text.length === 0}
              onClick={() =>
                decide.mutate(
                  mode === "reject"
                    ? { decision: "rejected", reason: text }
                    : { decision: "edit_requested", editInstructions: text },
                )
              }
            >
              {mode === "reject" ? "Confirm reject" : "Request edit"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Read-only per-platform captions "as will be sent" (doc 09 §4). Editing needs a PATCH route (none). */
function CaptionsView({ captions }: { captions: PerPlatformCaptions }) {
  const rows: [string, string][] = [];
  if (captions.tiktok) {
    const tags = captions.tiktok.hashtags?.map((h) => `#${h}`).join(" ") ?? "";
    rows.push(["tiktok", `${captions.tiktok.caption}${tags ? ` ${tags}` : ""}`]);
  }
  if (captions.youtube) rows.push(["youtube", captions.youtube.title]);
  if (captions.x) rows.push(["x", captions.x.text]);
  if (captions.reddit)
    rows.push(["reddit", `${captions.reddit.subreddit}: ${captions.reddit.title}`]);
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 space-y-0.5 rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-800/50">
      <div className="font-medium text-zinc-500">Captions (as will be sent)</div>
      {rows.map(([plat, txt]) => (
        <p key={plat} className="text-zinc-600 dark:text-zinc-400">
          <span className="text-zinc-400">{plat}:</span> {txt}
        </p>
      ))}
    </div>
  );
}

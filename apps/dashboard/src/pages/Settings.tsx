// Settings (doc 10 §3.9): kill-switch, categories, sources, thresholds, operator knobs.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../api";
import type { CategoryRow } from "../lib/filters";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SectionTitle,
  Spinner,
  StatusChip,
} from "../lib/ui";

export function Settings() {
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" />
      <KillSwitch />
      <Categories />
      <Sources />
      <PostingWindows />
      <EngageAutoReply />
      <Integrations />
      <Thresholds />
      <Knobs />
    </div>
  );
}

function KillSwitch() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["kill"],
    queryFn: () => api<{ on: boolean }>("/settings/kill-switch"),
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) =>
      api("/settings/kill-switch", {
        method: "PUT",
        body: JSON.stringify({ on, reason: "dashboard" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kill"] });
      qc.invalidateQueries({ queryKey: ["ops"] });
    },
  });
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <SectionTitle>Kill-switch</SectionTitle>
          <p className="text-xs text-zinc-500">
            Pauses publishing, factory, replies & approvals. Radar + metrics keep running.
          </p>
        </div>
        {q.data && (
          <Button
            variant={q.data.on ? "success" : "danger"}
            onClick={() => toggle.mutate(!q.data.on)}
            disabled={toggle.isPending}
          >
            {q.data.on ? "🟢 Resume" : "🔴 Engage kill-switch"}
          </Button>
        )}
      </div>
    </Card>
  );
}

const MODES = ["full_auto_candidate", "human_gated", "radar_only"];

function Categories() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<{ items: CategoryRow[] }>("/categories"),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/categories/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  return (
    <Card>
      <SectionTitle>Categories</SectionTitle>
      {q.isLoading || !q.data ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          {q.data.items.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center gap-3 rounded border border-zinc-100 p-2 text-sm dark:border-zinc-800"
            >
              <span className="font-medium">{c.name}</span>
              <select
                value={c.mode}
                onChange={(e) => patch.mutate({ id: c.id, body: { mode: e.target.value } })}
                className="rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-zinc-700"
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={c.active}
                  onChange={(e) => patch.mutate({ id: c.id, body: { active: e.target.checked } })}
                />
                active
              </label>
              <span className="flex flex-wrap items-center gap-1">
                {(c.autoApproveFormats ?? []).length === 0 ? (
                  <span className="text-xs text-zinc-400">no auto-approve</span>
                ) : (
                  c.autoApproveFormats.map((f) => (
                    <button
                      type="button"
                      key={f}
                      title="revoke"
                      onClick={() =>
                        patch.mutate({
                          id: c.id,
                          body: { autoApproveFormats: c.autoApproveFormats.filter((x) => x !== f) },
                        })
                      }
                      className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700 hover:line-through dark:bg-emerald-950 dark:text-emerald-300"
                    >
                      {f} ✕
                    </button>
                  ))
                )}
              </span>
              <span className="ml-auto text-xs tabular-nums text-zinc-400">
                caps{" "}
                {Object.entries(c.cadenceCaps ?? {})
                  .map(([k, v]) => `${k[0]}:${v}`)
                  .join(" ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface Source {
  id: string;
  categoryId: string;
  platform: string;
  kind: string;
  value: string;
  scoutIntervalMin: number;
  active: boolean;
}
const PLATFORMS = ["reddit", "youtube", "x", "tiktok"];
const KINDS = [
  "subreddit",
  "yt_channel",
  "yt_chart",
  "x_query",
  "tiktok_hashtag",
  "tiktok_creator",
];

function Sources() {
  const qc = useQueryClient();
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<{ items: CategoryRow[] }>("/categories"),
  });
  const [catId, setCatId] = useState("");
  const [form, setForm] = useState({ platform: "reddit", kind: "subreddit", value: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["sources", catId],
    queryFn: () => api<{ items: Source[] }>(`/sources${catId ? `?category=${catId}` : ""}`),
    enabled: !!catId,
  });
  const add = useMutation({
    mutationFn: () =>
      api("/sources", { method: "POST", body: JSON.stringify({ categoryId: catId, ...form }) }),
    onSuccess: () => {
      setForm({ ...form, value: "" });
      qc.invalidateQueries({ queryKey: ["sources", catId] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : "failed"),
  });
  const scout = useMutation({
    mutationFn: (id: string) => api(`/sources/${id}/scout`, { method: "POST" }),
    onSuccess: () => setMsg("scout enqueued"),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/sources/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sources", catId] }),
  });

  return (
    <Card>
      <SectionTitle>Sources</SectionTitle>
      <select
        value={catId}
        onChange={(e) => setCatId(e.target.value)}
        className="mb-3 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
      >
        <option value="">pick a category…</option>
        {cats.data?.items.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      {catId && (
        <>
          {q.data && q.data.items.length > 0 ? (
            <ul className="mb-3 space-y-1 text-sm">
              {q.data.items.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <Badge>{s.platform}</Badge>
                  <span className="text-zinc-500">{s.kind}</span>
                  <span className="font-mono text-xs">{s.value}</span>
                  {!s.active && <StatusChip status="draft" />}
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => scout.mutate(s.id)}>
                      scout now
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => del.mutate(s.id)}>
                      ✕
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No sources for this category.</EmptyState>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <select
              value={form.platform}
              onChange={(e) => setForm({ ...form, platform: e.target.value })}
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 dark:border-zinc-700"
            >
              {PLATFORMS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 dark:border-zinc-700"
            >
              {KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              placeholder="r/... / channelId / query"
              className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            />
            <Button
              size="sm"
              onClick={() => add.mutate()}
              disabled={add.isPending || form.value.length === 0}
            >
              Add source
            </Button>
          </div>
        </>
      )}
      {msg && <p className="mt-2 text-xs text-zinc-500">{msg}</p>}
    </Card>
  );
}

function Thresholds() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () =>
      api<{ settings: { threshold_progress?: Record<string, Record<string, number>> } }>(
        "/settings",
      ),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (value: unknown) =>
      api("/settings/threshold_progress", { method: "PUT", body: JSON.stringify({ value }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const cur = q.data?.settings.threshold_progress ?? {};
  const fields: [string, string, string][] = [
    ["tiktok", "followers", "TikTok followers"],
    ["youtube", "subs", "YouTube subs"],
    ["x", "verifiedFollowers", "X verified followers"],
  ];

  return (
    <Card>
      <SectionTitle>Monetization thresholds (manual entry)</SectionTitle>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        {fields.map(([plat, key, label]) => (
          <label key={`${plat}.${key}`} className="text-xs text-zinc-500">
            {label}
            <input
              type="number"
              defaultValue={cur[plat]?.[key] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [`${plat}.${key}`]: e.target.value }))}
              className="mt-1 block w-32 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            />
          </label>
        ))}
        <Button
          size="sm"
          onClick={() => {
            const next: Record<string, Record<string, number>> = JSON.parse(JSON.stringify(cur));
            for (const [k, v] of Object.entries(draft)) {
              const [plat, key] = k.split(".");
              if (!plat || !key || v === "") continue;
              next[plat] = { ...(next[plat] ?? {}), [key]: Number(v) };
            }
            next.updatedAt = { at: Date.now() } as never;
            save.mutate(next);
          }}
          disabled={save.isPending}
        >
          Save thresholds
        </Button>
      </div>
    </Card>
  );
}

function Knobs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: Record<string, unknown> }>("/settings"),
  });
  const put = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api(`/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const weekendAm = q.data?.settings.tiktok_weekend_am === true;
  const xCap = Number(q.data?.settings.x_monthly_read_cap_usd ?? 80);

  return (
    <Card>
      <SectionTitle>Knobs</SectionTitle>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={weekendAm}
            onChange={(e) => put.mutate({ key: "tiktok_weekend_am", value: e.target.checked })}
          />
          TikTok weekend-AM window (A/B)
        </label>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          X monthly read cap $
          <input
            type="number"
            defaultValue={xCap}
            onBlur={(e) =>
              put.mutate({ key: "x_monthly_read_cap_usd", value: Number(e.target.value) })
            }
            className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
      </div>
    </Card>
  );
}

// Posting windows editor (doc 10 §3.9): JSON textarea with client-side parse + server 422 surfaced.
// Full grid editor is overkill for a single admin — the round-trip is what matters.
function PostingWindows() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: { posting_windows?: unknown } }>("/settings"),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (value: unknown) =>
      api("/settings/posting_windows", { method: "PUT", body: JSON.stringify({ value }) }),
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => {
      setSaved(false);
      setErr(e instanceof ApiError ? e.message : "failed");
    },
  });
  const cur = q.data?.settings.posting_windows;
  const text = draft ?? (cur ? JSON.stringify(cur, null, 2) : "");

  function onSave() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setSaved(false);
      setErr(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    save.mutate(parsed);
  }

  return (
    <Card>
      <SectionTitle>Posting windows (IST)</SectionTitle>
      <p className="mb-2 text-xs text-zinc-500">
        Per-platform IST windows.{" "}
        <code className="text-zinc-400">{`{ tiktok:[{days:["*"],start:"18:00",end:"21:00"}], youtube:[…], x:[…], reddit:[…] }`}</code>
      </p>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <>
          <textarea
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setErr(null);
              setSaved(false);
            }}
            className="h-56 w-full rounded border border-zinc-300 bg-transparent px-2 py-1 font-mono text-xs dark:border-zinc-700"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={onSave} disabled={save.isPending}>
              Save windows
            </Button>
            {draft !== null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                  setErr(null);
                  setSaved(false);
                }}
              >
                Reset
              </Button>
            )}
            {saved && <span className="text-xs text-emerald-600">saved ✓</span>}
          </div>
          {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
        </>
      )}
    </Card>
  );
}

// engage_auto_reply per-category toggle map (doc 10 §3.9): { [categorySlug]: boolean }. Each toggle
// PUTs the whole map (the settings schema validates the full object).
function EngageAutoReply() {
  const qc = useQueryClient();
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<{ items: CategoryRow[] }>("/categories"),
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: { engage_auto_reply?: Record<string, boolean> } }>("/settings"),
  });
  const [err, setErr] = useState<string | null>(null);
  const put = useMutation({
    mutationFn: (value: Record<string, boolean>) =>
      api("/settings/engage_auto_reply", { method: "PUT", body: JSON.stringify({ value }) }),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "failed"),
  });
  const cur = settings.data?.settings.engage_auto_reply ?? {};

  return (
    <Card>
      <SectionTitle>Auto-reply per category</SectionTitle>
      <p className="mb-2 text-xs text-zinc-500">
        When on, low-risk comments in a category get an automated reply; the rest are flagged for
        human review.
      </p>
      {cats.isLoading || !cats.data ? (
        <Spinner />
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {cats.data.items.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={cur[c.slug] ?? false}
                onChange={(e) => put.mutate({ ...cur, [c.slug]: e.target.checked })}
              />
              {c.name}
            </label>
          ))}
        </div>
      )}
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </Card>
  );
}

// Integrations status panel (doc 10 §3.9): read-only feature flags from GET /settings.
function Integrations() {
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ integrations: Record<string, boolean> }>("/settings"),
  });
  return (
    <Card>
      <SectionTitle>Integrations</SectionTitle>
      <p className="mb-2 text-xs text-zinc-500">
        Connector status from env credentials (read-only). Grey = disabled → connector falls back to
        fixtures.
      </p>
      {q.isLoading || !q.data ? (
        <Spinner />
      ) : (
        <div className="flex flex-wrap gap-2">
          {Object.entries(q.data.integrations).map(([name, on]) => (
            <Badge key={name} tone={on ? "emerald" : "zinc"}>
              {on ? "🟢" : "⚪"} {name}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

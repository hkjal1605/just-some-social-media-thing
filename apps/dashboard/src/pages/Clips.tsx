// Clips (doc 10 §3.6): long-form upload → ingest → candidate promotion, and campaign tracking.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../api";
import { useCategory } from "../lib/filters";
import { fmtDateTime } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  PageHeader,
  SectionTitle,
  Spinner,
  StatusChip,
  Table,
  Td,
  Th,
} from "../lib/ui";

export function Clips() {
  const [tab, setTab] = useState<"longforms" | "campaigns">("longforms");
  return (
    <div className="space-y-4">
      <PageHeader
        title="Clips"
        right={
          <div className="flex gap-1 rounded border border-zinc-200 p-0.5 text-sm dark:border-zinc-800">
            {(["longforms", "campaigns"] as const).map((tt) => (
              <button
                type="button"
                key={tt}
                onClick={() => setTab(tt)}
                className={cx(
                  "rounded px-2 py-1",
                  tab === tt && "bg-zinc-100 font-medium dark:bg-zinc-800",
                )}
              >
                {tt}
              </button>
            ))}
          </div>
        }
      />
      {tab === "longforms" ? <LongForms /> : <Campaigns />}
    </div>
  );
}

// ── long-forms ───────────────────────────────────────────────────────────────
interface LongForm {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

function LongForms() {
  const qc = useQueryClient();
  const { categories } = useCategory();
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["longforms"],
    queryFn: () => api<{ items: LongForm[] }>("/longforms"),
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle>Upload</SectionTitle>
        <UploadForm
          categories={categories}
          onDone={() => qc.invalidateQueries({ queryKey: ["longforms"] })}
        />
      </Card>
      <div className="lg:col-span-2">
        {q.isLoading ? (
          <Spinner />
        ) : !q.data || q.data.items.length === 0 ? (
          <EmptyState>No long-forms uploaded yet.</EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Uploaded</Th>
                <Th> </Th>
              </tr>
            }
          >
            {q.data.items.map((lf) => (
              <tr key={lf.id}>
                <Td>{lf.title}</Td>
                <Td>
                  <StatusChip status={lf.status} />
                </Td>
                <Td>{fmtDateTime(lf.createdAt)}</Td>
                <Td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpenId(openId === lf.id ? null : lf.id)}
                  >
                    candidates
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {openId && <Candidates longFormId={openId} />}
      </div>
    </div>
  );
}

function UploadForm({
  categories,
  onDone,
}: {
  categories: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const { id, presignedPut } = await api<{ id: string; presignedPut: string }>("/longforms", {
        method: "POST",
        body: JSON.stringify({ title, categoryId, mime: file?.type || "video/mp4" }),
      });
      if (file && presignedPut.startsWith("http")) {
        await fetch(presignedPut, {
          method: "PUT",
          body: file,
          headers: { "content-type": file.type },
        });
      }
      await api(`/longforms/${id}/ingest`, { method: "POST" });
      setMsg("✅ uploaded — transcription queued");
      setTitle("");
      setFile(null);
      onDone();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
      />
      <select
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
      >
        <option value="">category…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input
        type="file"
        accept="video/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="w-full text-xs"
      />
      <Button onClick={submit} disabled={busy || title.length === 0 || categoryId === ""}>
        {busy ? "uploading…" : "Upload + ingest"}
      </Button>
      {msg && <p className="text-xs text-zinc-500">{msg}</p>}
    </div>
  );
}

interface Candidate {
  id: string;
  startSec: string;
  endSec: string;
  hookScore: number;
  selfContainedScore: number;
  emotionScore: number;
  transcriptSlice: string | null;
  briefId: string | null;
}

function Candidates({ longFormId }: { longFormId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["longform", longFormId],
    queryFn: () => api<{ candidates: Candidate[] }>(`/longforms/${longFormId}`),
  });
  const promote = useMutation({
    mutationFn: (id: string) =>
      api(`/clip-candidates/${id}/promote`, {
        method: "POST",
        body: JSON.stringify({ targetPlatforms: ["tiktok"] }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["longform", longFormId] }),
  });
  if (q.isLoading || !q.data) return <Spinner />;
  return (
    <Card className="mt-3">
      <SectionTitle>Candidate moments</SectionTitle>
      {q.data.candidates.length === 0 ? (
        <EmptyState>No candidates yet (Gemini analyzes after transcription).</EmptyState>
      ) : (
        <ul className="space-y-2 text-sm">
          {q.data.candidates.map((c) => (
            <li key={c.id} className="rounded border border-zinc-100 p-2 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="tabular-nums text-zinc-500">
                  {Number(c.startSec).toFixed(0)}s–{Number(c.endSec).toFixed(0)}s
                </span>
                <div className="flex gap-1">
                  <Badge>hook {c.hookScore}</Badge>
                  <Badge>self {c.selfContainedScore}</Badge>
                  <Badge>emo {c.emotionScore}</Badge>
                </div>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{c.transcriptSlice}</p>
              {c.briefId ? (
                <Badge tone="emerald">promoted</Badge>
              ) : (
                <Button size="sm" onClick={() => promote.mutate(c.id)} disabled={promote.isPending}>
                  Make clip
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── campaigns ────────────────────────────────────────────────────────────────
interface Campaign {
  id: string;
  name: string;
  marketplace: string;
  active: boolean;
  budgetUsd: string | null;
}

function Campaigns() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api<{ items: Campaign[] }>("/campaigns"),
  });
  const create = useMutation({
    mutationFn: () => api("/campaigns", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle>New campaign</SectionTitle>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Whop: brand month"
            className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
          />
          <Button
            size="sm"
            onClick={() => create.mutate()}
            disabled={create.isPending || name.length === 0}
          >
            Add
          </Button>
        </div>
      </Card>
      <div className="lg:col-span-2 space-y-3">
        {q.isLoading ? (
          <Spinner />
        ) : !q.data || q.data.items.length === 0 ? (
          <EmptyState>No campaigns yet.</EmptyState>
        ) : (
          q.data.items.map((cmp) => (
            <Card key={cmp.id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{cmp.name}</div>
                  <div className="text-xs text-zinc-500">
                    {cmp.marketplace} {cmp.active ? "" : "· inactive"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpenId(openId === cmp.id ? null : cmp.id)}
                >
                  clips
                </Button>
              </div>
              {openId === cmp.id && <CampaignClips campaignId={cmp.id} />}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

interface Clip {
  id: string;
  platform: string;
  permalink: string | null;
  views: number | null;
  submittedUrl: string | null;
  payoutUsd: string | null;
}

function CampaignClips({ campaignId }: { campaignId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => api<{ clips: Clip[] }>(`/campaigns/${campaignId}`),
  });
  const [payouts, setPayouts] = useState<Record<string, string>>({});
  const pay = useMutation({
    mutationFn: ({ id, usd }: { id: string; usd: number }) =>
      api(`/campaign-clips/${id}`, {
        method: "POST",
        body: JSON.stringify({ payoutUsd: usd, markPaid: true }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", campaignId] }),
  });
  if (q.isLoading || !q.data) return <Spinner />;
  return (
    <div className="mt-2">
      {q.data.clips.length === 0 ? (
        <EmptyState>No clips submitted yet.</EmptyState>
      ) : (
        <ul className="space-y-1 text-sm">
          {q.data.clips.map((cl) => (
            <li key={cl.id} className="flex items-center justify-between gap-2">
              <span>
                {cl.platform}{" "}
                {cl.permalink && (
                  <a href={cl.permalink} className="text-sky-600" target="_blank" rel="noreferrer">
                    ↗
                  </a>
                )}
              </span>
              <span className="flex items-center gap-1">
                {cl.payoutUsd ? (
                  <Badge tone="emerald">${Number(cl.payoutUsd).toFixed(2)}</Badge>
                ) : (
                  <>
                    <input
                      value={payouts[cl.id] ?? ""}
                      onChange={(e) => setPayouts((p) => ({ ...p, [cl.id]: e.target.value }))}
                      placeholder="$"
                      className="w-16 rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700"
                    />
                    <Button
                      size="sm"
                      onClick={() => pay.mutate({ id: cl.id, usd: Number(payouts[cl.id] ?? 0) })}
                    >
                      save
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

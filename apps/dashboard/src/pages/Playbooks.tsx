// Playbooks (doc 10 §3.7): version list per category, side-by-side diff (LCS from the API),
// approve the pending draft.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { CategorySelect, useCategory } from "../lib/filters";
import { fmtDateTime } from "../lib/format";
import { Badge, Button, Card, cx, EmptyState, PageHeader, SectionTitle, Spinner } from "../lib/ui";

interface Version {
  id: string;
  version: number;
  changeSummary: string | null;
  createdBy: string;
  approvedAt: string | null;
  createdAt: string;
}
interface DiffResp {
  current: { version: number; approvedAt: string | null };
  previous: { version: number } | null;
  diff: { type: "same" | "add" | "del"; text: string }[];
}

export function Playbooks() {
  const { category } = useCategory();
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["playbooks", category],
    queryFn: () => api<{ items: Version[] }>(`/playbooks?category=${category}`),
    enabled: !!category,
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Playbooks" right={<CategorySelect />} />
      {!category ? (
        <EmptyState>Pick a category to see its playbook versions.</EmptyState>
      ) : q.isLoading ? (
        <Spinner />
      ) : !q.data || q.data.items.length === 0 ? (
        <EmptyState>No playbook versions yet — Engine 4 drafts them weekly.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <SectionTitle>Versions</SectionTitle>
            <ul className="space-y-1 text-sm">
              {q.data.items.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(v.id)}
                    className={cx(
                      "flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      openId === v.id && "bg-zinc-100 dark:bg-zinc-800",
                    )}
                  >
                    <span>
                      v{v.version} · <span className="text-zinc-400">{v.createdBy}</span>
                    </span>
                    {v.approvedAt ? (
                      <Badge tone="emerald">approved</Badge>
                    ) : (
                      <Badge tone="sky">draft</Badge>
                    )}
                  </button>
                  <div className="px-2 text-xs text-zinc-400">{fmtDateTime(v.createdAt)}</div>
                </li>
              ))}
            </ul>
          </Card>
          <div className="lg:col-span-2">
            {openId ? <DiffView id={openId} /> : <EmptyState>Select a version to diff.</EmptyState>}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffView({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["playbook-diff", id],
    queryFn: () => api<DiffResp>(`/playbooks/${id}/diff`),
  });
  const approve = useMutation({
    mutationFn: () => api(`/playbooks/${id}/approve`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["playbooks"] });
      qc.invalidateQueries({ queryKey: ["playbook-diff", id] });
    },
  });
  if (q.isLoading || !q.data) return <Spinner />;
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>
          v{q.data.previous?.version ?? "∅"} → v{q.data.current.version}
        </SectionTitle>
        {!q.data.current.approvedAt && (
          <Button
            size="sm"
            variant="success"
            onClick={() => approve.mutate()}
            disabled={approve.isPending}
          >
            Approve draft
          </Button>
        )}
      </div>
      <pre className="max-h-[60vh] overflow-y-auto rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-950">
        {q.data.diff.map((l, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
            key={i}
            className={cx(
              "whitespace-pre-wrap",
              l.type === "add" &&
                "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
              l.type === "del" &&
                "bg-red-100 text-red-800 line-through dark:bg-red-950 dark:text-red-300",
              l.type === "same" && "text-zinc-500",
            )}
          >
            {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
            {l.text || " "}
          </div>
        ))}
      </pre>
    </Card>
  );
}

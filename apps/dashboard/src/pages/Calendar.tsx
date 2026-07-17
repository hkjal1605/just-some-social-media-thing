// Calendar (doc 10 §3.5): 7-day grid by platform; scheduled/published posts as chips; click a
// chip to reslot (PATCH validates caps/gaps server-side → 422 surfaces here).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../api";
import { fmtTime } from "../lib/format";
import { Button, Card, cx, Modal, PageHeader, Spinner, StatusChip } from "../lib/ui";

interface PostRow {
  id: string;
  platform: string;
  status: string;
  angle: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
}
const PLATFORMS = ["tiktok", "youtube", "x", "reddit"];
const IST_OFFSET_MIN = 330;

/** IST calendar-day key (YYYY-MM-DD) of a UTC instant. */
function istDayKey(d: Date): string {
  const s = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return s.toISOString().slice(0, 10);
}

export function Calendar() {
  const [reslot, setReslot] = useState<PostRow | null>(null);
  const scheduled = useQuery({
    queryKey: ["cal", "scheduled"],
    queryFn: () => api<{ items: PostRow[] }>("/posts?status=scheduled&limit=200"),
  });
  const published = useQuery({
    queryKey: ["cal", "published"],
    queryFn: () => api<{ items: PostRow[] }>("/posts?status=published&limit=200"),
  });

  const days: string[] = [];
  for (let i = -1; i <= 6; i++) days.push(istDayKey(new Date(Date.now() + i * 86_400_000)));

  const all = [...(scheduled.data?.items ?? []), ...(published.data?.items ?? [])];
  const cell = (platform: string, day: string) =>
    all.filter((p) => {
      const when = p.scheduledFor ?? p.publishedAt;
      return p.platform === platform && when && istDayKey(new Date(when)) === day;
    });

  return (
    <div className="space-y-4">
      <PageHeader title="Calendar" />
      {scheduled.isLoading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[820px] text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
                <th className="p-2 text-left">platform</th>
                {days.map((d) => (
                  <th key={d} className="p-2 text-left font-medium">
                    {d.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PLATFORMS.map((pf) => (
                <tr key={pf} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="p-2 font-medium">{pf}</td>
                  {days.map((d) => (
                    <td key={d} className="min-w-[100px] p-1 align-top">
                      {cell(pf, d).map((p) => (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => p.status === "scheduled" && setReslot(p)}
                          className={cx(
                            "mb-1 block w-full rounded px-1.5 py-1 text-left",
                            p.status === "scheduled"
                              ? "cursor-pointer bg-sky-100 hover:bg-sky-200 dark:bg-sky-950 dark:hover:bg-sky-900"
                              : "bg-emerald-100 dark:bg-emerald-950",
                          )}
                          title={p.angle ?? ""}
                        >
                          <span className="tabular-nums">
                            {fmtTime(p.scheduledFor ?? p.publishedAt)}
                          </span>
                          <span className="block truncate text-[10px] text-zinc-500">
                            {p.angle}
                          </span>
                        </button>
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Card>
        <p className="text-xs text-zinc-500">
          Blue = scheduled (click to reslot) · green = published. Reslotting is validated against
          per-platform caps and the 3h gap; violations are rejected.
        </p>
      </Card>
      {reslot && <ReslotModal post={reslot} onClose={() => setReslot(null)} />}
    </div>
  );
}

function ReslotModal({ post, onClose }: { post: PostRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(() => {
    const d = post.scheduledFor ? new Date(post.scheduledFor) : new Date();
    // datetime-local wants local wall time; show IST wall time
    const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
    return ist.toISOString().slice(0, 16);
  });
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      // interpret the entered value as IST wall time → UTC
      const utc = new Date(new Date(`${value}:00Z`).getTime() - IST_OFFSET_MIN * 60_000);
      return api(`/posts/${post.id}`, {
        method: "PATCH",
        body: JSON.stringify({ scheduledFor: utc.toISOString() }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cal"] });
      onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "failed"),
  });

  return (
    <Modal title="Reslot post" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <StatusChip status={post.status} />
          <span className="text-zinc-500">{post.platform}</span>
        </div>
        <p className="text-zinc-500">{post.angle}</p>
        <label className="block text-xs text-zinc-500">
          New slot (IST)
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 block w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
        {err && <p className="text-xs text-red-500">{err}</p>}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            Save slot
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

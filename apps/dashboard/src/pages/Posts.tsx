// Posts list (doc 10 §3.3): filterable table with latest metrics; rows link to detail.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { useCategoryId } from "../lib/filters";
import { fmtCompact, fmtDateTime } from "../lib/format";
import {
  EmptyState,
  PageHeader,
  PlatformIcon,
  Spinner,
  StatusChip,
  Table,
  Td,
  Th,
} from "../lib/ui";

interface PostRow {
  id: string;
  platform: string;
  status: string;
  categorySlug: string | null;
  angle: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
}
const STATUSES = ["", "draft", "awaiting_approval", "approved", "scheduled", "published", "failed"];
const PLATFORMS = ["", "tiktok", "youtube", "x", "reddit"];

export function Posts() {
  const categoryId = useCategoryId();
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");
  const q = useQuery({
    queryKey: ["posts", categoryId, status, platform],
    queryFn: () => {
      const p = new URLSearchParams();
      if (categoryId) p.set("category", categoryId);
      if (status) p.set("status", status);
      if (platform) p.set("platform", platform);
      return api<{ items: PostRow[] }>(`/posts?${p.toString()}`);
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Posts"
        right={
          <div className="flex gap-2">
            <FilterSelect
              value={platform}
              onChange={setPlatform}
              options={PLATFORMS}
              label="platform"
            />
            <FilterSelect value={status} onChange={setStatus} options={STATUSES} label="status" />
          </div>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : !q.data || q.data.items.length === 0 ? (
        <EmptyState>No posts match.</EmptyState>
      ) : (
        <Table
          head={
            <tr>
              <Th>Platform</Th>
              <Th>Angle</Th>
              <Th>Status</Th>
              <Th>When</Th>
              <Th right>Views</Th>
              <Th right>Likes</Th>
              <Th right>Comments</Th>
            </tr>
          }
        >
          {q.data.items.map((p) => (
            <tr key={p.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              <Td>
                <PlatformIcon platform={p.platform} />
              </Td>
              <Td>
                <Link
                  to="/posts/$id"
                  params={{ id: p.id }}
                  className="text-sky-600 hover:underline"
                >
                  {p.angle ?? "(untitled)"}
                </Link>
              </Td>
              <Td>
                <StatusChip status={p.status} />
              </Td>
              <Td>{fmtDateTime(p.publishedAt ?? p.scheduledFor)}</Td>
              <Td right mono>
                {fmtCompact(p.views)}
              </Td>
              <Td right mono>
                {fmtCompact(p.likes)}
              </Td>
              <Td right mono>
                {fmtCompact(p.comments)}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o || `all ${label}`}
        </option>
      ))}
    </select>
  );
}

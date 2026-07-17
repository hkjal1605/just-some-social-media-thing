// Clip Studio: paste a public video URL → the render-only pipeline (ingest → transcribe →
// analyze → auto-promote top-N → render) finds the most viral-worthy moments and cuts them into
// vertical clips. Nothing here ever publishes; the list polls while any job is still in-flight.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../api";
import { fmtDateTime } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorNote,
  Modal,
  PageHeader,
  PlatformIcon,
  ProgressBar,
  SectionTitle,
  Spinner,
} from "../lib/ui";

type Platform = "tiktok" | "youtube" | "x" | "reddit";
type CaptionPreset = "hormozi" | "beast" | "clean";
type SocialPlatform = "youtube" | "tiktok" | "x";
type JobStatus =
  | "queued"
  | "ingesting"
  | "transcribing"
  | "transcribed"
  | "analyzed"
  | "rendering"
  | "ready"
  | "error";

interface ClipPost {
  platform: string;
  status: string;
  url: string | null;
}
interface Clip {
  briefId: string;
  status: string;
  platform: string;
  downloadUrl: string | null;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hook: string | null;
  scores: { hook: number; selfContained: number; emotion: number } | null;
  posts?: ClipPost[]; // absent on responses from an API that predates direct posting
}
interface Job {
  id: string;
  title: string;
  status: JobStatus;
  genre: string | null;
  sourceUrl: string | null;
  options: unknown;
  durationSec: number | null;
  createdAt: string;
  clips: Clip[];
}
/** Which platforms are postable via Buffer (GET /clip-jobs/social-targets). */
interface SocialTargets {
  youtube: boolean;
  tiktok: boolean;
  x: boolean;
}

const PLATFORMS: Platform[] = ["tiktok", "youtube", "x", "reddit"];
const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  reddit: "Reddit",
};

const CAPTION_PRESETS: { value: CaptionPreset; label: string; hint: string; swatch: string }[] = [
  {
    value: "hormozi",
    label: "Hormozi",
    hint: "Bold yellow keywords that punch through the noise",
    swatch: "bg-yellow-400",
  },
  {
    value: "beast",
    label: "Beast",
    hint: "MrBeast-style green highlight, high-energy pacing",
    swatch: "bg-emerald-500",
  },
  {
    value: "clean",
    label: "Clean",
    hint: "Minimal white captions, no highlight color",
    swatch: "bg-zinc-300 dark:bg-zinc-600",
  },
];

const GENRES = ["podcast", "sports", "racing", "comedy", "stage-talk", "tutorial"] as const;
const GENRE_LABEL: Record<(typeof GENRES)[number], string> = {
  podcast: "Podcast",
  sports: "Sports",
  racing: "Racing",
  comedy: "Comedy",
  "stage-talk": "Stage talk",
  tutorial: "Tutorial",
};

// Friendly copy + color-coding, keyed off the server's status ordering (doc: clip-jobs route).
const STATUS_ORDER: JobStatus[] = [
  "queued",
  "ingesting",
  "transcribing",
  "transcribed",
  "analyzed",
  "rendering",
  "ready",
];
const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued…",
  ingesting: "Ingesting video…",
  transcribing: "Transcribing…",
  transcribed: "Finding viral moments…",
  analyzed: "Finding viral moments…",
  rendering: "Rendering clips…",
  ready: "Ready",
  error: "Failed",
};
const STATUS_TONE: Record<JobStatus, "amber" | "sky" | "emerald" | "red"> = {
  queued: "amber",
  ingesting: "amber",
  transcribing: "amber",
  transcribed: "sky",
  analyzed: "sky",
  rendering: "sky",
  ready: "emerald",
  error: "red",
};
const TONE_CLASSES: Record<"amber" | "sky" | "emerald" | "red", string> = {
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  sky: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

function isTerminal(status: JobStatus): boolean {
  return status === "ready" || status === "error";
}

function progressRatio(status: JobStatus): number {
  if (status === "error") return 1;
  const idx = STATUS_ORDER.indexOf(status);
  return idx === -1 ? 0 : (idx + 1) / STATUS_ORDER.length;
}

/** True while any clip in the job has a post mid-flight — keeps the list polling for it. */
function hasPublishingPost(job: Job): boolean {
  return job.clips.some((clip) => (clip.posts ?? []).some((p) => p.status === "publishing"));
}

export function ClipStudio() {
  return (
    <div className="space-y-6">
      <PageHeader title="Clip Studio" />
      <div className="-mt-4 max-w-3xl space-y-1.5">
        <p className="text-sm text-zinc-500">
          Paste a YouTube link or a direct video URL — the system auto-finds the most viral-worthy
          moments and cuts them into ready-to-post vertical clips. Download them, then delete to
          free up R2 storage.
        </p>
        <p className="text-xs text-zinc-400">
          Everything known to boost virality — viral captions, safe-zone placement, silence
          trimming, speaker reframing, genre-aware selection, hooks & hashtags — is applied
          automatically. The form below only asks for the few genuine choices.
        </p>
      </div>
      <CreateJobForm />
      <JobsList />
    </div>
  );
}

function CreateJobForm() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [platforms, setPlatforms] = useState<Platform[]>(["tiktok", "youtube"]);
  const [topN, setTopN] = useState(3);
  const [captionPreset, setCaptionPreset] = useState<CaptionPreset>("hormozi");
  const [genre, setGenre] = useState("");
  const [maxLen, setMaxLen] = useState("");
  const [hookCard, setHookCard] = useState(false);
  const [captionMode, setCaptionMode] = useState<"auto" | "always" | "never">("auto");
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; status: string }>("/clip-jobs", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          platforms,
          topN,
          captionPreset,
          ...(genre ? { genre } : {}),
          ...(maxLen ? { maxLen: Number(maxLen) } : {}),
          ...(hookCard ? { hookCard: true } : {}),
          ...(captionMode !== "auto" ? { captionMode } : {}),
        }),
      }),
    onSuccess: () => {
      setErr(null);
      setUrl("");
      setTitle("");
      qc.invalidateQueries({ queryKey: ["clip-jobs"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Failed to start job."),
  });

  function togglePlatform(p: Platform) {
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (url.trim().length === 0 || platforms.length === 0 || create.isPending) return;
    create.mutate();
  }

  return (
    <Card>
      <SectionTitle>Generate clips from a video</SectionTitle>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Video URL</span>
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a YouTube link, or a direct video URL (…r2.dev/clip.mp4)"
              className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
          </label>

          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Title (optional)</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Defaults to the file name"
              className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
          </label>

          <div>
            <div className="mb-1 text-sm text-zinc-600 dark:text-zinc-400">Platforms</div>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <PlatformPill
                  key={p}
                  platform={p}
                  checked={platforms.includes(p)}
                  onToggle={() => togglePlatform(p)}
                />
              ))}
            </div>
            {platforms.length === 0 && (
              <p className="mt-1 text-xs text-red-500">Select at least one platform.</p>
            )}
          </div>

          <label className="block text-sm">
            <span className="mb-1 flex items-center justify-between text-zinc-600 dark:text-zinc-400">
              <span>Number of clips</span>
              <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                {topN}
              </span>
            </span>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
              className="mt-3 w-full accent-zinc-900 dark:accent-zinc-100"
            />
          </label>

          <div className="md:col-span-2">
            <div className="mb-1 text-sm text-zinc-600 dark:text-zinc-400">Caption style</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {CAPTION_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  onClick={() => setCaptionPreset(p.value)}
                  className={cx(
                    "rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                    captionPreset === p.value
                      ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800"
                      : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50",
                  )}
                >
                  <span className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                    <span className={cx("h-2.5 w-2.5 rounded-full", p.swatch)} />
                    {p.label}
                  </span>
                  <span className="mt-0.5 block text-zinc-500">{p.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Genre</span>
            <select
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            >
              <option value="">Auto-detect</option>
              {GENRES.map((g) => (
                <option key={g} value={g}>
                  {GENRE_LABEL[g]}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Max clip length (s)</span>
            <input
              type="number"
              min={15}
              max={90}
              value={maxLen}
              onChange={(e) => setMaxLen(e.target.value)}
              placeholder="auto"
              className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Captions</span>
            <select
              value={captionMode}
              onChange={(e) => setCaptionMode(e.target.value as "auto" | "always" | "never")}
              className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            >
              <option value="auto">Auto — skip if source already has subtitles</option>
              <option value="always">Always add my captions</option>
              <option value="never">Never add my captions</option>
            </select>
          </label>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={hookCard}
            onChange={(e) => setHookCard(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
          />
          <span>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              Bake a hook-card cover
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              Prepends a ~0.7s designed cover (best frame + text hook) so it shows as the cover on
              X, YouTube Shorts &amp; TikTok. Off = clips play straight; the best moment is still
              used for the TikTok cover and the downloadable thumbnail.
            </span>
          </span>
        </label>

        {err && <ErrorNote error={new Error(err)} />}

        <Button
          type="submit"
          disabled={create.isPending || url.trim().length === 0 || platforms.length === 0}
        >
          {create.isPending ? "Generating…" : "✨ Generate clips"}
        </Button>
      </form>
    </Card>
  );
}

function PlatformPill({
  platform,
  checked,
  onToggle,
}: {
  platform: Platform;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
        checked
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800",
      )}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} className="sr-only" />
      <PlatformIcon platform={platform} />
      {PLATFORM_LABEL[platform]}
    </label>
  );
}

function JobsList() {
  const jobsQuery = useQuery({
    queryKey: ["clip-jobs"],
    queryFn: () => api<{ items: Job[] }>("/clip-jobs"),
    refetchInterval: (query) =>
      query.state.data?.items.some((j) => !isTerminal(j.status) || hasPublishingPost(j))
        ? 4000
        : false,
  });

  return (
    <div className="space-y-4">
      <SectionTitle>Jobs</SectionTitle>
      {jobsQuery.isLoading ? (
        <Spinner />
      ) : jobsQuery.isError ? (
        <ErrorNote error={jobsQuery.error} />
      ) : !jobsQuery.data || jobsQuery.data.items.length === 0 ? (
        <EmptyState>No clip jobs yet — paste a video URL above to get started.</EmptyState>
      ) : (
        <div className="space-y-4">
          {jobsQuery.data.items.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ job }: { job: Job }) {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; deletedClips: number }>(`/clip-jobs/${job.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ["clip-jobs"] });
    },
    onError: (e) => setDelErr(e instanceof ApiError ? e.message : "Failed to delete."),
  });

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{job.title}</h3>
            <span
              className={cx(
                "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium",
                TONE_CLASSES[STATUS_TONE[job.status]],
              )}
            >
              {!isTerminal(job.status) && (
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {STATUS_LABEL[job.status]}
            </span>
          </div>
          <p className="mt-0.5 max-w-md truncate text-xs text-zinc-500" title={job.sourceUrl ?? ""}>
            {job.sourceUrl ?? "—"}
          </p>
          <p className="mt-0.5 text-xs text-zinc-400">
            {fmtDateTime(job.createdAt)}
            {job.genre && <> · {job.genre}</>}
            {job.durationSec != null && <> · {Math.round(job.durationSec)}s source</>}
          </p>
        </div>
        <span title="Delete from R2 — do this after downloading">
          <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
            Delete
          </Button>
        </span>
      </div>

      <div className="mt-3">
        <ProgressBar ratio={progressRatio(job.status)} tone={STATUS_TONE[job.status]} />
      </div>

      {job.clips.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {job.clips.map((clip) => (
            <ClipCard key={clip.briefId} clip={clip} jobId={job.id} />
          ))}
        </div>
      ) : job.status === "error" ? (
        <p className="mt-3 text-xs text-red-500">
          Something went wrong before any clips could be produced.
        </p>
      ) : null}

      {confirmOpen && (
        <Modal title="Delete video & clips?" onClose={() => setConfirmOpen(false)}>
          <div className="space-y-3 text-sm">
            <p>
              Delete this video and all its clips from R2? Download first — this can't be undone.
            </p>
            {delErr && <p className="text-xs text-red-500">{delErr}</p>}
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                onClick={() => del.mutate()}
                disabled={del.isPending}
              >
                {del.isPending ? "Deleting…" : "Delete permanently"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function ClipCard({ clip, jobId }: { clip: Clip; jobId: string }) {
  const ready = clip.status === "done" && !!clip.downloadUrl;
  const failed = clip.status === "failed";
  const targets = useSocialTargets();

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
        {ready && clip.thumbUrl ? (
          <img
            src={clip.thumbUrl}
            alt={clip.hook ?? "Clip thumbnail"}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center text-xs text-zinc-400">
            {failed ? (
              <span className="text-red-500">render failed</span>
            ) : (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
                rendering…
              </>
            )}
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-black/50 px-1 py-0.5 text-xs leading-none text-white">
          <PlatformIcon platform={clip.platform} />
        </span>
      </div>

      <div className="space-y-1.5 p-2">
        <p
          className="line-clamp-2 min-h-[2lh] text-xs font-medium text-zinc-700 dark:text-zinc-300"
          title={clip.hook ?? undefined}
        >
          {clip.hook ?? "—"}
        </p>

        {clip.scores && (
          <div className="flex flex-wrap gap-1">
            <Badge>Hook {clip.scores.hook}</Badge>
            <Badge>Self {clip.scores.selfContained}</Badge>
            <Badge>Emotion {clip.scores.emotion}</Badge>
          </div>
        )}

        <div className="flex items-center justify-between text-[11px] text-zinc-400">
          <span>{clip.durationSec != null ? `${Math.round(clip.durationSec)}s` : "—"}</span>
          <span>{clip.width && clip.height ? `${clip.width}×${clip.height}` : "1080×1920"}</span>
        </div>

        {ready && clip.downloadUrl ? (
          <a
            href={clip.downloadUrl}
            download
            className="block w-full rounded bg-zinc-900 px-2 py-1 text-center text-xs font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            ⬇ Download
          </a>
        ) : (
          <span className="block w-full cursor-not-allowed rounded bg-zinc-200 px-2 py-1 text-center text-xs font-medium text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600">
            {failed ? "unavailable" : "rendering…"}
          </span>
        )}

        {ready && (
          <div className="flex flex-wrap items-start gap-1.5 pt-0.5">
            <PostButton
              jobId={jobId}
              briefId={clip.briefId}
              platform="youtube"
              post={(clip.posts ?? []).find((p) => p.platform === "youtube")}
              connected={targets.data?.youtube ?? false}
            />
            <PostButton
              jobId={jobId}
              briefId={clip.briefId}
              platform="tiktok"
              post={(clip.posts ?? []).find((p) => p.platform === "tiktok")}
              connected={targets.data?.tiktok ?? false}
            />
            <PostButton
              jobId={jobId}
              briefId={clip.briefId}
              platform="x"
              post={(clip.posts ?? []).find((p) => p.platform === "x")}
              connected={targets.data?.x ?? false}
            />
          </div>
        )}
        {ready && (targets.data?.youtube || targets.data?.tiktok || targets.data?.x) && (
          <p className="text-[11px] leading-snug text-zinc-400">
            Posting is handled by Buffer — it publishes to each connected channel.
          </p>
        )}
      </div>
    </div>
  );
}

// GET /clip-jobs/social-targets: which platforms have a connected Buffer channel — drives whether a
// clip's Post button is clickable or disabled with a "connect it in Buffer" tooltip.
// Rarely changes, so no refetchInterval; React Query dedupes this across every ClipCard on screen.
function useSocialTargets() {
  return useQuery({
    queryKey: ["social-targets"],
    queryFn: () => api<SocialTargets>("/clip-jobs/social-targets"),
  });
}

// One per platform, per clip. Renders off `clip.posts` (server truth) plus its own mutation's
// pending/err state — same local-err convention as the other mutations in this file.
function PostButton({
  jobId,
  briefId,
  platform,
  post,
  connected,
}: {
  jobId: string;
  briefId: string;
  platform: SocialPlatform;
  post: ClipPost | undefined;
  connected: boolean;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const label = PLATFORM_LABEL[platform];

  const publish = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>(`/clip-jobs/${jobId}/clips/${briefId}/publish`, {
        method: "POST",
        body: JSON.stringify({ platforms: [platform] }),
      }),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["clip-jobs"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : `Couldn't post to ${label}.`),
  });

  if (post?.status === "published") {
    const pill = <Badge tone="emerald">Posted ✓</Badge>;
    return post.url ? (
      <a href={post.url} target="_blank" rel="noreferrer" className="hover:opacity-80">
        {pill}
      </a>
    ) : (
      pill
    );
  }

  if (publish.isPending || post?.status === "publishing") {
    return (
      <Button size="sm" variant="ghost" disabled>
        <span className="mr-1.5 h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Posting…
      </Button>
    );
  }

  if (post?.status === "failed") {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <Button size="sm" variant="danger" onClick={() => publish.mutate()}>
          Failed — retry
        </Button>
        {err && <span className="text-[11px] text-red-500">{err}</span>}
      </div>
    );
  }

  const trigger = (
    <Button size="sm" variant="ghost" disabled={!connected} onClick={() => publish.mutate()}>
      <PlatformIcon platform={platform} /> Post to {label}
    </Button>
  );

  return (
    <div className="flex flex-col items-start gap-0.5">
      {connected ? (
        trigger
      ) : (
        <span title={`Connect ${label} in Buffer to enable posting`}>{trigger}</span>
      )}
      {err && <span className="text-[11px] text-red-500">{err}</span>}
    </div>
  );
}

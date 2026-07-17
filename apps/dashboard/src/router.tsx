// Shell + routes (doc 10 §2). Authed layout with sidebar, kill-switch banner, category filter.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { CategoryProvider, CategorySelect } from "./lib/filters";
import { Approvals } from "./pages/Approvals";
import { Calendar } from "./pages/Calendar";
import { ClipStudio } from "./pages/ClipStudio";
import { Clips } from "./pages/Clips";
import { Costs } from "./pages/Costs";
import { Overview } from "./pages/Overview";
import { Playbooks } from "./pages/Playbooks";
import { PostDetail } from "./pages/PostDetail";
import { Posts } from "./pages/Posts";
import { Settings } from "./pages/Settings";
import { Trends } from "./pages/Trends";

const NAV: [string, string][] = [
  ["/", "Overview"],
  ["/clip-studio", "Clip Studio"],
  ["/trends", "Trends"],
  ["/posts", "Posts"],
  ["/approvals", "Approvals"],
  ["/calendar", "Calendar"],
  ["/clips", "Clips"],
  ["/playbooks", "Playbooks"],
  ["/costs", "Costs"],
  ["/settings", "Settings"],
];

function RootLayout() {
  return (
    <CategoryProvider>
      <Outlet />
    </CategoryProvider>
  );
}
const rootRoute = createRootRoute({ component: RootLayout });

function KillBanner() {
  const q = useQuery({
    queryKey: ["kill-banner"],
    queryFn: () => api<{ on: boolean }>("/settings/kill-switch"),
    refetchInterval: 30_000,
  });
  if (!q.data?.on) return null;
  return (
    <Link
      to="/settings"
      className="block bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white"
    >
      🔴 Kill-switch is ON — publishing, factory & replies are paused. Open Settings →
    </Link>
  );
}

function Shell() {
  const navigate = useNavigate();
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ username: string }>("/auth/me"),
    retry: false,
  });
  useEffect(() => {
    if (me.isError && me.error instanceof ApiError && me.error.status === 401) {
      void navigate({ to: "/login" });
    }
  }, [me.isError, me.error, navigate]);

  const [approvalsCount, setApprovalsCount] = useState(0);
  const pending = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api<{ items: unknown[] }>("/approvals?status=pending"),
    refetchInterval: 15_000,
  });
  useEffect(() => {
    if (pending.data) setApprovalsCount(pending.data.items.length);
  }, [pending.data]);

  if (me.isError) return null;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <KillBanner />
      <div className="flex flex-1">
        <aside className="w-52 shrink-0 border-r border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-6 font-semibold tracking-tight">⚡ Viral Engine</div>
          <nav className="space-y-1 text-sm">
            {NAV.map(([to, label]) => (
              <Link
                key={to}
                to={to}
                className="flex items-center justify-between rounded px-2 py-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900 [&.active]:bg-zinc-100 [&.active]:font-medium [&.active]:text-zinc-900 dark:[&.active]:bg-zinc-900 dark:[&.active]:text-zinc-100"
                activeOptions={{ exact: to === "/" }}
              >
                {label}
                {label === "Approvals" && approvalsCount > 0 && (
                  <span className="rounded-full bg-amber-500 px-1.5 text-xs text-white">
                    {approvalsCount}
                  </span>
                )}
              </Link>
            ))}
          </nav>
          <button
            type="button"
            onClick={async () => {
              await api("/auth/logout", { method: "POST" }).catch(() => {});
              void navigate({ to: "/login" });
            }}
            className="mt-6 text-xs text-zinc-400 hover:text-zinc-600"
          >
            sign out ({me.data?.username})
          </button>
        </aside>
        <main className="flex-1 p-6">
          <div className="mb-4 flex justify-end">
            <CategorySelect />
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  component: Shell,
});
// literal `path` strings are required for TanStack Router's typed <Link to> inference
const parent = () => authedRoute;
const indexRoute = createRoute({ getParentRoute: parent, path: "/", component: Overview });
const clipStudioRoute = createRoute({
  getParentRoute: parent,
  path: "/clip-studio",
  component: ClipStudio,
});
const trendsRoute = createRoute({ getParentRoute: parent, path: "/trends", component: Trends });
const postsRoute = createRoute({ getParentRoute: parent, path: "/posts", component: Posts });
const postDetailRoute = createRoute({
  getParentRoute: parent,
  path: "/posts/$id",
  component: PostDetail,
});
const approvalsRoute = createRoute({
  getParentRoute: parent,
  path: "/approvals",
  component: Approvals,
});
const calendarRoute = createRoute({
  getParentRoute: parent,
  path: "/calendar",
  component: Calendar,
});
const clipsRoute = createRoute({ getParentRoute: parent, path: "/clips", component: Clips });
const playbooksRoute = createRoute({
  getParentRoute: parent,
  path: "/playbooks",
  component: Playbooks,
});
const costsRoute = createRoute({ getParentRoute: parent, path: "/costs", component: Costs });
const settingsRoute = createRoute({
  getParentRoute: parent,
  path: "/settings",
  component: Settings,
});

function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      // clear the cached ["auth","me"] 401 from before login — otherwise the Shell re-reads that
      // stale error on mount and bounces straight back to /login before the refetch resolves (H11)
      await queryClient.refetchQueries({ queryKey: ["auth", "me"] });
      void navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <form
        onSubmit={submit}
        className="w-80 space-y-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h1 className="text-lg font-semibold">⚡ Viral Engine</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="admin password"
          className="w-full rounded border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="w-full rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? "signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    authedRoute.addChildren([
      indexRoute,
      clipStudioRoute,
      trendsRoute,
      postsRoute,
      postDetailRoute,
      approvalsRoute,
      calendarRoute,
      clipsRoute,
      playbooksRoute,
      costsRoute,
      settingsRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

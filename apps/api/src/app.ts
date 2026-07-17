// Hono app assembly (doc 11 §1) — exported without Bun.serve so tests can app.request().
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { type AuthedEnv, authRoutes, eitherAuth } from "./auth";
import { healthz } from "./healthz";
import { approvalsRoutes } from "./routes/approvals";
import { briefsRoutes } from "./routes/briefs";
import { campaignClipsRoutes, campaignsRoutes } from "./routes/campaigns";
import { categoriesRoutes, sourcesRoutes } from "./routes/categories";
import { clipJobsRoutes } from "./routes/clip-jobs";
import { costsRoutes } from "./routes/costs";
import { assetsRoutes, dashboardRoutes } from "./routes/dashboard";
import { engagementsRoutes } from "./routes/engagements";
import { clipCandidatesRoutes, longformsRoutes } from "./routes/longforms";
import { opsRoutes } from "./routes/ops";
import { playbooksRoutes } from "./routes/playbooks";
import { postsRoutes } from "./routes/posts";
import { settingsRoutes } from "./routes/settings";
import { trendsRoutes } from "./routes/trends";

const log = makeLogger("api");

export const apiV1 = new Hono<AuthedEnv>()
  .route("/auth", authRoutes)
  // everything below requires session or bearer token (doc 11 §2)
  .use("*", eitherAuth)
  .get("/ping", (c) => c.json({ ok: true, admin: c.get("admin").username }))
  .route("/dashboard", dashboardRoutes)
  .route("/trends", trendsRoutes)
  .route("/briefs", briefsRoutes)
  .route("/approvals", approvalsRoutes)
  .route("/posts", postsRoutes)
  .route("/engagements", engagementsRoutes)
  .route("/longforms", longformsRoutes)
  .route("/clip-candidates", clipCandidatesRoutes)
  .route("/clip-jobs", clipJobsRoutes)
  .route("/campaigns", campaignsRoutes)
  .route("/campaign-clips", campaignClipsRoutes)
  .route("/playbooks", playbooksRoutes)
  .route("/costs", costsRoutes)
  .route("/categories", categoriesRoutes)
  .route("/sources", sourcesRoutes)
  .route("/assets", assetsRoutes)
  // harness observability + safety rails (doc 08 §6/§10)
  .route("/ops", opsRoutes)
  .route("/settings", settingsRoutes);
// Remaining distribution/learning routes land with docs 06–11.

export const app = new Hono()
  .use("*", requestId())
  .use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    log.debug(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - t0),
      },
      "request",
    );
  })
  .use(
    "/api/*",
    cors({
      origin: env.APP_ENV === "development" ? "http://localhost:5173" : env.APP_BASE_URL,
      credentials: true,
    }),
  )
  .route("/api/v1", apiV1)
  .get("/healthz", healthz);

export type ApiV1 = typeof apiV1;

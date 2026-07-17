// apps/api entrypoint — serves the app + static dashboard in prod (doc 11 §1).
// HTTP only: routes validate, call @ve/db, enqueue jobs. Never runs jobs.
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";
import { startSendOnly } from "@ve/db";
import { serveStatic } from "hono/bun";
import { app } from "./app";

const log = makeLogger("api");

// prod: serve the dashboard build + SPA fallback (doc 11 §1)
if (env.APP_ENV === "production") {
  app.use("*", serveStatic({ root: "./apps/dashboard/dist" }));
  app.get("*", serveStatic({ path: "./apps/dashboard/dist/index.html" }));
}

const server = Bun.serve({ port: env.API_PORT, fetch: app.fetch });
await startSendOnly(); // enqueue-only pg-boss (doc 03 §3)
log.info({ port: server.port, env: env.APP_ENV }, "api listening");

const shutdown = () => {
  log.info("api shutting down");
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

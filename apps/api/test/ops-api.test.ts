// Ops + settings API routes (doc 08 §6/§10) via in-process app.request(): the observability
// summary, the recent-jobs read, and the kill-switch toggle (which also fires a TG alert).
import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { getSetting, runMigrations, seed, setSetting, sqlClient } from "@ve/db";
import { app } from "../src/app";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("ops-api.test: postgres unreachable — suite skipped");
if (reachable) {
  await runMigrations();
  await seed();
}

const bearer = {
  authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
  "content-type": "application/json",
};

describe("GET /ops/summary (doc 08 §10)", () => {
  t("requires auth", async () => {
    const res = await app.request("/api/v1/ops/summary");
    expect(res.status).toBe(401);
  });

  t("returns the harness health snapshot", async () => {
    const res = await app.request("/api/v1/ops/summary", { headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      killSwitch: boolean;
      workersStale: boolean;
      pendingApprovals: number;
      postsToday: number;
      dlqCount: number;
      spendMtd: number;
      queues: unknown[];
      schedules: unknown[];
    };
    expect(typeof body.killSwitch).toBe("boolean");
    expect(typeof body.workersStale).toBe("boolean");
    expect(typeof body.pendingApprovals).toBe("number");
    expect(typeof body.postsToday).toBe("number");
    expect(typeof body.dlqCount).toBe("number");
    expect(typeof body.spendMtd).toBe("number");
    expect(Array.isArray(body.queues)).toBe(true);
    expect(Array.isArray(body.schedules)).toBe(true);
  });
});

describe("GET /ops/jobs (doc 08 §10)", () => {
  t("returns a jobs list (empty or populated), auth-gated", async () => {
    const unauth = await app.request("/api/v1/ops/jobs");
    expect(unauth.status).toBe(401);

    const res = await app.request("/api/v1/ops/jobs?state=failed&limit=10", { headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  t("rejects an invalid state filter", async () => {
    const res = await app.request("/api/v1/ops/jobs?state=bogus", { headers: bearer });
    expect(res.status).toBe(400);
  });
});

describe("PUT /settings/kill-switch (doc 08 §6)", () => {
  t("flips the kill-switch on then off, and GET reflects it", async () => {
    const on = await app.request("/api/v1/settings/kill-switch", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ on: true, reason: "ops-api-test" }),
    });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { killSwitch: boolean }).killSwitch).toBe(true);
    expect(await getSetting<boolean>("kill_switch")).toBe(true);

    const read = await app.request("/api/v1/settings/kill-switch", { headers: bearer });
    expect(((await read.json()) as { on: boolean }).on).toBe(true);

    const off = await app.request("/api/v1/settings/kill-switch", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ on: false }),
    });
    expect(off.status).toBe(200);
    expect(await getSetting<boolean>("kill_switch")).toBe(false);
  });

  t("rejects a malformed body", async () => {
    const res = await app.request("/api/v1/settings/kill-switch", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ reason: "no on field" }),
    });
    expect(res.status).toBe(400);
    await setSetting("kill_switch", false); // ensure the shared DB ends clean
  });
});

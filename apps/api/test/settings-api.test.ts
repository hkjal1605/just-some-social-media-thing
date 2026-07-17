// Settings + Categories + Sources + dashboard/kpis + assets/presign (doc 11 §3, doc 10 §3.1/§3.9).
import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { newId } from "@ve/core";
import { categories, db, eq, runMigrations, seed, sources, sqlClient } from "@ve/db";
import { app } from "../src/app";

let reachable = true;
try {
  await sqlClient.unsafe("select 1");
} catch {
  reachable = false;
}
const t = reachable ? test : test.skip;
if (!reachable) console.warn("settings-api.test: postgres unreachable — suite skipped");
if (reachable) {
  await runMigrations();
  await seed();
}

const run = newId().slice(-8);
const bearer = {
  authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
  "content-type": "application/json",
};

describe("dashboard + assets (doc 10 §3.1)", () => {
  t("GET /dashboard/kpis returns the KPI bundle", async () => {
    const res = await app.request("/api/v1/dashboard/kpis", { headers: bearer });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { posts7d: number; views7d: number; spendMtd: number };
    expect(typeof b.posts7d).toBe("number");
    expect(typeof b.views7d).toBe("number");
    expect(typeof b.spendMtd).toBe("number");
  });

  t("GET /dashboard/timeseries returns viewsByDay + postsByDay arrays", async () => {
    const res = await app.request("/api/v1/dashboard/timeseries?days=14", { headers: bearer });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { viewsByDay: unknown[]; postsByDay: unknown[] };
    expect(Array.isArray(b.viewsByDay)).toBe(true);
    expect(Array.isArray(b.postsByDay)).toBe(true);
  });

  t("assets/presign: known prefix → url; unknown → 403", async () => {
    const ok = await app.request("/api/v1/assets/presign?key=renders/a/b_tiktok.mp4", {
      headers: bearer,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { url: string }).url.length).toBeGreaterThan(0);

    const bad = await app.request("/api/v1/assets/presign?key=secret/passwords.txt", {
      headers: bearer,
    });
    expect(bad.status).toBe(403);
  });
});

describe("settings whitelist (doc 11 §3)", () => {
  t("GET returns whitelisted keys + killSwitch + integrations", async () => {
    const res = await app.request("/api/v1/settings", { headers: bearer });
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      settings: Record<string, unknown>;
      killSwitch: boolean;
      integrations: Record<string, boolean>;
    };
    expect(typeof b.killSwitch).toBe("boolean");
    expect(b.settings).toHaveProperty("posting_windows"); // seeded
    expect(typeof b.integrations).toBe("object");
  });

  t("PUT whitelisted key ok; kill_switch + bogus key → 403", async () => {
    const ok = await app.request("/api/v1/settings/x_monthly_read_cap_usd", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ value: 90 }),
    });
    expect(ok.status).toBe(200);

    const killDirect = await app.request("/api/v1/settings/kill_switch", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ value: true }),
    });
    expect(killDirect.status).toBe(403);

    const bogus = await app.request("/api/v1/settings/some_random_key", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ value: 1 }),
    });
    expect(bogus.status).toBe(403);
  });

  t(
    "PUT validates the value per key — a bad posting_windows is rejected, not persisted (M1)",
    async () => {
      const good = {
        tiktok: [{ days: ["*"], start: "19:00", end: "23:00" }],
        youtube: [],
        x: [],
        reddit: [],
      };
      const okRes = await app.request("/api/v1/settings/posting_windows", {
        method: "PUT",
        headers: bearer,
        body: JSON.stringify({ value: good }),
      });
      expect(okRes.status).toBe(200);

      // a typo like "7pm" would later throw in the scheduler's parseHhMm and DLQ publish.plan —
      // it must be refused at the write boundary with 422
      const badTime = await app.request("/api/v1/settings/posting_windows", {
        method: "PUT",
        headers: bearer,
        body: JSON.stringify({
          value: { ...good, tiktok: [{ days: ["*"], start: "7pm", end: "23:00" }] },
        }),
      });
      expect(badTime.status).toBe(422);

      // wrong shape (object instead of array) → 422, not silently stored
      const badShape = await app.request("/api/v1/settings/x_monthly_read_cap_usd", {
        method: "PUT",
        headers: bearer,
        body: JSON.stringify({ value: "lots" }),
      });
      expect(badShape.status).toBe(422);
    },
  );
});

describe("categories + sources CRUD (doc 10 §3.9)", () => {
  t("category create → patch → delete guards", async () => {
    const slug = `set-cat-${run}`;
    const created = await app.request("/api/v1/categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ slug, name: "Set Cat", mode: "human_gated" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const patch = await app.request(`/api/v1/categories/${id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ autoApproveFormats: ["faceless-explainer-60s"], active: false }),
    });
    expect(patch.status).toBe(200);
    const [cat] = await db.select().from(categories).where(eq(categories.id, id));
    expect(((cat?.autoApproveFormats ?? []) as string[]).includes("faceless-explainer-60s")).toBe(
      true,
    );
    expect(cat?.active).toBe(false);

    // add a source → delete now refuses (has dependencies)
    const src = await app.request("/api/v1/sources", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        categoryId: id,
        platform: "reddit",
        kind: "subreddit",
        value: "r/test",
      }),
    });
    expect(src.status).toBe(201);
    const { id: srcId } = (await src.json()) as { id: string };

    const delBlocked = await app.request(`/api/v1/categories/${id}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(delBlocked.status).toBe(422);

    // scout-now enqueues, patch the source, then delete it, then the category is deletable
    const scout = await app.request(`/api/v1/sources/${srcId}/scout`, {
      method: "POST",
      headers: bearer,
    });
    expect(scout.status).toBe(200);

    const patchSrc = await app.request(`/api/v1/sources/${srcId}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ active: false, scoutIntervalMin: 120 }),
    });
    expect(patchSrc.status).toBe(200);

    const delSrc = await app.request(`/api/v1/sources/${srcId}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(delSrc.status).toBe(200);
    expect((await db.select().from(sources).where(eq(sources.id, srcId))).length).toBe(0);

    const delCat = await app.request(`/api/v1/categories/${id}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(delCat.status).toBe(200);
  });

  t("list categories includes the seeds", async () => {
    const res = await app.request("/api/v1/categories", { headers: bearer });
    const items = ((await res.json()) as { items: { slug: string }[] }).items;
    expect(items.some((x) => x.slug === "ai-tech")).toBe(true);
    expect(items.some((x) => x.slug === "music")).toBe(true);
  });
});

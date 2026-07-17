// Harness ops pure-logic tests (doc 08 §1/§7/§8): budget guard math, policy html→text/hash,
// approval remind decision, per-queue concurrency, and the registerWorker teamSize mechanism.
// No DB, no network.
import { describe, expect, test } from "bun:test";
import {
  concurrencyFor,
  decideBudget,
  EmptyPayload,
  RadarScorePayload,
  ScoutPayload,
} from "@ve/core";
import type PgBoss from "pg-boss";
import { remindDecision } from "../src/engines/approvals/remind";
import { utcMonth } from "../src/engines/ops/costs-rollup";
import { extractForDiff, htmlToText, sha256Hex } from "../src/engines/ops/policy-watch";
import { registerWorker } from "../src/harness";

describe("budget guard (doc 08 §7) — pure decideBudget", () => {
  const base = { budgetUsd: 150, byService: [], nowIso: "2026-07-13T00:00:00Z" };

  test("below 80% is ok, no alerts", () => {
    const r = decideBudget({ prev: null, month: "2026-07", monthUsd: 50, ...base });
    expect(r.warn).toBe(false);
    expect(r.kill).toBe(false);
    expect(r.next.level).toBe("ok");
    expect(r.next.ratio).toBeCloseTo(50 / 150, 6);
  });

  test("80% crossing warns exactly once; kill fires at 100% exactly once; month rollover resets", () => {
    // 85% → first warn
    const warn = decideBudget({ prev: null, month: "2026-07", monthUsd: 127.5, ...base });
    expect(warn.warn).toBe(true);
    expect(warn.kill).toBe(false);
    expect(warn.next.level).toBe("warn");
    expect(warn.next.warnedAt).toBe("2026-07-13T00:00:00Z");

    // same month, already warned → silent
    const warn2 = decideBudget({ prev: warn.next, month: "2026-07", monthUsd: 140, ...base });
    expect(warn2.warn).toBe(false);
    expect(warn2.next.warnedAt).toBe("2026-07-13T00:00:00Z");

    // 100%+ → kill once (no repeat warn since warnedAt persists)
    const kill = decideBudget({ prev: warn.next, month: "2026-07", monthUsd: 160, ...base });
    expect(kill.kill).toBe(true);
    expect(kill.warn).toBe(false);
    expect(kill.next.level).toBe("kill");
    expect(kill.next.killedAt).toBe("2026-07-13T00:00:00Z");

    // same month, already killed → silent
    const kill2 = decideBudget({ prev: kill.next, month: "2026-07", monthUsd: 300, ...base });
    expect(kill2.kill).toBe(false);

    // next month → markers reset, warn fires again, kill marker cleared
    const next = decideBudget({
      prev: kill.next,
      month: "2026-08",
      monthUsd: 130,
      budgetUsd: 150,
      byService: [],
      nowIso: "2026-08-01T00:00:00Z",
    });
    expect(next.warn).toBe(true);
    expect(next.next.warnedAt).toBe("2026-08-01T00:00:00Z");
    expect(next.next.killedAt).toBeNull();
  });

  test("zero budget never divides by zero", () => {
    const r = decideBudget({
      prev: null,
      month: "2026-07",
      monthUsd: 10,
      budgetUsd: 0,
      byService: [],
      nowIso: "x",
    });
    expect(r.next.ratio).toBe(0);
    expect(r.warn).toBe(false);
    expect(r.kill).toBe(false);
  });

  test("byService lines are carried into the persisted state", () => {
    const r = decideBudget({
      prev: null,
      month: "2026-07",
      monthUsd: 3,
      budgetUsd: 150,
      byService: [{ service: "anthropic", kind: "llm", costUsd: 3 }],
      nowIso: "2026-07-13T00:00:00Z",
    });
    expect(r.next.byService).toEqual([{ service: "anthropic", kind: "llm", costUsd: 3 }]);
  });

  test("utcMonth is UTC YYYY-MM at boundaries", () => {
    expect(utcMonth(new Date("2026-07-13T23:30:00Z"))).toBe("2026-07");
    expect(utcMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(utcMonth(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
});

describe("policy.watch (doc 08 §8) — pure text helpers", () => {
  test("htmlToText strips scripts/styles/comments/tags and decodes entities", () => {
    const html =
      "<html><head><style>.a{color:red}</style><script>var x=1<2;</script></head>" +
      "<body><!-- hi --><h1>Rewards</h1><p>Need&nbsp;61s &amp; AI&#39;s label</p></body></html>";
    const text = htmlToText(html);
    expect(text).toBe("Rewards Need 61s & AI's label");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var x");
  });

  test("sha256Hex is stable, 64 hex chars, and changes when text changes", () => {
    expect(sha256Hex("policy body")).toBe(sha256Hex("policy body"));
    expect(sha256Hex("policy body")).toHaveLength(64);
    expect(sha256Hex("policy body")).not.toBe(sha256Hex("policy body!"));
  });

  test("extractForDiff caps each extract length", () => {
    expect(extractForDiff("x".repeat(10_000)).length).toBe(8000);
    expect(extractForDiff("short")).toBe("short");
    expect(extractForDiff("abcdef", 3)).toBe("abc");
  });
});

describe("approval.remind (doc 09 §1) — pure remindDecision", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  const at = (iso: string) => new Date(iso);

  test("no action while >4h remains", () => {
    expect(
      remindDecision({
        expiresAt: at("2026-07-13T20:00:00Z"),
        hasReminded: false,
        hasRenewed: false,
        trendHot: true,
        now,
      }),
    ).toBe("none");
  });

  test("remind once inside the 4h window", () => {
    const args = {
      expiresAt: at("2026-07-13T15:00:00Z"),
      hasRenewed: false,
      trendHot: false,
      now,
    };
    expect(remindDecision({ ...args, hasReminded: false })).toBe("remind");
    expect(remindDecision({ ...args, hasReminded: true })).toBe("none");
  });

  test("past TTL: expire when cold, renew once when hot", () => {
    const expired = {
      expiresAt: at("2026-07-13T11:00:00Z"),
      hasReminded: true,
      now,
    };
    expect(remindDecision({ ...expired, hasRenewed: false, trendHot: false })).toBe("expire");
    expect(remindDecision({ ...expired, hasRenewed: false, trendHot: true })).toBe("renew");
    // already renewed once → expire even if still hot
    expect(remindDecision({ ...expired, hasRenewed: true, trendHot: true })).toBe("expire");
  });
});

describe("teamSize (doc 08 §1) — registerWorker registers N single-job workers", () => {
  function fakeBoss() {
    const calls: { queue: string; opts: PgBoss.WorkOptions }[] = [];
    const handlers: PgBoss.WorkHandler<object>[] = [];
    const boss = {
      work: async (
        queue: string,
        opts: PgBoss.WorkOptions,
        handler: PgBoss.WorkHandler<object>,
      ) => {
        calls.push({ queue, opts });
        handlers.push(handler);
        return `worker-${calls.length}`;
      },
      send: async () => "job-id",
    } as unknown as PgBoss;
    return { boss, calls, handlers };
  }

  test("concurrencyFor maps the doc 08 §1 team sizes", () => {
    expect(concurrencyFor("factory.render")).toBe(1); // CPU guard
    expect(concurrencyFor("alert.telegram")).toBe(1); // serial dedupe
    expect(concurrencyFor("scout.reddit")).toBe(4);
    expect(concurrencyFor("scout.tiktok")).toBe(4);
    expect(concurrencyFor("metrics.snapshot")).toBe(4);
    expect(concurrencyFor("publish.execute")).toBe(2);
    expect(concurrencyFor("publish.plan")).toBe(2);
    expect(concurrencyFor("radar.score")).toBe(3); // llm-agent default
    expect(concurrencyFor("factory.script")).toBe(3);
  });

  test("render registers 1 worker, scouts register 4, all single-job batches", async () => {
    const { boss, calls } = fakeBoss();
    await registerWorker(boss, "factory.render", EmptyPayload, async () => {});
    expect(calls.length).toBe(1);

    calls.length = 0;
    await registerWorker(boss, "scout.reddit", ScoutPayload, async () => {});
    expect(calls.length).toBe(4);
    expect(calls.every((c) => c.opts.batchSize === 1 && c.opts.includeMetadata === true)).toBe(
      true,
    );
  });

  test("explicit concurrency override wins", async () => {
    const { boss, calls } = fakeBoss();
    await registerWorker(boss, "radar.score", RadarScorePayload, async () => {}, {
      concurrency: 7,
    });
    expect(calls.length).toBe(7);
  });

  test("the registered handler parses payload and runs fn for a non-blocked queue", async () => {
    const { boss, handlers } = fakeBoss();
    let ran = 0;
    let seen: unknown;
    await registerWorker(
      boss,
      "radar.digest", // not kill-switch-blocked → no getSetting/DB touch
      EmptyPayload,
      async (data) => {
        ran++;
        seen = data;
      },
      { concurrency: 1 },
    );
    const job = {
      id: "j1",
      data: {},
      retryCount: 0,
      retryLimit: 3,
    } as unknown as PgBoss.JobWithMetadata<object>;
    await handlers[0]?.([job]);
    expect(ran).toBe(1);
    expect(seen).toEqual({});
  });
});

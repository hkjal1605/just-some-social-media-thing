// External bindings for the ops engine (doc 08 §7/§8). policy.watch fetches public policy
// pages and diffs them with the policy-differ agent; costs.rollup needs none of this.
// Overridable so tests never hit the network or a real LLM (doc 13 §2).
import { runStructured } from "@ve/llm";

export interface PolicyFetchResult {
  ok: boolean;
  status: number;
  text: string;
}

export interface OpsDeps {
  /** Plain GET with a browser-ish UA (doc 08 §8). Resolves even on failure — never throws. */
  fetchPolicy: (url: string) => Promise<PolicyFetchResult>;
  runStructured: typeof runStructured;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 viral-engine-policy-watch";

async function defaultFetchPolicy(url: string): Promise<PolicyFetchResult> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, text };
  } catch {
    // network error / timeout / DNS ⇒ treated as fetch_blocked by the handler
    return { ok: false, status: 0, text: "" };
  }
}

export const opsDeps: OpsDeps = {
  fetchPolicy: defaultFetchPolicy,
  runStructured,
};

export function setOpsDeps(overrides: Partial<OpsDeps>): void {
  Object.assign(opsDeps, overrides);
}

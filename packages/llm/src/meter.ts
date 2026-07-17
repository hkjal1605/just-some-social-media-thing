// Best-effort metering: a metering failure must never fail the model call itself.
import { makeLogger } from "@ve/core";
import { type AgentRunInput, type LlmUsageInput, recordAgentRun, recordLlmUsage } from "@ve/db";

const log = makeLogger("llm-meter");

export async function meterLlm(u: LlmUsageInput): Promise<void> {
  try {
    await recordLlmUsage(u);
  } catch (err) {
    log.warn({ err, purpose: u.purpose }, "llm_usage write failed (metering is best-effort)");
  }
}

export async function meterAgentRun(r: AgentRunInput): Promise<void> {
  try {
    await recordAgentRun(r);
  } catch (err) {
    log.warn({ err, agent: r.agent }, "agent_runs write failed (metering is best-effort)");
  }
}

/** Exponential backoff for provider 429/5xx (doc 03 §5: 3 attempts then throw). */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; isRetryable?: (err: unknown) => boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const retryable =
    opts.isRetryable ??
    ((err: unknown) => {
      const status = (err as { status?: number }).status;
      return status === 429 || (status !== undefined && status >= 500);
    });
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !retryable(err)) throw err;
      const delay = base * 2 ** i + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

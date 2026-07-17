// Static price table (doc 03 §5). Update alongside provider changes —
// policy.watch also monitors pricing pages. Unknown models cost 0 and log a warning.
import { makeLogger } from "@ve/core";

const log = makeLogger("llm-prices");

export interface TokenPrice {
  inPerMTok: number; // USD per 1M input tokens
  outPerMTok: number; // USD per 1M output tokens
}

export interface UnitPrice {
  perMinuteUsd: number;
}

// Everything runs through OpenRouter, which returns the exact per-call cost (usage.include) that the
// meter prefers — these tables are only the fallback. Estimates; verify at openrouter.ai/models.
export const TOKEN_PRICES: Record<string, Record<string, TokenPrice>> = {
  openrouter: {
    "deepseek/deepseek-v4-flash": { inPerMTok: 0.11, outPerMTok: 0.22 }, // text agents (current default)
    "deepseek/deepseek-v4-pro": { inPerMTok: 0.3, outPerMTok: 1.2 }, // text agents (pricier, unused now)
    "openai/text-embedding-3-small": { inPerMTok: 0.02, outPerMTok: 0 }, // embeddings
    // image output is billed as tokens (~$0.039 per ~1290-token image)
    "google/gemini-2.5-flash-image": { inPerMTok: 0.3, outPerMTok: 30 },
  },
  gemini: {
    // native Gemini (estimates; verify at ai.google.dev/pricing)
    "gemini-3.5-flash": { inPerMTok: 0.3, outPerMTok: 2.5 }, // clip video understanding (video tokens on input)
    "gemini-3.1-flash-tts-preview": { inPerMTok: 0.5, outPerMTok: 10 }, // TTS — audio output billed as tokens
  },
};

export const UNIT_PRICES: Record<string, Record<string, UnitPrice>> = {
  openrouter: {
    "openai/whisper-large-v3-turbo": { perMinuteUsd: 0.04 / 60 }, // transcription (~$0.04/hr)
  },
};

const warned = new Set<string>();
function warnOnce(key: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn({ key }, "no price entry — costing 0; update packages/llm/src/prices.ts");
}

export function tokenCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = TOKEN_PRICES[provider]?.[model];
  if (!p) {
    warnOnce(`${provider}/${model}`);
    return 0;
  }
  return (inputTokens / 1_000_000) * p.inPerMTok + (outputTokens / 1_000_000) * p.outPerMTok;
}

export function unitCostUsd(provider: string, model: string, minutes: number): number {
  const p = UNIT_PRICES[provider]?.[model] ?? UNIT_PRICES[provider]?.default;
  if (!p) {
    warnOnce(`${provider}/${model}`);
    return 0;
  }
  return minutes * p.perMinuteUsd;
}

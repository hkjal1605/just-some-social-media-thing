// The text-LLM primitive (doc 03 §5, doc 08 §4): text agents run through OpenRouter, tiered per agent
// by modelForAgent() — the capable pro model for creative/strategic/analytical work, the cheap flash
// model for high-volume mechanical work. runStructured forces a single JSON object matching the zod
// schema (JSON mode + schema-in-prompt); invalid output → re-prompt with the error (≤2 retries) →
// throw. scoreBatch does cheap bulk rubric scoring (always flash). Everything is metered.
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { meterAgentRun, meterLlm, withBackoff } from "./meter";
import { tokenCostUsd } from "./prices";

const log = makeLogger("llm");

// Per-agent model tiering (cost optimization). Creative/strategic/analytical agents stay on the
// capable model (env.OPENROUTER_MODEL) — their output quality drives virality and they're low-volume,
// so cost is negligible. High-volume mechanical agents run on the cheap flash tier
// (env.OPENROUTER_MODEL_FLASH). One decision, one place; the two models themselves stay env-tunable.
const FLASH_AGENTS = new Set<string>([
  "radar-rubric", // scores every scraped item — by far the highest-volume agent
  "comment-classifier", // triages every comment on live posts
  "trend-headline", // summarizes clustered items into a headline
  "metadata-finalizer", // polishes captions/titles/hashtags (the scriptwriter already wrote the copy)
]);

/** The model an agent should use — cheap flash for high-volume mechanical work, capable pro otherwise. */
export function modelForAgent(agent: string): string {
  return FLASH_AGENTS.has(agent) ? env.OPENROUTER_MODEL_FLASH : env.OPENROUTER_MODEL;
}

export class StructuredOutputError extends Error {
  constructor(
    public readonly agent: string,
    message: string,
  ) {
    super(`agent ${agent}: ${message}`);
    this.name = "StructuredOutputError";
  }
}

// ── OpenAI-compatible chat surface (OpenRouter) ──────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" };
}
export interface ChatResponse {
  choices: { message: { content: string | null } }[];
  // OpenRouter returns token counts and (with usage.include) the real USD cost of the call
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}
/** Test seam — inject a fake OpenRouter chat client. */
export interface ChatClient {
  create(req: ChatRequest): Promise<ChatResponse>;
}

function defaultChatClient(): ChatClient {
  return {
    async create(req: ChatRequest): Promise<ChatResponse> {
      const res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
          "HTTP-Referer": env.APP_BASE_URL,
          "X-Title": "Viral Engine",
        },
        // usage.include → OpenRouter returns the exact cost so the budget guard is accurate
        body: JSON.stringify({ ...req, usage: { include: true } }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`openrouter ${res.status}: ${body.slice(0, 500)}`), {
          status: res.status,
        });
      }
      return (await res.json()) as ChatResponse;
    },
  };
}

/** Strip markdown fences a model may add despite JSON mode, then parse. */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  return JSON.parse(cleaned);
}

export interface RunStructuredOpts<T> {
  agent: string; // recorded in agent_runs + llm_usage
  system: string;
  user: string;
  schema: z.ZodType<T>;
  model?: string; // default env.OPENROUTER_MODEL
  maxTokens?: number;
  entity?: { kind: string; id: string };
  clientOverride?: ChatClient;
}

const MAX_VALIDATION_RETRIES = 2;
// Generous default so a long structured response (e.g. a full multi-scene script + per-platform
// captions) isn't truncated mid-JSON → "Unexpected EOF". It's a CAP not a target: short agents stop
// early and cost nothing extra. Agents that want to bound output pass a smaller opts.maxTokens.
const DEFAULT_MAX_TOKENS = 16384;

export async function runStructured<T>(opts: RunStructuredOpts<T>): Promise<T> {
  const client = opts.clientOverride ?? defaultChatClient();
  const model = opts.model ?? modelForAgent(opts.agent);
  const startedAt = new Date();
  const t0 = performance.now();

  const schemaJson = zodToJsonSchema(opts.schema, { $refStrategy: "none" });
  const system = `${opts.system}\n\nRespond with ONLY a single JSON object that conforms to this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(schemaJson)}`;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: opts.user },
  ];
  let totalIn = 0;
  let totalOut = 0;
  let costAcc = 0;
  let sawCost = false;
  let validationRetries = 0;

  const finish = async (status: "ok" | "error", error?: string) => {
    const costUsd = sawCost ? costAcc : tokenCostUsd("openrouter", model, totalIn, totalOut);
    await meterLlm({
      provider: "openrouter",
      model,
      purpose: opts.agent,
      inputTokens: totalIn,
      outputTokens: totalOut,
      costUsd,
    });
    await meterAgentRun({
      agent: opts.agent,
      status: validationRetries > 0 && status === "ok" ? "validation_retry" : status,
      model,
      inputTokens: totalIn,
      outputTokens: totalOut,
      costUsd,
      durationMs: Math.round(performance.now() - t0),
      startedAt,
      ...(opts.entity ? { entityKind: opts.entity.kind, entityId: opts.entity.id } : {}),
      ...(error ? { error: error.slice(0, 2000) } : {}),
    });
  };

  for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
    let resp: ChatResponse;
    try {
      resp = await withBackoff(() =>
        client.create({
          model,
          messages,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
      );
    } catch (err) {
      await finish("error", `provider error: ${String(err)}`);
      throw err;
    }

    totalIn += resp.usage?.prompt_tokens ?? 0;
    totalOut += resp.usage?.completion_tokens ?? 0;
    if (typeof resp.usage?.cost === "number") {
      costAcc += resp.usage.cost;
      sawCost = true;
    }

    const content = resp.choices?.[0]?.message?.content ?? "";
    let feedback: string | null = null;
    try {
      const parsed = opts.schema.safeParse(extractJson(content));
      if (parsed.success) {
        await finish("ok");
        return parsed.data;
      }
      feedback = parsed.error.message;
    } catch (e) {
      feedback = `response was not valid JSON: ${String(e)}`;
    }

    if (attempt < MAX_VALIDATION_RETRIES) {
      validationRetries++;
      // surface the actual zod/parse feedback — without it, a schema failure is undebuggable
      log.warn(
        { agent: opts.agent, attempt, feedback: feedback?.slice(0, 500) },
        "structured output failed validation — retrying",
      );
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content: `Your previous response failed:\n${feedback}\nRespond again with ONLY a corrected JSON object.`,
        },
      );
      continue;
    }
    await finish("error", `validation failed after retries: ${feedback}`);
    log.error(
      { agent: opts.agent, feedback: feedback?.slice(0, 800) },
      "structured output failed schema validation after retries",
    );
    throw new StructuredOutputError(opts.agent, "output failed schema validation after retries");
  }

  // unreachable
  throw new StructuredOutputError(opts.agent, "exhausted attempts");
}

// ── batch rubric scoring (doc 03 §5) ─────────────────────────────────
export interface ScoreBatchOpts<T> {
  agent: string;
  items: { id: string; text: string }[];
  rubricPrompt: string;
  schema: z.ZodType<T>;
  chunkSize?: number;
  clientOverride?: ChatClient;
}

/** Score many items per request (returns Map<itemId, T>) — cheap bulk scoring via OpenRouter. */
export async function scoreBatch<T>(opts: ScoreBatchOpts<T>): Promise<Map<string, T>> {
  const client = opts.clientOverride ?? defaultChatClient();
  const model = env.OPENROUTER_MODEL_FLASH; // bulk scoring is always the cheap tier
  const out = new Map<string, T>();
  const chunkSize = opts.chunkSize ?? 20;

  for (let i = 0; i < opts.items.length; i += chunkSize) {
    const chunk = opts.items.slice(i, i + chunkSize);
    const prompt = [
      opts.rubricPrompt,
      "",
      "Score every item below. Respond with ONLY a JSON object shaped",
      '{"scores": [{"id": "<item id>", "result": <object matching the rubric schema>}]} — one entry per item, same ids.',
      "",
      "ITEMS:",
      JSON.stringify(chunk),
    ].join("\n");

    const res = await withBackoff(() =>
      client.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    );

    const inTok = res.usage?.prompt_tokens ?? 0;
    const outTok = res.usage?.completion_tokens ?? 0;
    const costUsd =
      typeof res.usage?.cost === "number"
        ? res.usage.cost
        : tokenCostUsd("openrouter", model, inTok, outTok);
    await meterLlm({
      provider: "openrouter",
      model,
      purpose: opts.agent,
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd,
    });
    await meterAgentRun({
      agent: opts.agent,
      status: "ok",
      model,
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd,
    });

    let scores: unknown;
    try {
      const obj = extractJson(res.choices?.[0]?.message?.content ?? "{}") as {
        scores?: unknown;
      };
      scores = obj.scores;
    } catch {
      throw new Error(`scoreBatch(${opts.agent}): response was not valid JSON`);
    }
    if (!Array.isArray(scores)) {
      throw new Error(`scoreBatch(${opts.agent}): expected a "scores" array`);
    }
    for (const entry of scores) {
      const { id, result } = entry as { id?: string; result?: unknown };
      if (!id) continue;
      const validated = opts.schema.safeParse(result);
      if (validated.success) out.set(id, validated.data);
      else
        log.warn(
          { agent: opts.agent, id, issues: validated.error.issues.length },
          "scoreBatch: item failed schema — skipped",
        );
    }
  }
  return out;
}

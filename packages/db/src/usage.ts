// Money meters (doc 00 §7): every LLM call → llm_usage, every paid connector call → api_usage,
// every agent invocation → agent_runs. costs.rollup aggregates these daily.
import { newId } from "@ve/core";
import { db } from "./client";
import { agentRuns, apiUsage, llmUsage } from "./schema";

export interface LlmUsageInput {
  provider: "openrouter" | "anthropic" | "gemini" | "groq" | "elevenlabs" | "openai";
  model: string;
  purpose: string;
  inputTokens?: number;
  outputTokens?: number;
  units?: number; // minutes for tts/transcribe/video
  costUsd: number;
}

export async function recordLlmUsage(u: LlmUsageInput): Promise<void> {
  await db.insert(llmUsage).values({
    id: newId(),
    provider: u.provider,
    model: u.model,
    purpose: u.purpose,
    inputTokens: u.inputTokens ?? null,
    outputTokens: u.outputTokens ?? null,
    units: u.units !== undefined ? String(u.units) : null,
    costUsd: u.costUsd.toFixed(6),
  });
}

export interface ApiUsageInput {
  service: "x_api" | "apify" | "ayrshare" | "youtube" | "reddit" | "pexels" | "ensemble";
  endpoint: string;
  units: number;
  costUsd?: number;
}

export async function recordApiUsage(u: ApiUsageInput): Promise<void> {
  await db.insert(apiUsage).values({
    id: newId(),
    service: u.service,
    endpoint: u.endpoint,
    units: String(u.units),
    costUsd: (u.costUsd ?? 0).toFixed(6),
  });
}

export interface AgentRunInput {
  agent: string;
  queue?: string;
  entityKind?: string;
  entityId?: string;
  status: "ok" | "error" | "validation_retry";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  startedAt?: Date;
}

export async function recordAgentRun(r: AgentRunInput): Promise<void> {
  await db.insert(agentRuns).values({
    id: newId(),
    agent: r.agent,
    queue: r.queue ?? null,
    entityKind: r.entityKind ?? null,
    entityId: r.entityId ?? null,
    status: r.status,
    model: r.model ?? null,
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    costUsd: r.costUsd !== undefined ? r.costUsd.toFixed(6) : null,
    durationMs: r.durationMs ?? null,
    error: r.error ?? null,
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
  });
}

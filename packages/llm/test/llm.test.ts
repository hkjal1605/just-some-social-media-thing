import { describe, expect, test } from "bun:test";
import { env } from "@ve/config";
import { z } from "zod";
import {
  modelForAgent,
  runStructured,
  StructuredOutputError,
  tokenCostUsd,
  unitCostUsd,
  withBackoff,
} from "../src";

describe("per-agent model tiering", () => {
  test("creative/strategic agents get the capable model; bulk/mechanical agents get flash", () => {
    for (const a of [
      "scriptwriter",
      "editor-in-chief",
      "performance-analyst",
      "playbook-editor",
      "policy-differ",
    ]) {
      expect(modelForAgent(a)).toBe(env.OPENROUTER_MODEL);
    }
    for (const a of [
      "radar-rubric",
      "comment-classifier",
      "trend-headline",
      "metadata-finalizer",
    ]) {
      expect(modelForAgent(a)).toBe(env.OPENROUTER_MODEL_FLASH);
    }
    // an unrecognized agent defaults to the capable model (safe default)
    expect(modelForAgent("some-future-agent")).toBe(env.OPENROUTER_MODEL);
  });
});

describe("prices", () => {
  test("token cost math (all via openrouter)", () => {
    expect(tokenCostUsd("openrouter", "deepseek/deepseek-v4-pro", 1_000_000, 0)).toBeCloseTo(0.3);
    expect(tokenCostUsd("openrouter", "deepseek/deepseek-v4-pro", 0, 1_000_000)).toBeCloseTo(1.2);
    expect(tokenCostUsd("openrouter", "openai/text-embedding-3-small", 1_000_000, 0)).toBeCloseTo(
      0.02,
    );
  });

  test("unknown model costs 0 (warned, not thrown)", () => {
    expect(tokenCostUsd("openrouter", "imaginary-model", 1000, 1000)).toBe(0);
  });

  test("transcription unit cost (openrouter); Gemini TTS is token-priced", () => {
    expect(unitCostUsd("openrouter", "openai/whisper-large-v3-turbo", 60)).toBeCloseTo(0.04);
    expect(tokenCostUsd("gemini", "gemini-3.1-flash-tts-preview", 0, 1_000_000)).toBeCloseTo(10);
  });
});

describe("withBackoff", () => {
  test("retries 429 then succeeds", async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("rate limited"), { status: 429 });
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does not retry 4xx (non-429)", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});

// ── runStructured against a fake OpenRouter chat client ───────────
const OutSchema = z.object({ headline: z.string(), score: z.number().min(0).max(100) });

interface FakeReq {
  messages: { role: string; content: string }[];
  response_format?: { type: string };
}
function fakeClient(responses: unknown[]) {
  let i = 0;
  const calls: FakeReq[] = [];
  return {
    calls,
    create: async (req: FakeReq) => {
      calls.push(req);
      const next = responses[Math.min(i, responses.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

// OpenRouter/OpenAI chat response with the JSON object in message.content
const jsonMessage = (obj: unknown) => ({
  choices: [{ message: { content: JSON.stringify(obj) } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

describe("runStructured", () => {
  test("returns validated output on first try", async () => {
    const client = fakeClient([jsonMessage({ headline: "hi", score: 88 })]);
    const out = await runStructured({
      agent: "test-agent",
      system: "sys",
      user: "user",
      schema: OutSchema,
      clientOverride: client as never,
    });
    expect(out.headline).toBe("hi");
    expect(out.score).toBe(88);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.response_format).toEqual({ type: "json_object" });
    expect(client.calls[0]?.messages[0]?.role).toBe("system"); // schema in the system prompt
  });

  test("re-prompts with the zod error on invalid output, then succeeds", async () => {
    const client = fakeClient([
      jsonMessage({ headline: "hi", score: 900 }), // out of range
      jsonMessage({ headline: "hi", score: 90 }),
    ]);
    const out = await runStructured({
      agent: "test-agent",
      system: "sys",
      user: "user",
      schema: OutSchema,
      clientOverride: client as never,
    });
    expect(out.score).toBe(90);
    expect(client.calls).toHaveLength(2);
    // system + user + assistant(bad) + user(feedback)
    expect(client.calls[1]?.messages).toHaveLength(4);
  });

  test("throws StructuredOutputError after exhausting validation retries", async () => {
    const client = fakeClient([jsonMessage({ headline: "hi", score: -5 })]);
    await expect(
      runStructured({
        agent: "test-agent",
        system: "sys",
        user: "user",
        schema: OutSchema,
        clientOverride: client as never,
      }),
    ).rejects.toThrow(StructuredOutputError);
    expect(client.calls).toHaveLength(3); // initial + 2 retries
  });

  test("propagates provider errors after backoff attempts", async () => {
    const err = Object.assign(new Error("overloaded"), { status: 529 });
    const client = fakeClient([err]);
    await expect(
      runStructured({
        agent: "test-agent",
        system: "sys",
        user: "user",
        schema: OutSchema,
        clientOverride: client as never,
      }),
    ).rejects.toThrow("overloaded");
    expect(client.calls.length).toBe(3); // backoff attempts
  }, 20_000);
});

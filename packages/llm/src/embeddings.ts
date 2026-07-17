// Embeddings for the similarity guard + trend clustering (doc 03 §5), via OpenRouter's OpenAI-
// compatible /embeddings endpoint. text-embedding-3-small at 768 dims keeps the DB vector size.
import { env } from "@ve/config";
import { meterLlm, withBackoff } from "./meter";
import { tokenCostUsd } from "./prices";

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens?: number; cost?: number };
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = env.OPENROUTER_MODEL_EMBED;
  const res = await withBackoff(async () => {
    const r = await fetch(`${env.OPENROUTER_BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": env.APP_BASE_URL,
        "X-Title": "Viral Engine",
      },
      body: JSON.stringify({ model, input: texts, dimensions: env.OPENROUTER_EMBED_DIMS }),
    });
    if (!r.ok) {
      throw Object.assign(
        new Error(`openrouter embeddings ${r.status}: ${(await r.text()).slice(0, 300)}`),
        {
          status: r.status,
        },
      );
    }
    return (await r.json()) as EmbeddingResponse;
  });

  const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (vectors.length !== texts.length) {
    throw new Error(`embed: expected ${texts.length} vectors, got ${vectors.length}`);
  }
  const inTok = res.usage?.prompt_tokens ?? Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
  const costUsd =
    typeof res.usage?.cost === "number"
      ? res.usage.cost
      : tokenCostUsd("openrouter", model, inTok, 0);
  await meterLlm({
    provider: "openrouter",
    model,
    purpose: "embed",
    inputTokens: inTok,
    outputTokens: 0,
    costUsd,
  });
  return vectors;
}

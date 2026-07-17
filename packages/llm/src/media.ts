// Multimodal generation. Image generation (ai-image scene visuals) runs via OpenRouter chat — the
// model returns the image as a data-URL. Video understanding (clip moment analysis) runs on Gemini's
// NATIVE Files API: OpenRouter's OpenAI-compatible chat has no video content type (it rejects
// video_url with "invalid argument"), so we upload the source straight to Gemini (resumable, up to
// 2 GB) and analyze with real video understanding. The Gemini key (same as TTS) goes in the
// x-goog-api-key HEADER, never the URL. Metered from each provider's returned usage.
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";
import { getObjectBytes } from "@ve/storage";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { meterAgentRun, meterLlm, withBackoff } from "./meter";
import { tokenCostUsd } from "./prices";

const log = makeLogger("llm-media");

// ── OpenRouter chat (image generation) ───────────────────────────────
const OR_HEADERS = () => ({
  authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
  "content-type": "application/json",
  "HTTP-Referer": env.APP_BASE_URL,
  "X-Title": "Viral Engine",
});

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}
interface ChatResult {
  choices: {
    message: {
      content: string | null;
      images?: { image_url?: { url?: string } }[];
    };
  }[];
  usage?: ChatUsage;
}

async function orChat(body: Record<string, unknown>): Promise<ChatResult> {
  return withBackoff(async () => {
    const r = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: OR_HEADERS(),
      body: JSON.stringify({ ...body, usage: { include: true } }),
    });
    if (!r.ok) {
      throw Object.assign(
        new Error(`openrouter chat ${r.status}: ${(await r.text()).slice(0, 400)}`),
        { status: r.status },
      );
    }
    return (await r.json()) as ChatResult;
  });
}

async function meterOpenRouter(
  agent: string,
  model: string,
  usage: ChatUsage | undefined,
): Promise<void> {
  const inTok = usage?.prompt_tokens ?? 0;
  const outTok = usage?.completion_tokens ?? 0;
  const costUsd =
    typeof usage?.cost === "number" ? usage.cost : tokenCostUsd("openrouter", model, inTok, outTok);
  await meterLlm({
    provider: "openrouter",
    model,
    purpose: agent,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd,
  });
  await meterAgentRun({
    agent,
    status: "ok",
    model,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd,
  });
}

function stripFences(text: string): unknown {
  return JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, ""));
}

// ── image generation (doc 05 §3) — licenseRef ai-gen:<model> ─────────
export async function generateImage(opts: {
  agent: string;
  prompt: string;
  aspectRatio?: "9:16" | "16:9" | "1:1";
}): Promise<{ image: Uint8Array; mime: string }> {
  const model = env.OPENROUTER_MODEL_IMAGE;
  const res = await orChat({
    model,
    modalities: ["image", "text"],
    messages: [
      {
        role: "user",
        content: `Generate a single photorealistic image, no text overlays, aspect ratio ${opts.aspectRatio ?? "9:16"}: ${opts.prompt}`,
      },
    ],
  });
  await meterOpenRouter(opts.agent, model, res.usage);

  const url = res.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m?.[1] || !m[2])
    throw new Error(`generateImage(${opts.agent}): no image data-url in response`);
  return { image: Uint8Array.from(Buffer.from(m[2], "base64")), mime: m[1] };
}

// ── video understanding (doc 05 §5) — Gemini native Files API ─────────
export interface AnalyzeVideoOpts<T> {
  agent: string;
  r2Key: string;
  prompt: string;
  schema: z.ZodType<T>;
  fps?: "default" | "low"; // "low" (0.5 fps) for long sources — fewer video tokens (doc 05 §5)
  mimeType?: string;
  sourcePath?: string; // local (cached) source file — read from here instead of re-downloading r2Key
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const geminiKeyHeader = () => ({ "x-goog-api-key": env.GEMINI_API_KEY });

interface GeminiFile {
  name: string; // "files/abc123"
  uri: string;
  mimeType?: string;
  state: string; // PROCESSING | ACTIVE | FAILED
}

/** Resumable upload of the video bytes to the Gemini Files API → the file handle. */
async function geminiUpload(bytes: Uint8Array, mimeType: string): Promise<GeminiFile> {
  const start = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      ...geminiKeyHeader(),
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "clip-source" } }),
  });
  if (!start.ok)
    throw new Error(`gemini upload start ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("gemini upload: no resumable URL in response headers");

  const done = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...geminiKeyHeader(),
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  if (!done.ok)
    throw new Error(`gemini upload finalize ${done.status}: ${(await done.text()).slice(0, 200)}`);
  const { file } = (await done.json()) as { file: GeminiFile };
  return file;
}

/** Poll the file until it finishes PROCESSING (video ingest) — ACTIVE, or throw. Long videos take
 *  minutes to process, so the budget is env-configurable (GEMINI_FILE_TIMEOUT_MS, default 10 min). */
async function geminiWaitActive(file: GeminiFile): Promise<GeminiFile> {
  let f = file;
  const pollMs = 2000;
  const maxPolls = Math.max(1, Math.ceil(env.GEMINI_FILE_TIMEOUT_MS / pollMs));
  for (let i = 0; i < maxPolls && f.state === "PROCESSING"; i++) {
    await Bun.sleep(pollMs);
    const r = await fetch(`${GEMINI_BASE}/v1beta/${f.name}`, { headers: geminiKeyHeader() });
    if (!r.ok) throw new Error(`gemini file poll ${r.status}: ${(await r.text()).slice(0, 160)}`);
    f = (await r.json()) as GeminiFile;
  }
  if (f.state !== "ACTIVE") {
    throw new Error(
      `gemini file not ACTIVE (state=${f.state}) after ${Math.round(env.GEMINI_FILE_TIMEOUT_MS / 1000)}s`,
    );
  }
  return f;
}

async function geminiDelete(name: string): Promise<void> {
  await fetch(`${GEMINI_BASE}/v1beta/${name}`, {
    method: "DELETE",
    headers: geminiKeyHeader(),
  }).catch(() => {});
}

interface GeminiGen {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** One generateContent call over the uploaded video + prompt, JSON-mode. Retries transient errors. */
async function geminiGenerate(
  fileUri: string,
  mimeType: string,
  prompt: string,
  fps: number,
): Promise<GeminiGen> {
  return withBackoff(async () => {
    const r = await fetch(
      `${GEMINI_BASE}/v1beta/models/${env.GEMINI_MODEL_VIDEO}:generateContent`,
      {
        method: "POST",
        headers: { ...geminiKeyHeader(), "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { fileData: { mimeType, fileUri }, videoMetadata: { fps } },
                { text: prompt },
              ],
            },
          ],
          // merged clip call returns hooks + captions for up to 10 moments — raise the output cap so
          // a long list doesn't truncate (which would break JSON parsing → wasted retries)
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 32768,
          },
        }),
      },
    );
    if (!r.ok) {
      throw Object.assign(
        new Error(`gemini generate ${r.status}: ${(await r.text()).slice(0, 300)}`),
        {
          status: r.status,
        },
      );
    }
    return (await r.json()) as GeminiGen;
  });
}

/**
 * Analyze a video from storage (doc 05 §5) with Gemini's native video understanding: download the
 * bytes, upload to the Files API, wait for processing, then generateContent with the transcript-in-
 * prompt + the JSON Schema. Validates against the zod schema, re-prompting with the error on a miss,
 * and always deletes the uploaded file. Metered as provider "gemini".
 */
export async function analyzeVideo<T>(opts: AnalyzeVideoOpts<T>): Promise<T> {
  const model = env.GEMINI_MODEL_VIDEO;
  const mimeType = opts.mimeType ?? "video/mp4";
  const fps = opts.fps === "low" ? 0.5 : 1;
  const schemaJson = JSON.stringify(zodToJsonSchema(opts.schema, { $refStrategy: "none" }));
  const basePrompt = `${opts.prompt}\n\nRespond with ONLY a single minified JSON object that conforms to this JSON Schema — no prose, no markdown fences:\n${schemaJson}`;

  const bytes = opts.sourcePath
    ? new Uint8Array(await Bun.file(opts.sourcePath).arrayBuffer())
    : await getObjectBytes(opts.r2Key);
  const file = await geminiWaitActive(await geminiUpload(bytes, mimeType));
  let inTok = 0;
  let outTok = 0;
  let feedback: string | null = null;
  try {
    for (let attempt = 0; attempt <= 2; attempt++) {
      const prompt = feedback
        ? `${basePrompt}\n\nYour previous response failed validation:\n${feedback}\nReturn ONLY a corrected JSON object.`
        : basePrompt;
      const res = await geminiGenerate(file.uri, mimeType, prompt, fps);
      inTok += res.usageMetadata?.promptTokenCount ?? 0;
      outTok += res.usageMetadata?.candidatesTokenCount ?? 0;
      const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      try {
        const parsed = opts.schema.safeParse(stripFences(text));
        if (parsed.success) {
          await meterGemini(opts.agent, model, inTok, outTok, "ok");
          return parsed.data;
        }
        feedback = parsed.error.message;
      } catch (e) {
        feedback = `response was not valid JSON: ${String(e).slice(0, 120)}`;
      }
      log.warn({ agent: opts.agent, attempt }, "video analysis failed validation — retrying");
    }
    await meterGemini(opts.agent, model, inTok, outTok, "error");
    throw new Error(
      `analyzeVideo(${opts.agent}): schema validation failed after retries: ${feedback}`,
    );
  } finally {
    await geminiDelete(file.name);
  }
}

async function meterGemini(
  agent: string,
  model: string,
  inTok: number,
  outTok: number,
  status: "ok" | "error",
): Promise<void> {
  const costUsd = tokenCostUsd("gemini", model, inTok, outTok);
  await meterLlm({
    provider: "gemini",
    model,
    purpose: agent,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd,
  });
  await meterAgentRun({ agent, status, model, inputTokens: inTok, outputTokens: outTok, costUsd });
}

// ── thumbnail frame pick (native Gemini image understanding) ──────────
export interface ThumbnailPick {
  best: number; // the chosen frame's index (one of the input indices)
  hook: string; // ≤3-word ALL-CAPS curiosity hook, "" if none
}

/**
 * Pick the most click-worthy frame from a CV-shortlisted set. Each candidate is sent inline, labeled
 * by index; Gemini returns the best index + a ≤3-word uppercase curiosity hook. Objective quality
 * (blur/exposure/colorfulness) was already gated by cover.py — this is the subjective "which face
 * reads best / peak-emotion" call the vision model is good at. Throws on failure so callers can fall
 * back to the CV top pick. Metered as provider "gemini".
 */
export async function pickThumbnailFrame(opts: {
  agent: string;
  frames: { index: number; bytes: Uint8Array; mime?: string }[];
  context?: string; // the clip's hook/transcript snippet, for relevance
}): Promise<ThumbnailPick> {
  if (opts.frames.length === 0) throw new Error("pickThumbnailFrame: no frames");
  const model = env.GEMINI_MODEL_VIDEO;
  const parts: unknown[] = [];
  for (const f of opts.frames) {
    parts.push({ text: `Frame ${f.index}:` });
    parts.push({
      inlineData: {
        mimeType: f.mime ?? "image/jpeg",
        data: Buffer.from(f.bytes).toString("base64"),
      },
    });
  }
  const ctx = opts.context ? ` The clip is about: "${opts.context.slice(0, 300)}".` : "";
  const n = opts.frames.length;
  parts.push({
    text:
      `You are choosing the THUMBNAIL for a short viral video clip. Above are ${n} candidate frames ` +
      `labeled "Frame 0".."Frame ${n - 1}". Pick the ONE that would earn the most clicks as a cover: ` +
      `a sharp, well-lit face at PEAK emotion (surprise, laughter, intensity, shock), eyes open (never ` +
      `mid-blink), engaging — not bland, awkward, mouth-mush, or eyes-closed. If none has a clear face, ` +
      `pick the most visually striking, sharp, high-contrast frame.${ctx} Also write a punchy curiosity ` +
      `HOOK in ALL CAPS, MAX 3 WORDS, that fits the chosen moment (e.g. HE SNAPPED, WAIT FOR IT, NO WAY) ` +
      `— no hashtags, no quotes, no emoji.\nRespond with ONLY minified JSON: ` +
      `{"best": <frame number>, "hook": "<hook>"}.`,
  });

  const res = await withBackoff(async () => {
    const r = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { ...geminiKeyHeader(), "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.3,
          maxOutputTokens: 256,
        },
      }),
    });
    if (!r.ok) {
      throw Object.assign(new Error(`gemini pick ${r.status}: ${(await r.text()).slice(0, 200)}`), {
        status: r.status,
      });
    }
    return (await r.json()) as GeminiGen;
  });

  const inTok = res.usageMetadata?.promptTokenCount ?? 0;
  const outTok = res.usageMetadata?.candidatesTokenCount ?? 0;
  await meterGemini(opts.agent, model, inTok, outTok, "ok");

  const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  // JSON mode isn't always honored with multi-image inputs — the model sometimes wraps the object in
  // prose ("Here is the JSON: {…}"). Try direct parse, then a fence strip, then the first {…} block.
  const tryParse = (s: string): { best?: number; hook?: string } | null => {
    try {
      return s ? (JSON.parse(s) as { best?: number; hook?: string }) : null;
    } catch {
      return null;
    }
  };
  const parsed =
    tryParse(text.trim()) ??
    tryParse(
      text
        .replace(/^```(?:json)?/i, "")
        .replace(/```\s*$/, "")
        .trim(),
    ) ??
    tryParse(text.match(/\{[\s\S]*\}/)?.[0] ?? "") ??
    {};
  const valid = opts.frames.map((f) => f.index);
  const best =
    typeof parsed?.best === "number" && valid.includes(parsed.best) ? parsed.best : (valid[0] ?? 0);
  const hook = (parsed?.hook ?? "")
    .replace(/["#]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ")
    .toUpperCase();
  return { best, hook };
}

// Narration TTS via Gemini's native TTS (doc 03 §5). This is the one job not on OpenRouter —
// OpenRouter has no verbatim-TTS model. Gemini TTS returns PCM16 audio, which we transcode to mp3.
// Key goes in the x-goog-api-key HEADER (never the URL) so it can't leak into fetch-error logs.
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@ve/config";
import { makeLogger, newId } from "@ve/core";
import { meterLlm, withBackoff } from "./meter";
import { tokenCostUsd } from "./prices";

const log = makeLogger("llm-tts");

export class TtsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`tts ${status}: ${message}`);
    this.name = "TtsError";
  }
}

interface GeminiTtsResponse {
  candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Call Gemini TTS; returns raw PCM16 bytes, its sample rate, and token usage. */
async function geminiTts(
  text: string,
): Promise<{ pcm: Uint8Array; sampleRate: number; usage: GeminiTtsResponse["usageMetadata"] }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL_TTS}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_TTS_VOICE } },
          },
        },
      }),
    },
  );
  if (!res.ok) throw new TtsError(res.status, (await res.text()).slice(0, 300));
  const json = (await res.json()) as GeminiTtsResponse;
  const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) throw new TtsError(502, "Gemini TTS returned no audio");
  const rateMatch = (inline.mimeType ?? "").match(/rate=(\d+)/);
  return {
    pcm: Uint8Array.from(Buffer.from(inline.data, "base64")),
    sampleRate: rateMatch?.[1] ? Number(rateMatch[1]) : 24000,
    usage: json.usageMetadata,
  };
}

/** Transcode raw PCM16 (mono, given sample rate) → mp3 via ffmpeg stdin/stdout. */
async function pcm16ToMp3(pcm: Uint8Array, sampleRate: number): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  proc.stdin.write(pcm as Uint8Array<ArrayBuffer>);
  await proc.stdin.end();
  const mp3 = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  if (mp3.length === 0) throw new TtsError(500, "ffmpeg produced no mp3 (is ffmpeg installed?)");
  return mp3;
}

/** Duration via ffprobe on a temp file; falls back to a words-per-second estimate. */
async function audioDurationSec(audio: Uint8Array, text: string): Promise<number> {
  const tmp = join(process.cwd(), "tmp", `tts-${newId()}.mp3`);
  try {
    await Bun.write(tmp, audio as Uint8Array<ArrayBuffer>);
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const d = Number.parseFloat(out.trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch (err) {
    log.debug({ err }, "ffprobe unavailable for tts duration — estimating");
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return Math.max(1, text.split(/\s+/).filter(Boolean).length / 2.6); // ~2.6 spoken words/second
}

export async function tts(opts: {
  text: string;
}): Promise<{ audio: Uint8Array; durationSec: number; provider: string }> {
  const { pcm, sampleRate, usage } = await withBackoff(() => geminiTts(opts.text));
  const audio = await pcm16ToMp3(pcm, sampleRate);
  const durationSec = await audioDurationSec(audio, opts.text);

  const model = env.GEMINI_MODEL_TTS;
  const inTok = usage?.promptTokenCount ?? 0;
  const outTok = usage?.candidatesTokenCount ?? 0;
  await meterLlm({
    provider: "gemini",
    model,
    purpose: "tts",
    inputTokens: inTok,
    outputTokens: outTok,
    units: durationSec / 60,
    costUsd: tokenCostUsd("gemini", model, inTok, outTok),
  });

  return { audio, durationSec, provider: "gemini" };
}

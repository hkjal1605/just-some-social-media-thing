// Whisper transcription with word + segment timestamps (doc 03 §5), via OpenRouter's OpenAI-
// compatible /audio/transcriptions endpoint (same key as the text agents). The words drive the
// karaoke captions; the segments drive clip cutting. OpenRouter returns the exact cost in usage.
import { env } from "@ve/config";
import { getObjectBytes } from "@ve/storage";
import { meterLlm, withBackoff } from "./meter";
import { unitCostUsd } from "./prices";

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperWord {
  start: number;
  end: number;
  word: string;
}

export interface WhisperResult {
  text: string;
  durationSec: number;
  segments: WhisperSegment[];
  words: WhisperWord[];
}

interface TranscriptionResponse {
  text?: string;
  duration?: number;
  segments?: { start: number; end: number; text: string }[];
  words?: { start: number; end: number; word: string }[];
  usage?: { seconds?: number; cost?: number };
}

function mimeFromKey(key: string): string {
  if (key.endsWith(".wav")) return "audio/wav";
  if (key.endsWith(".m4a")) return "audio/mp4";
  if (key.endsWith(".ogg")) return "audio/ogg";
  return "audio/mpeg";
}

export async function transcribe(opts: { r2Key: string }): Promise<WhisperResult> {
  const model = env.OPENROUTER_MODEL_TRANSCRIBE;
  const bytes = await getObjectBytes(opts.r2Key);
  const name = opts.r2Key.split("/").pop() ?? "audio.mp3";
  const file = new File([bytes as BlobPart], name, { type: mimeFromKey(opts.r2Key) });

  const res = await withBackoff(async () => {
    // rebuild the form each attempt (a File/Blob is re-readable, so retries are safe)
    const form = new FormData();
    form.append("file", file);
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    const r = await fetch(`${env.OPENROUTER_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      // no content-type — fetch sets the multipart boundary; auth on the OpenRouter key
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": env.APP_BASE_URL,
        "X-Title": "Viral Engine",
      },
      body: form,
    });
    if (!r.ok) {
      throw Object.assign(
        new Error(`openrouter transcribe ${r.status}: ${(await r.text()).slice(0, 300)}`),
        { status: r.status },
      );
    }
    return (await r.json()) as TranscriptionResponse;
  });

  const segments = (res.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
  const words = (res.words ?? []).map((w) => ({ start: w.start, end: w.end, word: w.word }));
  const durationSec =
    res.duration ?? (segments.length > 0 ? (segments[segments.length - 1]?.end ?? 0) : 0);

  // prefer OpenRouter's returned cost; fall back to the per-minute estimate in the price table
  const costUsd =
    typeof res.usage?.cost === "number"
      ? res.usage.cost
      : unitCostUsd("openrouter", model, durationSec / 60);
  await meterLlm({
    provider: "openrouter",
    model,
    purpose: "transcribe",
    units: durationSec / 60,
    costUsd,
  });

  return { text: res.text ?? "", durationSec, segments, words };
}

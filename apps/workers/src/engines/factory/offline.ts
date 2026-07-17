// Deterministic offline factory deps — tests + credential-free demo (doc 13 §2).
// Media is generated with real ffmpeg (tone TTS, solid-color stock/images) and every
// step meters a synthetic cost through the real price table, so the doc 05 §6 cost
// ledger stays honest offline (target: full faceless short ≤ $1.00 logged).
import { join } from "node:path";
import type { ScriptOut, WhisperResultLike } from "@ve/core";
import { meterLlm, modelForAgent, tokenCostUsd, unitCostUsd } from "@ve/llm";
import { cleanup, downloadToTmp, probe, runFfmpeg, tmpDir } from "@ve/media";
import type { FactoryDeps } from "./deps";

const WORDS_PER_SECOND = 2.6;

export function offlineScriptOut(opts: { angle: string; targetSec?: number }): ScriptOut {
  const targetSec = opts.targetSec ?? 66;
  const wordsNeeded = Math.ceil(targetSec * WORDS_PER_SECOND);
  const base =
    `Here's the part nobody tells you about ${opts.angle.slice(0, 60)}. ` +
    "The numbers changed this week and the old advice quietly stopped working. " +
    "First, the tooling got cheaper than your coffee budget, and that flips the whole build-versus-buy math. " +
    "Second, the workflows that used to need a team now run on a laptop while you sleep. ";
  let narration = "";
  while (narration.split(/\s+/).length < wordsNeeded) narration += base;
  const words = narration.split(/\s+/).slice(0, wordsNeeded);
  const third = Math.ceil(words.length / 3);
  const body =
    `[SCENE 1] ${words.slice(0, third).join(" ")}\n` +
    `[SCENE 2] ${words.slice(third, 2 * third).join(" ")}\n` +
    `[SCENE 3] ${words.slice(2 * third).join(" ")} So — would you run this yourself, or wait for the polished version?`;

  return {
    hookVariants: [
      { id: "a", text: "This changed overnight — and almost nobody noticed" },
      { id: "b", text: "The math on this flipped last week" },
      { id: "c", text: "You're probably overpaying for this by 10x" },
    ],
    body,
    sceneCount: 3,
    sceneVisuals: [
      { scene: 1, want: "server room lights vertical" },
      { scene: 2, want: "ai-image: abstract neural network, deep blue, vertical" },
      { scene: 3, want: "developer at desk night vertical" },
    ],
    estDurationSec: targetSec,
    perPlatformCaptions: {
      tiktok: {
        caption: "The build-vs-buy math just flipped. #ai",
        hashtags: ["ai", "aitools", "tech"],
      },
      youtube: {
        title: "The AI cost math just flipped — here's the new playbook",
        description: "What changed, what it costs now, and how to use it.",
        tags: ["ai", "tools"],
      },
      x: {
        text: "The build-vs-buy math on AI tooling just flipped. Thread-worthy details in the video.",
      },
      reddit: {
        title: "The economics of AI tooling quietly flipped — anyone else seeing this?",
        subreddit: "artificial",
        body: "Costs dropped hard this month. What are you all running locally now?",
      },
    },
    aiDisclosure: true, // scene 2 is ai-image
  };
}

async function ffmpegBytes(args: string[], outName: string): Promise<Uint8Array> {
  const dir = await tmpDir("offline-media");
  try {
    const out = join(dir, outName);
    await runFfmpeg([...args, out]);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  } finally {
    await cleanup(dir);
  }
}

/** Tone MP3 sized to the narration length — probed duration drives everything downstream. */
async function offlineTts(opts: { text: string }): Promise<{
  audio: Uint8Array;
  durationSec: number;
  provider: string;
}> {
  const durationSec = Math.max(3, Math.round(opts.text.split(/\s+/).length / WORDS_PER_SECOND));
  const audio = await ffmpegBytes(
    ["-f", "lavfi", "-i", `sine=frequency=340:duration=${durationSec}`, "-q:a", "6"],
    "tts.mp3",
  );
  const minutes = durationSec / 60;
  const model = "gemini-3.1-flash-tts-preview";
  await meterLlm({
    provider: "gemini",
    model,
    purpose: "tts",
    inputTokens: 15,
    outputTokens: Math.round(durationSec * 32),
    units: minutes,
    costUsd: tokenCostUsd("gemini", model, 15, Math.round(durationSec * 32)),
  });
  return { audio, durationSec, provider: "gemini" };
}

/** Even word grid across the real audio duration — enough for karaoke captions. */
async function offlineTranscribe(opts: { r2Key: string }): Promise<WhisperResultLike> {
  const dir = await tmpDir("offline-transcribe");
  const local = await downloadToTmp(opts.r2Key, dir);
  const meta = await probe(local);
  await cleanup(dir); // local only needed for probe (H10: never leak the download)
  const durationSec = Math.max(1, meta.durationSec);
  const wordCount = Math.max(6, Math.round(durationSec * WORDS_PER_SECOND));
  const vocab =
    "the numbers changed this week and old advice quietly stopped working for builders".split(" ");
  const step = durationSec / wordCount;
  const words = Array.from({ length: wordCount }, (_, i) => ({
    start: Number((i * step).toFixed(2)),
    end: Number(((i + 1) * step).toFixed(2)),
    word: vocab[i % vocab.length] as string,
  }));
  const segSize = Math.ceil(wordCount / Math.max(1, Math.round(durationSec / 4)));
  const segments: WhisperResultLike["segments"] = [];
  for (let i = 0; i < words.length; i += segSize) {
    const chunk = words.slice(i, i + segSize);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    if (!first || !last) continue;
    segments.push({
      start: first.start,
      end: last.end,
      text: chunk.map((w) => w.word).join(" "),
    });
  }
  const minutes = durationSec / 60;
  const model = "openai/whisper-large-v3-turbo";
  await meterLlm({
    provider: "openrouter",
    model,
    purpose: "transcribe",
    units: minutes,
    costUsd: unitCostUsd("openrouter", model, minutes),
  });
  return { text: words.map((w) => w.word).join(" "), durationSec, segments, words };
}

/** Solid-color vertical PNG for ai-image scenes. */
async function offlineGenerateImage(opts: {
  agent: string;
  prompt: string;
  aspectRatio?: "9:16" | "16:9" | "1:1";
}): Promise<{ image: Uint8Array; mime: string }> {
  const size = opts.aspectRatio === "16:9" ? "960x540" : "540x960";
  const image = await ffmpegBytes(
    ["-f", "lavfi", "-i", `color=c=0x1e3a5f:size=${size}:rate=1:duration=1`, "-frames:v", "1"],
    "scene.png",
  );
  const model = "google/gemini-2.5-flash-image";
  await meterLlm({
    provider: "openrouter",
    model,
    purpose: opts.agent,
    inputTokens: 500,
    outputTokens: 1300,
    costUsd: tokenCostUsd("openrouter", model, 500, 1300),
  });
  return { image, mime: "image/png" };
}

/** Stock bytes without the network: mp4 urls → 4s test clip, else a photo-ish PNG. */
async function offlineFetchStock(url: string): Promise<Uint8Array> {
  if (url.includes(".mp4")) {
    return ffmpegBytes(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=540x960:rate=24:duration=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
      ],
      "stock.mp4",
    );
  }
  return ffmpegBytes(
    ["-f", "lavfi", "-i", "color=c=0x2d6a4f:size=540x960:rate=1:duration=1", "-frames:v", "1"],
    "stock.png",
  );
}

/** Scriptwriter routed through runStructured-compatible signature + synthetic metering. */
const offlineRunStructured: FactoryDeps["runStructured"] = async <T>(opts: {
  agent: string;
  user: string;
  schema: { parse: (v: unknown) => T };
}): Promise<T> => {
  if (opts.agent !== "scriptwriter") {
    throw new Error(`offline factory runStructured: unknown agent ${opts.agent}`);
  }
  const angleMatch = opts.user.match(/## Brief angle \(write from this\)\n([^\n]+)/);
  const out = offlineScriptOut({ angle: angleMatch?.[1] ?? "the topic" });
  const model = modelForAgent(opts.agent);
  await meterLlm({
    provider: "openrouter",
    model,
    purpose: "scriptwriter",
    inputTokens: 1800,
    outputTokens: 900,
    costUsd: tokenCostUsd("openrouter", model, 1800, 900),
  });
  return opts.schema.parse(out);
};

/** Canned clip moments sized to the probed source duration. */
const offlineAnalyzeVideo: FactoryDeps["analyzeVideo"] = async <T>(opts: {
  agent: string;
  r2Key: string;
  schema: { parse: (v: unknown) => T };
}): Promise<T> => {
  const dir = await tmpDir("offline-analyze");
  const local = await downloadToTmp(opts.r2Key, dir);
  const meta = await probe(local);
  await cleanup(dir); // local only needed for probe (H10)
  const dur = Math.max(25, meta.durationSec);
  const end1 = Math.min(dur - 1, 24);
  const end2 = Math.min(dur - 0.5, 27);
  // merged: the offline analyzer also stands in for the scriptwriter now (hooks + captions per moment)
  const moments = {
    moments: [
      {
        startSec: 1,
        endSec: end1,
        hookScore: 84,
        selfContainedScore: 78,
        emotionScore: 70,
        transcriptSlice: "the numbers changed this week and old advice quietly stopped working",
        suggestedHookText: "The old advice stopped working",
        hookVariants: [
          { id: "a", text: "The old advice stopped working" },
          { id: "b", text: "The math flipped this week" },
          { id: "c", text: "You're probably overpaying 10x" },
        ],
        perPlatformCaptions: {
          tiktok: {
            caption: "The build-vs-buy math just flipped. #ai",
            hashtags: ["ai", "aitools", "tech"],
          },
          youtube: {
            title: "The AI cost math just flipped",
            description: "What changed and how to use it.",
            tags: ["ai", "tools"],
          },
        },
      },
      {
        startSec: 3,
        endSec: end2,
        hookScore: 71,
        selfContainedScore: 74,
        emotionScore: 66,
        transcriptSlice: "builders are switching their whole stack overnight",
        suggestedHookText: "Everyone is switching overnight",
        hookVariants: [
          { id: "a", text: "Everyone is switching overnight" },
          { id: "b", text: "The whole stack just changed" },
          { id: "c", text: "This is why builders are moving" },
        ],
        perPlatformCaptions: {
          tiktok: {
            caption: "Builders are switching their whole stack. #ai",
            hashtags: ["ai", "dev", "tech"],
          },
          youtube: {
            title: "Why builders are switching stacks overnight",
            description: "The shift, explained.",
            tags: ["ai", "dev"],
          },
        },
      },
    ],
  };
  const model = "gemini-3.5-flash";
  await meterLlm({
    provider: "gemini",
    model,
    purpose: "clip-analyzer",
    inputTokens: 4000,
    outputTokens: 600,
    units: meta.durationSec / 60,
    costUsd: tokenCostUsd("gemini", model, 4000, 600),
  });
  return opts.schema.parse(moments);
};

export const offlineFactoryDeps: FactoryDeps = {
  runStructured: offlineRunStructured,
  embed: async (texts) => {
    // reuse the radar offline embedding so script-vs-source cosine behaves consistently
    const { offlineEmbed } = await import("../radar/offline");
    return offlineEmbed(texts);
  },
  tts: offlineTts,
  transcribe: offlineTranscribe,
  analyzeVideo: offlineAnalyzeVideo,
  generateImage: offlineGenerateImage,
  fetchStock: offlineFetchStock,
};

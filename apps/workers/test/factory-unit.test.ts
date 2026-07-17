import { describe, expect, test } from "bun:test";
import { licenseRefAllowed, type WhisperResultLike } from "@ve/core";
import { buildNarration } from "../src/engines/factory/assets";
import {
  checkAiDisclosure,
  checkPlatformPolicy,
  checkRights,
} from "../src/engines/factory/compliance";
import { offlineScriptOut } from "../src/engines/factory/offline";
import { clipCaptionSegments, durationBounds } from "../src/engines/factory/render";
import {
  shingleContainment,
  similarityReport,
  trigramShingles,
} from "../src/engines/factory/similarity";
import { isDirectMediaUrl } from "../src/engines/factory/ytdlp";
import { offlineEmbed } from "../src/engines/radar/offline";

describe("similarity guard math (doc 05 §1)", () => {
  test("trigram shingles normalize scene markers and punctuation", () => {
    const s = trigramShingles("[SCENE 1] The model, beats: benchmarks! today");
    expect(s.has("the model beats")).toBe(true);
    expect(s.has("model beats benchmarks")).toBe(true);
    expect(s.has("scene 1 the")).toBe(false);
  });

  test("containment: plagiarism ≈1, original ≈0", () => {
    const source = trigramShingles(
      "open source model beats frontier labs on agentic benchmarks weights on hugging face",
    );
    const copied = trigramShingles(
      "open source model beats frontier labs on agentic benchmarks — truly wild",
    );
    const original = trigramShingles(
      "here's why the cost math of local inference quietly flipped for indie builders this month",
    );
    expect(shingleContainment(copied, source)).toBeGreaterThan(0.5);
    expect(shingleContainment(original, source)).toBeLessThan(0.05);
    expect(shingleContainment(new Set(), source)).toBe(0);
  });

  test("similarityReport: verbatim copy fails, fresh script passes (doc 05 §7)", async () => {
    const memberText =
      "Open-source 32B model beats frontier labs on agentic benchmarks — weights on HF. Benchmarks in the paper: SWE-bench verified 74%.";
    const [memberEmbedding] = await offlineEmbed([memberText]);
    const members = [
      { rawItemId: "item-1", text: memberText, embedding: memberEmbedding as number[] },
    ];

    const [copyEmbedding] = await offlineEmbed([memberText]);
    const plagiarized = similarityReport(copyEmbedding as number[], memberText, members);
    expect(plagiarized.pass).toBe(false);
    expect(plagiarized.maxCosine).toBeGreaterThan(0.86);
    expect(plagiarized.vsRawItemId).toBe("item-1");

    const fresh =
      "What nobody tells you about running big models at home: the electricity bill matters more than the GPU. Here's the real monthly math for three setups.";
    const [freshEmbedding] = await offlineEmbed([fresh]);
    const originalReport = similarityReport(freshEmbedding as number[], fresh, members);
    expect(originalReport.pass).toBe(true);
    expect(originalReport.maxNgramOverlap).toBeLessThan(0.25);
  });
});

describe("compliance pure checks (doc 05 §2)", () => {
  test("licenseRefAllowed accepts the doc set, rejects the rest", () => {
    expect(licenseRefAllowed("pexels:12345")).toBe(true);
    expect(licenseRefAllowed("own-recording")).toBe(true);
    expect(licenseRefAllowed("campaign:abc")).toBe(true);
    expect(licenseRefAllowed("ai-gen:gemini")).toBe(true);
    expect(licenseRefAllowed("youtube-rip:xyz")).toBe(false);
    expect(licenseRefAllowed("pexels:")).toBe(false);
    expect(licenseRefAllowed(null)).toBe(false);
  });

  const baseCtx = {
    stage: "pre_publish" as const,
    brief: { formatSlug: "faceless-explainer-60s", targetPlatforms: ["tiktok"] },
    category: { slug: "ai-tech", mode: "full_auto_candidate" },
    trend: null,
    script: null,
    briefAssets: [],
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture for pure checks
  } as any;

  test("rights: red trend fails; amber requires commentary format", () => {
    expect(checkRights({ ...baseCtx, trend: { rightsClass: "red" } }).pass).toBe(false);
    expect(
      checkRights({
        ...baseCtx,
        trend: { rightsClass: "amber" },
        brief: { ...baseCtx.brief, formatSlug: "clip-vertical" },
      }).pass,
    ).toBe(false);
    expect(
      checkRights({
        ...baseCtx,
        trend: { rightsClass: "amber" },
        brief: { ...baseCtx.brief, formatSlug: "x-thread" },
      }).pass,
    ).toBe(true);
    expect(
      checkRights({
        ...baseCtx,
        briefAssets: [{ id: "a", licenseRef: "stolen:thing", meta: {} }],
      }).pass,
    ).toBe(false);
  });

  test("ai_disclosure: ai-gen asset without the flag fails", () => {
    const ctx = {
      ...baseCtx,
      briefAssets: [{ id: "a", licenseRef: "ai-gen:gemini", kind: "image", meta: {} }],
      script: { aiDisclosure: false },
    };
    expect(checkAiDisclosure(ctx).pass).toBe(false);
    expect(checkAiDisclosure({ ...ctx, script: { aiDisclosure: true } }).pass).toBe(true);
  });

  test("ai_disclosure (H6): synthetic TTS alone does NOT require the flag; an AI visual does", () => {
    // every video has an ai-gen:tts narration asset — that must not block a faceless stock short
    const ttsOnly = {
      ...baseCtx,
      briefAssets: [{ id: "t", kind: "tts_audio", licenseRef: "ai-gen:tts", meta: {} }],
      script: { aiDisclosure: false },
    };
    expect(checkAiDisclosure(ttsOnly).pass).toBe(true);
    // add an AI-generated image → disclosure is now required
    const withVisual = {
      ...ttsOnly,
      briefAssets: [
        ...ttsOnly.briefAssets,
        { id: "v", kind: "image", licenseRef: "ai-gen:gemini", meta: {} },
      ],
    };
    expect(checkAiDisclosure(withVisual).pass).toBe(false);
    expect(checkAiDisclosure({ ...withVisual, script: { aiDisclosure: true } }).pass).toBe(true);
  });

  test("rights (M9): a campaign licenseRef passes only when that campaign is active", () => {
    const asset = { id: "c", kind: "source_video", licenseRef: "campaign:cid1", meta: {} };
    expect(
      checkRights({ ...baseCtx, briefAssets: [asset], activeCampaignIds: new Set(["cid1"]) }).pass,
    ).toBe(true);
    // paused/ended/unknown campaign → not a valid license
    expect(
      checkRights({ ...baseCtx, briefAssets: [asset], activeCampaignIds: new Set<string>() }).pass,
    ).toBe(false);
  });

  test("platform_policy: banned claims, politics call-to-vote on tiktok, caption limits", () => {
    const script = (over: Record<string, unknown>) => ({
      body: "normal narration",
      perPlatformCaptions: { tiktok: { caption: "hi", hashtags: ["a"] } },
      ...over,
    });
    expect(checkPlatformPolicy({ ...baseCtx, script: script({}) }).pass).toBe(true);
    expect(
      checkPlatformPolicy({ ...baseCtx, script: script({ body: "guaranteed returns in 30 days" }) })
        .pass,
    ).toBe(false);
    expect(
      checkPlatformPolicy({
        ...baseCtx,
        category: { slug: "politics", mode: "human_gated" },
        script: script({ body: "why you should go vote tomorrow" }),
      }).pass,
    ).toBe(false);
    expect(
      checkPlatformPolicy({
        ...baseCtx,
        script: script({
          perPlatformCaptions: {
            tiktok: { caption: "x", hashtags: ["1", "2", "3", "4", "5", "6"] },
          },
        }),
      }).pass,
    ).toBe(false);
    expect(
      checkPlatformPolicy({
        ...baseCtx,
        script: script({
          perPlatformCaptions: { youtube: { title: "y".repeat(95), description: "", tags: [] } },
        }),
      }).pass,
    ).toBe(false);
  });
});

describe("clip source ingest URL classification (doc 05 §5)", () => {
  test("direct video-file URLs skip yt-dlp; pages/sites route through it", () => {
    // direct media → downloaded straight
    expect(isDirectMediaUrl("https://pub-x.r2.dev/a/source.mp4")).toBe(true);
    expect(isDirectMediaUrl("https://x.r2.cloudflarestorage.com/b/key.mov?X-Amz-Sig=1")).toBe(true);
    expect(isDirectMediaUrl("https://cdn.example.com/v/clip.webm")).toBe(true);
    expect(isDirectMediaUrl("https://host/a/b/c.m4v")).toBe(true);
    // pages / site URLs → yt-dlp resolves the stream
    expect(isDirectMediaUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe(false);
    expect(isDirectMediaUrl("https://youtu.be/jNQXAC9IVRw")).toBe(false);
    expect(isDirectMediaUrl("https://vimeo.com/12345")).toBe(false);
    expect(isDirectMediaUrl("https://www.youtube.com/shorts/abc123")).toBe(false);
    expect(isDirectMediaUrl("not a url")).toBe(false);
  });
});

describe("asset/render helpers", () => {
  test("buildNarration: hook + body with markers stripped", () => {
    const narration = buildNarration({
      hookVariants: [
        { id: "a", text: "Hook A here" },
        { id: "b", text: "Hook B" },
      ],
      chosenHook: null,
      body: "[SCENE 1] First part.\n---\n[SCENE 2] Second part.",
    });
    expect(narration).toBe("Hook A here First part. Second part.");
    const withChosen = buildNarration({
      hookVariants: [
        { id: "a", text: "Hook A" },
        { id: "b", text: "Hook B wins" },
      ],
      chosenHook: "b",
      body: "[SCENE 1] Body.",
    });
    expect(withChosen).toStartWith("Hook B wins");
  });

  test("durationBounds: ±10% and the 61s tiktok floor for Rewards formats (doc 05 §4)", () => {
    const faceless = durationBounds("faceless-explainer-60s", "tiktok");
    expect(faceless?.min).toBe(61); // hard floor, not 61*0.9
    expect(faceless?.max).toBeCloseTo(99);
    const facelessYt = durationBounds("faceless-explainer-60s", "youtube");
    expect(facelessYt?.min).toBeCloseTo(54.9);
    const clip = durationBounds("clip-vertical", "tiktok");
    expect(clip?.min).toBeCloseTo(13.5); // 15-90s clip format (15*0.9) — allows punchy short clips
    expect(durationBounds("x-thread", "x")).toBeNull();
  });

  test("clipCaptionSegments slices + shifts the source transcript (doc 05 §5)", () => {
    const whisper: WhisperResultLike = {
      text: "",
      durationSec: 60,
      segments: [
        { start: 0, end: 8, text: "before the clip" },
        { start: 10, end: 16, text: "inside the clip window" },
        { start: 18, end: 26, text: "spans the end boundary" },
        { start: 30, end: 40, text: "after the clip" },
      ],
      words: [
        { start: 10.5, end: 11, word: "inside" },
        { start: 11.2, end: 11.8, word: "the" },
        { start: 12, end: 12.6, word: "clip" },
        { start: 19, end: 19.5, word: "spans" },
        { start: 33, end: 34, word: "after" },
      ],
    };
    const segments = clipCaptionSegments(whisper, 10, 22);
    expect(segments.length).toBe(2); // the two overlapping segments
    expect(segments[0]?.start).toBe(0);
    expect(segments[0]?.text).toContain("inside");
    expect(segments[0]?.words?.map((w) => w.text)).toEqual(["inside", "the", "clip"]);
    // boundary-spanning segment is clamped to the window
    expect(segments[1]?.end).toBe(12);
    expect(segments[1]?.words?.map((w) => w.text)).toEqual(["spans"]);
  });

  test("offlineScriptOut hits the Rewards duration and schema constraints", () => {
    const out = offlineScriptOut({ angle: "the cost math flipped", targetSec: 66 });
    expect(out.estDurationSec).toBeGreaterThanOrEqual(61);
    expect(out.hookVariants.length).toBe(3);
    expect(out.body).toContain("[SCENE 1]");
    expect(out.sceneVisuals.length).toBe(3);
    expect(out.perPlatformCaptions.tiktok?.hashtags.length).toBeLessThanOrEqual(5);
    expect((out.perPlatformCaptions.youtube?.title.length ?? 0) <= 90).toBe(true);
    // enough words to actually fill ~66s of VO
    expect(out.body.split(/\s+/).length).toBeGreaterThan(150);
  });
});

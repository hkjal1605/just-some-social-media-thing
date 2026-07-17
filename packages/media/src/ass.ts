// Karaoke-style ASS caption builder (doc 03 §8). Burned via the libass subtitles filter with
// fontsdir pointing at packages/media/fonts. Ships viral presets (Anton-based Hormozi/Beast styles):
// 1-3 words on screen at a time, word-by-word karaoke highlight, heavy stroke, placed in the
// lower-middle third (~65% height) to clear the platform UI safe zones and not cover the speaker.
import { join } from "node:path";

export interface CaptionWord {
  start: number; // seconds
  end: number;
  text: string;
}

export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
  words?: CaptionWord[]; // present → karaoke highlighting
}

export interface CaptionStyle {
  fontName?: string;
  fontSize?: number;
  /** &HAABBGGRR ASS color — sung/active text */
  primaryColour?: string;
  /** not-yet-sung text (karaoke base) */
  secondaryColour?: string;
  outlineColour?: string;
  backColour?: string;
  playResX?: number;
  playResY?: number;
  marginV?: number;
  bold?: boolean;
  alignment?: number; // ASS numpad alignment; 2 = bottom-center, 5 = middle-center
  outline?: number; // stroke width
  shadow?: number;
  borderStyle?: number; // 1 = outline+shadow, 3 = opaque box
  uppercase?: boolean;
}

export const DEFAULT_CAPTION_STYLE: Required<CaptionStyle> = {
  fontName: "Inter",
  fontSize: 72,
  primaryColour: "&H0000D7FF", // amber-gold highlight (BGR)
  secondaryColour: "&H00FFFFFF", // white before highlight
  outlineColour: "&H00000000",
  backColour: "&H80000000",
  playResX: 1080,
  playResY: 1920,
  marginV: 260,
  bold: true,
  alignment: 2,
  outline: 4,
  shadow: 0,
  borderStyle: 1,
  uppercase: false,
};

// Viral clip presets (research §Part-1): bold condensed font, 1-3 words, active-word color highlight,
// heavy stroke, ~65% height. marginV is from the bottom with alignment 2 → 620 keeps text in the
// lower-middle third of a 1920-tall frame, clear of TikTok/Reels/Shorts bottom UI (~320-450px) and
// below the speaker's face.
export const CAPTION_PRESETS: Record<string, Required<CaptionStyle>> = {
  hormozi: {
    ...DEFAULT_CAPTION_STYLE,
    fontName: "Anton",
    fontSize: 96,
    primaryColour: "&H003DD9FF", // #FFD93D bright yellow (active word)
    secondaryColour: "&H00FFFFFF", // white base
    outlineColour: "&H00000000",
    marginV: 620,
    outline: 8,
    shadow: 2,
    uppercase: true,
  },
  beast: {
    ...DEFAULT_CAPTION_STYLE,
    fontName: "Anton",
    fontSize: 100,
    primaryColour: "&H0014FF39", // #39FF14 neon green (active word)
    secondaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    marginV: 620,
    outline: 9,
    shadow: 2,
    uppercase: true,
  },
  clean: {
    ...DEFAULT_CAPTION_STYLE,
    fontName: "Bricolage Grotesque",
    fontSize: 78,
    primaryColour: "&H00FFFFFF", // all white, subtle
    secondaryColour: "&H00C8C8C8",
    outlineColour: "&H00000000",
    marginV: 560,
    outline: 5,
    shadow: 1,
    uppercase: false,
  },
};

export type CaptionPreset = keyof typeof CAPTION_PRESETS;

export const FONTS_DIR = join(import.meta.dir, "..", "fonts");

/**
 * Re-group Whisper words into short 1-`maxWords`-word chunks for the "few words on screen" viral
 * look — breaking on sentence-enders and pauses so a chunk never spans a long silence. Falls back to
 * the original segments if there are no word timings.
 */
export function chunkWords(
  segments: CaptionSegment[],
  maxWords = 3,
  maxGapSec = 0.45,
): CaptionSegment[] {
  const words: CaptionWord[] = [];
  for (const seg of segments) if (seg.words?.length) words.push(...seg.words);
  if (words.length === 0) return segments;

  const chunks: CaptionSegment[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (!first || !last) return;
    chunks.push({
      start: first.start,
      end: last.end,
      text: cur.map((w) => w.text.trim()).join(" "),
      words: cur,
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    cur.push(w);
    const next = words[i + 1];
    const endsSentence = /[.!?]$/.test(w.text.trim());
    const bigGap = next ? next.start - w.end > maxGapSec : false;
    if (cur.length >= maxWords || endsSentence || bigGap) flush();
  }
  flush();
  return chunks;
}

function assTime(t: number): string {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(Math.min(cs, 99)).padStart(2, "0")}`;
}

function escapeAssText(text: string, uppercase: boolean): string {
  const t = uppercase ? text.toUpperCase() : text;
  return t.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
}

function karaokeLine(seg: CaptionSegment, uppercase: boolean): string {
  if (!seg.words || seg.words.length === 0) return escapeAssText(seg.text, uppercase);
  const parts: string[] = [];
  let cursor = seg.start;
  for (const w of seg.words) {
    const gap = Math.max(0, w.start - cursor);
    if (gap > 0.01) parts.push(`{\\k${Math.round(gap * 100)}}`); // silent gap keeps sync
    const dur = Math.max(1, Math.round((w.end - w.start) * 100));
    parts.push(`{\\k${dur}}${escapeAssText(w.text.trim(), uppercase)} `);
    cursor = w.end;
  }
  return parts.join("").trimEnd();
}

export function buildAss(opts: { segments: CaptionSegment[]; style?: CaptionStyle }): string {
  const s = { ...DEFAULT_CAPTION_STYLE, ...opts.style };
  const header = [
    "[Script Info]",
    "; generated by @ve/media buildAss",
    "ScriptType: v4.00+",
    `PlayResX: ${s.playResX}`,
    `PlayResY: ${s.playResY}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.fontName},${s.fontSize},${s.primaryColour},${s.secondaryColour},${s.outlineColour},${s.backColour},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle},${s.outline},${s.shadow},${s.alignment},60,60,${s.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = opts.segments.map(
    (seg) =>
      `Dialogue: 0,${assTime(seg.start)},${assTime(seg.end)},Default,,0,0,0,,${karaokeLine(seg, s.uppercase)}`,
  );
  return `${[...header, ...events].join("\n")}\n`;
}

// Format registry (doc 03 §2). Briefs pick a formatSlug; renderers map from `render`.
import { z } from "zod";
import type { Platform } from "./enums";

export type RenderKind = "slideshow-vo" | "screencast-vo" | "text-only" | "clip-captions";

export interface FormatSpec {
  readonly platforms: readonly Platform[];
  readonly durationSec: readonly [number, number] | null;
  readonly render: RenderKind;
}

export const FORMATS = {
  "faceless-explainer-60s": {
    platforms: ["tiktok", "youtube"],
    durationSec: [61, 90],
    render: "slideshow-vo",
  },
  "demo-screencast": {
    platforms: ["tiktok", "youtube", "x"],
    durationSec: [45, 120],
    render: "screencast-vo",
  },
  "x-thread": { platforms: ["x"], durationSec: null, render: "text-only" },
  "clip-vertical": {
    platforms: ["tiktok", "youtube", "x"],
    durationSec: [15, 90],
    render: "clip-captions",
  },
  "reddit-discussion": { platforms: ["reddit"], durationSec: null, render: "text-only" },
} as const satisfies Record<string, FormatSpec>;

export type FormatSlug = keyof typeof FORMATS;
export const FORMAT_SLUGS = Object.keys(FORMATS) as [FormatSlug, ...FormatSlug[]];
export const FormatSlugSchema = z.enum(FORMAT_SLUGS);

/** Formats the editor-in-chief may originate from a trend. EXCLUDES clip-captions formats
 *  (clip-vertical): those need a promoted source-video clip that trend briefs don't have, so an
 *  editor-chosen clip-vertical brief has no candidate and can never render (doc 04 §4 / doc 05 §5). */
export const EDITOR_FORMAT_SLUGS = FORMAT_SLUGS.filter(
  (s) => FORMATS[s].render !== "clip-captions",
) as [FormatSlug, ...FormatSlug[]];

// Pexels — licensed stock (doc 03 §6). Assets store licenseRef 'pexels:<id>'.
import { env } from "@ve/config";
import { fetchJson, fixtureMode, loadFixture, logUsage } from "./types";

export interface PexelsVideo {
  id: number;
  url: string;
  width: number;
  height: number;
  durationSec: number;
  downloadUrl: string; // best-fit mp4 file
  photographer: string;
}

export interface PexelsPhoto {
  id: number;
  url: string;
  width: number;
  height: number;
  downloadUrl: string; // large2x
  photographer: string;
}

interface PexelsVideoRaw {
  id: number;
  url: string;
  width: number;
  height: number;
  duration: number;
  user: { name: string };
  video_files: { link: string; width: number; height: number; file_type: string }[];
}

interface PexelsPhotoRaw {
  id: number;
  url: string;
  width: number;
  height: number;
  photographer: string;
  src: { large2x?: string; original: string };
}

function headers(): Record<string, string> {
  return { authorization: env.PEXELS_API_KEY };
}

export async function searchVideos(
  query: string,
  orientation: "portrait" | "landscape" | "square" = "portrait",
  perPage = 10,
): Promise<PexelsVideo[]> {
  if (fixtureMode("pexels")) return loadFixture<PexelsVideo[]>("pexels-videos");
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", orientation);
  url.searchParams.set("per_page", String(perPage));
  const json = await fetchJson<{ videos: PexelsVideoRaw[] }>("pexels", url.toString(), {
    headers: headers(),
  });
  await logUsage({ service: "pexels", endpoint: "videos/search", units: 1, costUsd: 0 });
  return json.videos.map((v) => {
    const mp4s = v.video_files
      .filter((f) => f.file_type === "video/mp4")
      .sort((a, b) => b.width * b.height - a.width * a.height);
    const best = mp4s.find((f) => Math.max(f.width, f.height) <= 1920) ?? mp4s[0];
    return {
      id: v.id,
      url: v.url,
      width: v.width,
      height: v.height,
      durationSec: v.duration,
      downloadUrl: best?.link ?? "",
      photographer: v.user.name,
    };
  });
}

export async function searchPhotos(query: string, perPage = 10): Promise<PexelsPhoto[]> {
  if (fixtureMode("pexels")) return loadFixture<PexelsPhoto[]>("pexels-photos");
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  const json = await fetchJson<{ photos: PexelsPhotoRaw[] }>("pexels", url.toString(), {
    headers: headers(),
  });
  await logUsage({ service: "pexels", endpoint: "photos/search", units: 1, costUsd: 0 });
  return json.photos.map((p) => ({
    id: p.id,
    url: p.url,
    width: p.width,
    height: p.height,
    downloadUrl: p.src.large2x ?? p.src.original,
    photographer: p.photographer,
  }));
}

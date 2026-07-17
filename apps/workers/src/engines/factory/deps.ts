// LLM/media bindings for the factory engine, overridable for tests and the
// credential-free demo (doc 13 §2: mock at the @ve/llm boundary).
import { analyzeVideo, embed, generateImage, runStructured, transcribe, tts } from "@ve/llm";

async function fetchStock(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stock download failed ${res.status}: ${url.slice(0, 120)}`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface FactoryDeps {
  runStructured: typeof runStructured;
  embed: typeof embed;
  tts: typeof tts;
  transcribe: typeof transcribe;
  analyzeVideo: typeof analyzeVideo;
  generateImage: typeof generateImage;
  /** download licensed stock media (Pexels CDN) — DI so offline runs generate bytes */
  fetchStock: typeof fetchStock;
}

export const factoryDeps: FactoryDeps = {
  runStructured,
  embed,
  tts,
  transcribe,
  analyzeVideo,
  generateImage,
  fetchStock,
};

export function setFactoryDeps(overrides: Partial<FactoryDeps>): void {
  Object.assign(factoryDeps, overrides);
}

// LLM bindings for the radar engine, overridable for tests and the offline demo
// (doc 13 §2: LLM calls in tests are mocked at the @ve/llm boundary).
import { embed, runStructured, scoreBatch } from "@ve/llm";

export interface RadarDeps {
  embed: typeof embed;
  scoreBatch: typeof scoreBatch;
  runStructured: typeof runStructured;
}

export const radarDeps: RadarDeps = { embed, scoreBatch, runStructured };

export function setRadarDeps(overrides: Partial<RadarDeps>): void {
  Object.assign(radarDeps, overrides);
}

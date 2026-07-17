// Similarity guard (doc 05 §1) — code, not prompt. Idea-not-expression enforcement:
// embedding cosine vs the trend's member items + trigram-shingle containment vs their
// stored texts. Pure math here; the worker wires embeddings in.
import {
  type ScriptsSimilarityReport,
  SIMILARITY_COSINE_MAX,
  SIMILARITY_NGRAM_MAX,
  SIMILARITY_SHINGLE_SIZE,
} from "@ve/core";
import { cosineSimilarity } from "../radar/stats";

export function normalizeForShingles(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[scene \d+\]/g, " ") // scene markers aren't prose
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 0);
}

/** Word trigram shingles (doc 05 §1). */
export function trigramShingles(text: string, n = SIMILARITY_SHINGLE_SIZE): Set<string> {
  const words = normalizeForShingles(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

/** Containment: fraction of the script's shingles that appear in the source. */
export function shingleContainment(script: Set<string>, source: Set<string>): number {
  if (script.size === 0) return 0;
  let hits = 0;
  for (const s of script) if (source.has(s)) hits++;
  return hits / script.size;
}

export interface MemberForGuard {
  rawItemId: string;
  text: string; // stored ≤600-char member snippet (title+text)
  embedding: number[] | null;
}

/** Compare a script body against trend members. Caller supplies the body embedding. */
export function similarityReport(
  bodyEmbedding: number[],
  body: string,
  members: MemberForGuard[],
): ScriptsSimilarityReport {
  const scriptShingles = trigramShingles(body);
  let maxCosine = 0;
  let maxNgramOverlap = 0;
  let vsRawItemId: string | null = null;

  for (const m of members) {
    const cos = m.embedding ? cosineSimilarity(bodyEmbedding, m.embedding) : 0;
    const overlap = shingleContainment(scriptShingles, trigramShingles(m.text));
    const worst = Math.max(cos / SIMILARITY_COSINE_MAX, overlap / SIMILARITY_NGRAM_MAX);
    const currentWorst = Math.max(
      maxCosine / SIMILARITY_COSINE_MAX,
      maxNgramOverlap / SIMILARITY_NGRAM_MAX,
    );
    if (worst > currentWorst) vsRawItemId = m.rawItemId;
    maxCosine = Math.max(maxCosine, cos);
    maxNgramOverlap = Math.max(maxNgramOverlap, overlap);
  }

  return {
    maxCosine: Number(maxCosine.toFixed(4)),
    maxNgramOverlap: Number(maxNgramOverlap.toFixed(4)),
    vsRawItemId,
    pass: maxCosine <= SIMILARITY_COSINE_MAX && maxNgramOverlap <= SIMILARITY_NGRAM_MAX,
  };
}

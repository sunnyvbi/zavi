
import { serviceClient } from "@/services/supabase";
import type { SearchHit } from "./index";

export type LexFallbackHit = {
  chunk_id: string;
  note_id: string;
  title: string;
  body: string;
  score: number;
};

export type LexFallbackResult = {
  hits: LexFallbackHit[];
  mode: "lex_or";
  candidates: number;
};

export async function runLexicalFallback(
  tenant_id: string,
  query: string,
  k: number,
): Promise<LexFallbackResult> {
  try {
    const { data, error } = await serviceClient().rpc("memory_search_lex_or", {
      p_tenant_id: tenant_id,
      p_query: query,
      p_limit: k,
    });
    if (error) {
      console.warn(`[memory] lex_or fallback failed (swallowed): ${error.message}`);
      return { hits: [], mode: "lex_or", candidates: 0 };
    }
    const hits = ((data ?? []) as LexFallbackHit[]).map((h) => ({
      chunk_id: h.chunk_id,
      note_id: h.note_id,
      title: h.title,
      body: h.body,
      score: Number(h.score),
    }));
    return { hits, mode: "lex_or", candidates: hits.length };
  } catch (e) {
    console.warn(`[memory] lex_or fallback threw (swallowed):`, e);
    return { hits: [], mode: "lex_or", candidates: 0 };
  }
}

export function toSearchHits(fallback: LexFallbackResult): SearchHit[] {
  return fallback.hits.map((h) => ({
    chunk_id: h.chunk_id,
    note_id: h.note_id,
    title: h.title,
    body: h.body,
    score: h.score,
  }));
}

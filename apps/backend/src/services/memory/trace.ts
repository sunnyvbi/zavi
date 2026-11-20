
import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";

export type SearchTraceStatus =
  | "ok"
  | "embed_fail"
  | "rpc_error"
  | "timeout"
  | "circuit_open"
  | "no_query";

export type SearchRetrievalMode =
  | "dense"
  | "lex_and"
  | "lex_or"
  | "rerank"
  | "cache"
  | "circuit_open";

export type RerankStatus = "ok" | "timeout" | "error" | "empty_pool" | "skipped_no_budget";

export type SearchTraceInput = {
  tenant_id: string;
  run_id?: string | null;
  agent_slug?: string | null;
  query: string;
  query_l2_norm?: number | null;
  lex_candidates?: number;
  vec_candidates?: number;
  fused_count?: number;
  returned_count?: number;
  latency_ms: number;
  status: SearchTraceStatus;
  error_code?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  retrieval_mode?: SearchRetrievalMode | null;
  fallback_reason?: string | null;
  index_kind?: "none" | "ivfflat" | "hnsw" | null;
  rerank_enabled?: boolean | null;
  pre_rerank_pool_size?: number | null;
  rerank_latency_ms?: number | null;
  rerank_status?: RerankStatus | null;
  rerank_model?: string | null;
  rank_components?: Record<string, unknown> | null;
};

export function hashQuery(tenant_id: string, query: string): string {
  return createHash("sha256")
    .update(tenant_id)
    .update("\0")
    .update(query)
    .digest("hex");
}

export function recordSearchTrace(input: SearchTraceInput): void {
  const row = {
    tenant_id: input.tenant_id,
    run_id: input.run_id ?? null,
    agent_slug: input.agent_slug ?? null,
    query_hash: hashQuery(input.tenant_id, input.query),
    query_l2_norm: input.query_l2_norm ?? null,
    query_length: input.query.length,
    lex_candidates: input.lex_candidates ?? 0,
    vec_candidates: input.vec_candidates ?? 0,
    fused_count: input.fused_count ?? 0,
    returned_count: input.returned_count ?? 0,
    latency_ms: input.latency_ms,
    status: input.status,
    error_code: input.error_code ?? null,
    embedding_model: input.embedding_model ?? null,
    embedding_dim: input.embedding_dim ?? null,
    retrieval_mode: input.retrieval_mode ?? null,
    fallback_reason: input.fallback_reason ?? null,
    index_kind: input.index_kind ?? null,
    rerank_enabled: input.rerank_enabled ?? null,
    pre_rerank_pool_size: input.pre_rerank_pool_size ?? null,
    rerank_latency_ms: input.rerank_latency_ms ?? null,
    rerank_status: input.rerank_status ?? null,
    rerank_model: input.rerank_model ?? null,
    rank_components: input.rank_components ?? null,
  };

  void serviceClient()
    .from("memory_search_trace")
    .insert(row)
    .then(({ error }) => {
      if (error) {
        console.error(
          `[memory_search_trace] insert failed (swallowed) tenant=${input.tenant_id} status=${input.status}: ${error.message}`,
        );
      }
    });
}

export function l2Norm(v: number[] | null | undefined): number {
  if (!v || v.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

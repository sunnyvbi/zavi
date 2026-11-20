
ALTER TABLE memory_search_trace
  ADD COLUMN IF NOT EXISTS rerank_enabled boolean,
  ADD COLUMN IF NOT EXISTS pre_rerank_pool_size int,
  ADD COLUMN IF NOT EXISTS rerank_latency_ms int,
  ADD COLUMN IF NOT EXISTS rerank_status text,
  ADD COLUMN IF NOT EXISTS rerank_model text;

COMMENT ON COLUMN memory_search_trace.pre_rerank_pool_size IS
  'Size of the hybrid_v2 candidate pool handed to the reranker. The pool-coverage denominator — pair with golden expected_note_id presence to compute candidate_recall@pool.';
COMMENT ON COLUMN memory_search_trace.rerank_status IS
  'ok = reranked result served; timeout/error = fell back to baseHits (non-rerank result); empty_pool = hybrid_v2 returned 0, baseHits served.';

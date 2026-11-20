
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS memory_reranker_enabled boolean;

COMMENT ON COLUMN tenants.memory_reranker_enabled IS
  'Per-tenant override for two-stage rerank in hybrid search (Voyage rerank-2.5). NULL = inherit system_config.blob.memory_reranker_enabled_default. See apps/backend/src/services/memory/reranker-flag.ts.';

UPDATE system_config
SET blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{memory_reranker_enabled_default}', 'true'::jsonb, true),
    updated_at = now()
WHERE id = 1;

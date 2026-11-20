
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS brain_eval_backlink_boost boolean;

COMMENT ON COLUMN tenants.brain_eval_backlink_boost IS
  'Per-tenant override for hybrid-search backlink-boost reranking. NULL = inherit system_config.blob.brain_eval_backlink_boost_default. See apps/backend/src/services/memory/backlink-boost-flag.ts.';


ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS brain_eval_recency boolean,
  ADD COLUMN IF NOT EXISTS brain_eval_salience boolean;

COMMENT ON COLUMN tenants.brain_eval_recency IS
  'Per-tenant override for hybrid-search recency-decay boost. NULL = inherit system_config.blob.brain_eval_recency_default. See apps/backend/src/services/memory/recency-flag.ts.';

COMMENT ON COLUMN tenants.brain_eval_salience IS
  'Per-tenant override for hybrid-search salience boost. NULL = inherit system_config.blob.brain_eval_salience_default. See apps/backend/src/services/memory/salience-flag.ts.';

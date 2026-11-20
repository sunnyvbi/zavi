
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS brain_eval_patterns boolean;

COMMENT ON COLUMN tenants.brain_eval_patterns IS
  'Per-tenant override for nightly patterns-phase Sonnet cross-session theme detection. NULL = inherit system_config.blob.brain_eval_patterns_default. See apps/backend/src/services/memory/patterns-flag.ts.';

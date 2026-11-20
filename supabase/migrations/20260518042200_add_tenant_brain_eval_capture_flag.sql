
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS brain_eval_capture boolean;

COMMENT ON COLUMN tenants.brain_eval_capture IS
  'Per-tenant override for brain-eval capture. NULL = inherit system_config.blob.brain_eval_capture_default. See apps/backend/src/services/memory/eval-capture.ts.';

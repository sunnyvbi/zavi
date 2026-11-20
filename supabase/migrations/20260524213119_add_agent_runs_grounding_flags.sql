
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS grounding_flags jsonb;

COMMENT ON COLUMN agent_runs.grounding_flags IS
  'Deterministic grounding-check flags for this run (eval/grounding-checks.ts runGroundingChecks): array of {pattern, severity, detail}. NULL = not scored (pre-wire rows) or zero flags. Observability; HARD flags also set needs_review for validated agents.';

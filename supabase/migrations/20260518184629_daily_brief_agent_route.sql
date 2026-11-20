
ALTER TABLE tenant_brief_dispatches
  ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tenant_brief_dispatches_agent_run_id
  ON tenant_brief_dispatches (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

ALTER TABLE tenant_brief_dispatches
  DROP CONSTRAINT IF EXISTS tenant_brief_dispatches_outcome_check;
ALTER TABLE tenant_brief_dispatches
  ADD CONSTRAINT tenant_brief_dispatches_outcome_check
  CHECK (outcome IN (
    'claimed','agent_running','rendering','sent','suppressed_no_delta','error'
  ));

CREATE OR REPLACE FUNCTION transition_brief_dispatch_state(
  p_id        uuid,
  p_from      text,
  p_to        text,
  p_reason    text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_updated int;
BEGIN
  UPDATE tenant_brief_dispatches
     SET outcome = p_to,
         outcome_reason = COALESCE(p_reason, outcome_reason),
         updated_at = now()
   WHERE id = p_id AND outcome = p_from;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END $$;
REVOKE ALL ON FUNCTION transition_brief_dispatch_state(uuid, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION transition_brief_dispatch_state(uuid, text, text, text) TO service_role;

UPDATE system_config
SET blob = jsonb_set(
  blob,
  '{daily_brief_agent_route_enabled}',
  'false'::jsonb,
  true
),
    updated_at = now()
WHERE id = 1;

UPDATE system_config
SET blob = jsonb_set(blob, '{disabled_agent_slugs}', '[
  "advisor","agent-coach","cohort-analytics","competitor-intel",
  "content-product","customer-support-inbox","fleet-auditor",
  "hiring-partner","lifecycle-crm","pr-reviewer","seo-technical",
  "smoke-echo","social-organic","supply-demand-balancer","support-helper",
  "task-filer"
]'::jsonb),
    updated_at = now()
WHERE id = 1;


update system_config
set blob = jsonb_set(blob, '{brain_eval_recency_default}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

update system_config
set blob = jsonb_set(blob, '{brain_eval_salience_default}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

update system_config
set blob = jsonb_set(
  blob,
  '{brain_eval_recency_decay_map}',
  '{
    "auto_distill_chat":      { "halflifeDays":  7, "coefficient": 1.5 },
    "auto_distill_slack":     { "halflifeDays":  7, "coefficient": 1.5 },
    "auto_distill_agent_run": { "halflifeDays": 14, "coefficient": 1.2 },
    "agent_run":              { "halflifeDays": 30, "coefficient": 1.0 },
    "slack_distill":          { "halflifeDays": 14, "coefficient": 1.2 },
    "email_distill":          { "halflifeDays": 14, "coefficient": 1.0 },
    "operator_feedback":      { "halflifeDays": 60, "coefficient": 0.6 },
    "agent_write":            { "halflifeDays": 30, "coefficient": 0.8 },
    "human":                  { "halflifeDays":180, "coefficient": 0.4 },
    "praxis_staff":           { "halflifeDays":  0, "coefficient": 0.0 },
    "dream_cycle_merge":      { "halflifeDays":180, "coefficient": 0.2 }
  }'::jsonb,
  true
),
    updated_at = now()
where id = 1;

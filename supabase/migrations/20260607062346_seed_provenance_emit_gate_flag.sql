
update system_config
set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{provenance_emit_gate_enabled}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

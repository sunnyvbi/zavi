
update system_config
set blob = jsonb_set(blob, '{pm_interactive_handoff}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

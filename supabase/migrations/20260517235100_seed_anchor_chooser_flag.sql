
update system_config
set blob = jsonb_set(blob, '{onboarding_anchor_chooser}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

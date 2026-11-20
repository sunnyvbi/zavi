
update system_config
set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{user_initiated_spend_apply_enabled}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

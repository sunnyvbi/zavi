
update system_config
set blob = jsonb_set(blob, '{provider_overrides_disabled}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

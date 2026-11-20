update system_config
set blob = jsonb_set(blob, '{google_ads_write_enabled}', 'true'::jsonb, true),
    updated_at = now()
where id = 1;

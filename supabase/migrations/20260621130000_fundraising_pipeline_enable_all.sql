update system_config
set blob = jsonb_set(blob, '{fundraising_pipeline}', 'true'::jsonb, true)
where id = 1;

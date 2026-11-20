
update system_config
set blob = jsonb_set(blob, '{brain_eval_capture_default}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

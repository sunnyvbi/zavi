update system_config
set blob = jsonb_set(blob, '{push_notifications_enabled}', 'true'::jsonb, true),
    updated_at = now()
where id = 1;

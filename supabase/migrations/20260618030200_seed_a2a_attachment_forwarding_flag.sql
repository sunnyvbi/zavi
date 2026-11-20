
update system_config
set blob = jsonb_set(blob, '{a2a_attachment_forwarding}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

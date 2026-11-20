
update system_config
set blob = jsonb_set(blob, '{onboarding_web_enrichment}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;

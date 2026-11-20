
update system_config
set blob = jsonb_set(
      blob,
      '{disabled_agent_slugs}',
      (
        select coalesce(jsonb_agg(distinct elem), '[]'::jsonb)
        from jsonb_array_elements_text(
          coalesce(blob->'disabled_agent_slugs', '[]'::jsonb)
          || '["dispute-response"]'::jsonb
        ) as elem
      )
    ),
    updated_at = now(),
    updated_by = null
where id = 1;

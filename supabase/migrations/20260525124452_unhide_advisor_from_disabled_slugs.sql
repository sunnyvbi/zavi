
update system_config
set blob = jsonb_set(
  blob,
  '{disabled_agent_slugs}',
  coalesce(
    (
      select jsonb_agg(value)
      from jsonb_array_elements_text(blob->'disabled_agent_slugs') v(value)
      where value <> 'advisor'
    ),
    '[]'::jsonb
  )
),
    updated_at = now()
where id = 1;

do $$
declare
  still_hidden bool;
begin
  select exists(
    select 1
    from system_config,
         jsonb_array_elements_text(blob->'disabled_agent_slugs') v(value)
    where id = 1 and value = 'advisor'
  ) into still_hidden;
  if still_hidden then
    raise exception '20260525124452: advisor still present in disabled_agent_slugs after migration';
  end if;
  raise notice '20260525124452: advisor removed from disabled_agent_slugs (or was already absent)';
end $$;

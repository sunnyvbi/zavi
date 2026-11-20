
update system_config
set blob = jsonb_set(
      blob,
      '{disabled_agent_slugs}',
      coalesce(
        (
          select jsonb_agg(value)
          from jsonb_array_elements_text(blob->'disabled_agent_slugs') v(value)
          where value <> 'dispute-response'
        ),
        '[]'::jsonb
      )
    ),
    updated_at = now(),
    updated_by = null
where id = 1;

delete from tenant_agent_kill_switch where agent_slug = 'dispute-response';

do $$
declare
  still_hidden bool;
begin
  select exists(
    select 1
    from system_config,
         jsonb_array_elements_text(blob->'disabled_agent_slugs') v(value)
    where id = 1 and value = 'dispute-response'
  ) into still_hidden;
  if still_hidden then
    raise exception '20260618190000: dispute-response still in disabled_agent_slugs after migration';
  end if;
  raise notice '20260618190000: dispute-response removed from disabled_agent_slugs (now visible to all tenants)';
end $$;

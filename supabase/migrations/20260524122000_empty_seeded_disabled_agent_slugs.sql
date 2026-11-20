
update system_config
set blob = jsonb_set(blob, '{disabled_agent_slugs}', '[]'::jsonb),
    updated_at = now(),
    updated_by = null
where id = 1;

do $$
declare n int;
begin
  select coalesce(jsonb_array_length(blob->'disabled_agent_slugs'), 0) into n
  from system_config where id = 1;
  raise notice '20260524122000: disabled_agent_slugs length after migration = % (expected 0)', n;
end $$;

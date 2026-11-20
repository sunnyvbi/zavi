
update system_config
   set blob = jsonb_set(
                jsonb_set(
                  coalesce(blob, '{}'::jsonb),
                  '{agent_barge_in_enabled}',
                  'true'::jsonb,
                  true),
                '{agent_barge_in_disabled_tenants}',
                coalesce(blob->'agent_barge_in_disabled_tenants', '[]'::jsonb),
                true)
 where id = 1;

insert into system_config (id, blob)
select 1, '{"agent_barge_in_enabled": true, "agent_barge_in_disabled_tenants": []}'::jsonb
where not exists (select 1 from system_config where id = 1);

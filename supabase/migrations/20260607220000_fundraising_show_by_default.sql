
update system_config
set blob = jsonb_set(
  blob,
  '{disabled_agent_slugs}',
  coalesce((blob->'disabled_agent_slugs'), '[]'::jsonb) - 'fundraising'
)
where id = 1
  and (blob->'disabled_agent_slugs') ? 'fundraising';

delete from tenant_agent_kill_switch where agent_slug = 'fundraising';

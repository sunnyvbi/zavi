
create or replace function _social_publish_enabled()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select not coalesce((select (blob->>'social_publish_paused')::boolean from system_config where id = 1), false);
$$;

revoke all on function _social_publish_enabled() from public;
grant execute on function _social_publish_enabled() to service_role;

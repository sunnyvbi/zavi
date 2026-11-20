
create or replace function set_browser_session_provider_id(
  p_session_id uuid,
  p_provider_session_id text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update browser_sessions
     set provider_session_id = p_provider_session_id
   where id = p_session_id
     and status = 'open'
     and provider_session_id is null;
end $$;

revoke execute on function set_browser_session_provider_id(uuid, text)
  from public, anon, authenticated;
grant execute on function set_browser_session_provider_id(uuid, text)
  to service_role;

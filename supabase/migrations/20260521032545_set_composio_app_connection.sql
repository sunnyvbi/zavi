
begin;

create or replace function set_composio_app_connection(
  p_tenant_id uuid,
  p_toolkit text,
  p_connected_account_id text,
  p_url text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_slug text := 'composio.' || lower(p_toolkit);
begin
  if p_tenant_id is null or p_toolkit is null or p_connected_account_id is null or p_url is null then
    raise exception 'set_composio_app_connection: all params required';
  end if;

  insert into connector_metadata (tenant_id, slug, team_id, connected_at)
  values (p_tenant_id, v_slug, p_connected_account_id, now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
  values (p_tenant_id, 'composio', 'streamable-http'::mcp_transport, p_url, null, null)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport,
                url       = excluded.url,
                command   = excluded.command,
                args      = excluded.args,
                enabled   = true;
end $$;

revoke all on function set_composio_app_connection(uuid, text, text, text) from public;

drop function if exists set_composio_connection(uuid, text, text);

commit;

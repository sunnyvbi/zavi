
begin;

create or replace function set_pipedream_app_connection(
  p_tenant_id uuid,
  p_app_slug text,
  p_server_id text,
  p_account_id text,
  p_url text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_slug text := 'pipedream.' || lower(p_app_slug);
begin
  if p_tenant_id is null or p_app_slug is null or p_server_id is null
     or p_account_id is null or p_url is null then
    raise exception 'set_pipedream_app_connection: all params required';
  end if;
  if p_server_id !~ '^pipedream_[a-z0-9_]+$' then
    raise exception 'set_pipedream_app_connection: invalid server_id %', p_server_id;
  end if;

  insert into connector_metadata (tenant_id, slug, team_id, connected_at)
  values (p_tenant_id, v_slug, p_account_id, now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
  values (p_tenant_id, p_server_id, 'streamable-http'::mcp_transport, p_url, null, array[lower(p_app_slug)])
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport,
                url       = excluded.url,
                command   = excluded.command,
                args      = excluded.args,
                enabled   = true;
end $$;

revoke all on function set_pipedream_app_connection(uuid, text, text, text, text) from public;

commit;

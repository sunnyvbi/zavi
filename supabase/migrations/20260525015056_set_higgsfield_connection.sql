
create or replace function set_higgsfield_connection(
  p_tenant_id    uuid,
  p_access_token text,
  p_workspace_id text,
  p_workspace_name text default null
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_old_id uuid; v_new_id uuid;
begin
  if p_tenant_id is null or p_access_token is null or length(p_access_token) = 0 then
    raise exception 'set_higgsfield_connection: null/empty argument' using errcode = '22023';
  end if;

  select vault_secret_id into v_old_id from secrets
  where tenant_id = p_tenant_id and key = 'higgsfield.access_token';
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = 'higgsfield.access_token';
  end if;

  v_new_id := vault.create_secret(p_access_token);

  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'higgsfield.access_token', v_new_id);

  insert into connector_metadata
    (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values
    (p_tenant_id, 'higgsfield', p_workspace_id, p_workspace_name, array[]::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id      = excluded.team_id,
                team_name    = excluded.team_name,
                scopes       = excluded.scopes,
                connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
  values (p_tenant_id, 'higgsfield', 'streamable-http'::mcp_transport,
          'https://mcp.higgsfield.ai/mcp', null, null)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport,
                url       = excluded.url,
                command   = excluded.command,
                args      = excluded.args,
                enabled   = true;
end $$;
revoke all on function set_higgsfield_connection(uuid, text, text, text) from public;
grant execute on function set_higgsfield_connection(uuid, text, text, text) to service_role;

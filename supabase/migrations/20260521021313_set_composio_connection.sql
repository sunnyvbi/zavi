
create or replace function set_composio_connection(
  p_tenant_id uuid,
  p_api_key text,
  p_url text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_old_id uuid; v_new_id uuid;
begin
  select vault_secret_id into v_old_id from secrets
  where tenant_id = p_tenant_id and key = 'composio.api_key';
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = 'composio.api_key';
  end if;

  v_new_id := vault.create_secret(p_api_key);

  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'composio.api_key', v_new_id);

  insert into connector_metadata (tenant_id, slug, connected_at)
  values (p_tenant_id, 'composio', now())
  on conflict (tenant_id, slug)
  do update set connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
  values (p_tenant_id, 'composio', 'streamable-http'::mcp_transport, p_url, null, null)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport,
                url       = excluded.url,
                command   = excluded.command,
                args      = excluded.args,
                enabled   = true;
end $$;

revoke all on function set_composio_connection(uuid, text, text) from public;

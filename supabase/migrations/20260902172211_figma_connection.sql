
create or replace function set_figma_connection(
  p_tenant_id uuid,
  p_api_key text,
  p_handle text default null
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_old_id uuid; v_new_id uuid;
begin
  select vault_secret_id into v_old_id from secrets
  where tenant_id = p_tenant_id and key = 'figma.api_key';
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = 'figma.api_key';
  end if;

  v_new_id := vault.create_secret(p_api_key);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'figma.api_key', v_new_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (
    p_tenant_id,
    'figma',
    null,
    coalesce(p_handle, 'Figma'),
    array['current_user:read', 'file_content:read', 'projects:read']::text[],
    now()
  )
  on conflict (tenant_id, slug)
  do update set
    team_id = excluded.team_id,
    team_name = excluded.team_name,
    scopes = excluded.scopes,
    connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args, enabled)
  values (p_tenant_id, 'figma', 'internal'::mcp_transport, null, null, null, true)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport, enabled = true;
end $$;

revoke all on function set_figma_connection(uuid, text, text) from public;

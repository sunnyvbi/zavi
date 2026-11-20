
create or replace function set_google_sheets_connection(
  p_tenant_id uuid,
  p_refresh_token text
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid; v_new uuid;
begin
  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_sheets.refresh_token';
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = 'google_sheets.refresh_token';
  end if;
  v_new := vault.create_secret(p_refresh_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_sheets.refresh_token', v_new);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'google_sheets', null, 'Google Sheets', array['spreadsheets.readonly']::text[], now())
  on conflict (tenant_id, slug)
  do update set scopes = excluded.scopes, connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'google_sheets', 'internal'::mcp_transport, true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

revoke all on function set_google_sheets_connection(uuid, text) from public;

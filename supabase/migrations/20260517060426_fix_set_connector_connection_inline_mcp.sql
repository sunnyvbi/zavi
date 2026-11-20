
create or replace function set_connector_connection(
  p_tenant_id uuid,
  p_slug text,
  p_server_id text,
  p_secrets jsonb,
  p_expires_at timestamptz,
  p_team_id text,
  p_team_name text,
  p_scopes text[]
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_key text;
  v_val text;
  v_old_id uuid;
  v_new_id uuid;
begin
  for v_key, v_val in select * from jsonb_each_text(p_secrets) loop
    if v_key not like p_slug || '.%' then
      raise exception 'set_connector_connection: secret key % is not prefixed %.', v_key, p_slug;
    end if;

    select vault_secret_id into v_old_id from secrets
    where tenant_id = p_tenant_id and key = v_key;
    if v_old_id is not null then
      delete from vault.secrets where id = v_old_id;
      delete from secrets where tenant_id = p_tenant_id and key = v_key;
    end if;

    v_new_id := vault.create_secret(v_val);
    insert into secrets (tenant_id, key, vault_secret_id)
    values (p_tenant_id, v_key, v_new_id);
  end loop;

  insert into connector_metadata
    (tenant_id, slug, team_id, team_name, scopes, token_expires_at, connected_at)
  values
    (p_tenant_id, p_slug, p_team_id, p_team_name, p_scopes, p_expires_at, now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                team_name = excluded.team_name,
                scopes = excluded.scopes,
                token_expires_at = excluded.token_expires_at,
                connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (
    tenant_id, server_id, transport, url, command, args
  ) values (
    p_tenant_id, p_server_id, 'internal'::mcp_transport, null, null, null
  )
  on conflict (tenant_id, server_id)
  do update set
    transport = excluded.transport,
    url = excluded.url,
    command = excluded.command,
    args = excluded.args,
    enabled = true;
end $$;
revoke all on function set_connector_connection(uuid, text, text, jsonb, timestamptz, text, text, text[]) from public;

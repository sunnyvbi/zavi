
create or replace function set_sentry_connection(
  p_tenant_id uuid,
  p_auth_token text,
  p_org_slug text
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_old_id uuid; v_new_id uuid; v_key text;
begin
  if p_org_slug is null or length(trim(p_org_slug)) = 0 then
    raise exception 'sentry org_slug must not be empty';
  end if;

  foreach v_key in array array['sentry.auth_token', 'sentry.org_slug'] loop
    select vault_secret_id into v_old_id from secrets
    where tenant_id = p_tenant_id and key = v_key;
    if v_old_id is not null then
      delete from vault.secrets where id = v_old_id;
      delete from secrets where tenant_id = p_tenant_id and key = v_key;
    end if;
  end loop;

  v_new_id := vault.create_secret(p_auth_token);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'sentry.auth_token', v_new_id);

  v_new_id := vault.create_secret(p_org_slug);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'sentry.org_slug', v_new_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (
    p_tenant_id,
    'sentry',
    p_org_slug,
    'Sentry (' || p_org_slug || ')',
    array['org:read', 'project:read', 'event:read']::text[],
    now()
  )
  on conflict (tenant_id, slug)
  do update set
    team_id = excluded.team_id,
    team_name = excluded.team_name,
    scopes = excluded.scopes,
    connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args, enabled)
  values (p_tenant_id, 'sentry', 'internal'::mcp_transport, null, null, null, true)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport, enabled = true;
end $$;

revoke all on function set_sentry_connection(uuid, text, text) from public;

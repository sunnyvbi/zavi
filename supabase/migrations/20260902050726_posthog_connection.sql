
create or replace function set_posthog_connection(
  p_tenant_id uuid,
  p_api_key text,
  p_project_id text,
  p_region text
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_old_id uuid; v_new_id uuid; v_key text;
begin
  if p_region not in ('us', 'eu') then
    raise exception 'posthog region must be us or eu, got %', p_region;
  end if;

  foreach v_key in array array['posthog.api_key', 'posthog.project_id', 'posthog.region'] loop
    select vault_secret_id into v_old_id from secrets
    where tenant_id = p_tenant_id and key = v_key;
    if v_old_id is not null then
      delete from vault.secrets where id = v_old_id;
      delete from secrets where tenant_id = p_tenant_id and key = v_key;
    end if;
  end loop;

  v_new_id := vault.create_secret(p_api_key);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'posthog.api_key', v_new_id);

  v_new_id := vault.create_secret(p_project_id);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'posthog.project_id', v_new_id);

  v_new_id := vault.create_secret(p_region);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'posthog.region', v_new_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (
    p_tenant_id,
    'posthog',
    p_project_id,
    'PostHog (' || upper(p_region) || ')',
    array['query:read', 'project:read']::text[],
    now()
  )
  on conflict (tenant_id, slug)
  do update set
    team_id = excluded.team_id,
    team_name = excluded.team_name,
    scopes = excluded.scopes,
    connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args, enabled)
  values (p_tenant_id, 'posthog', 'internal'::mcp_transport, null, null, null, true)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport, enabled = true;
end $$;

revoke all on function set_posthog_connection(uuid, text, text, text) from public;

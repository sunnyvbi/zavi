

create or replace function set_google_calendar_connection(
  p_tenant_id uuid,
  p_refresh_token text,
  p_calendar_id text
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_old_id uuid; v_new_id uuid; v_key text;
begin
  foreach v_key in array array['google_calendar.refresh_token', 'google_calendar.calendar_id'] loop
    select vault_secret_id into v_old_id from secrets
    where tenant_id = p_tenant_id and key = v_key;
    if v_old_id is not null then
      delete from vault.secrets where id = v_old_id;
      delete from secrets where tenant_id = p_tenant_id and key = v_key;
    end if;
  end loop;

  v_new_id := vault.create_secret(p_refresh_token);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'google_calendar.refresh_token', v_new_id);

  v_new_id := vault.create_secret(p_calendar_id);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'google_calendar.calendar_id', v_new_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'google_calendar', p_calendar_id, 'Google Calendar', array['calendar.readonly']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args, enabled)
  values (p_tenant_id, 'google_calendar', 'internal'::mcp_transport, null, null, null, true)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport, enabled = true;
end $$;

revoke all on function set_google_calendar_connection(uuid, text, text) from public;

create table if not exists google_calendar_pending_connections (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  refresh_token text not null,
  calendar_ids  text[] not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '10 minutes'
);

alter table google_calendar_pending_connections enable row level security;
revoke all on google_calendar_pending_connections from public, anon, authenticated;

create or replace function consume_google_calendar_pending(p_id uuid)
returns table(tenant_id uuid, user_id uuid, refresh_token text, calendar_ids text[])
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    delete from google_calendar_pending_connections g
    where g.id = p_id and g.expires_at > now()
    returning g.tenant_id, g.user_id, g.refresh_token, g.calendar_ids;
end $$;

revoke all on function consume_google_calendar_pending(uuid) from public;

create or replace function cleanup_expired_google_calendar_pending()
returns int language plpgsql as $$
declare v_count int;
begin
  delete from google_calendar_pending_connections where expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

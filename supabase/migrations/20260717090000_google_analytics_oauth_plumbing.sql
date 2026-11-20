

drop function if exists set_google_analytics_connection(uuid, text, text);

create or replace function set_google_analytics_connection(
  p_tenant_id uuid,
  p_refresh_token text,
  p_property_id text
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid; v_new uuid;
begin
  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_analytics.refresh_token';
  if v_old is not null then perform vault.delete_secret(v_old); delete from secrets where tenant_id = p_tenant_id and key = 'google_analytics.refresh_token'; end if;
  v_new := vault.create_secret(p_refresh_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_analytics.refresh_token', v_new);

  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_analytics.property_id';
  if v_old is not null then perform vault.delete_secret(v_old); delete from secrets where tenant_id = p_tenant_id and key = 'google_analytics.property_id'; end if;
  v_new := vault.create_secret(p_property_id);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_analytics.property_id', v_new);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'google_analytics', p_property_id, 'Google Analytics', array['analytics.readonly']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'google_analytics', 'internal', true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

revoke all on function set_google_analytics_connection(uuid, text, text) from public;

insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
select tenant_id, 'google_analytics', 'internal', true
from connector_metadata
where slug = 'google_analytics'
on conflict (tenant_id, server_id) do update set
  transport = excluded.transport,
  enabled   = true;

create table if not exists google_analytics_pending_connections (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  refresh_token text not null,
  property_ids  text[] not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '10 minutes'
);

alter table google_analytics_pending_connections enable row level security;
revoke all on google_analytics_pending_connections from public, anon, authenticated;

create or replace function consume_google_analytics_pending(p_id uuid)
returns table(tenant_id uuid, user_id uuid, refresh_token text, property_ids text[])
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    delete from google_analytics_pending_connections g
    where g.id = p_id and g.expires_at > now()
    returning g.tenant_id, g.user_id, g.refresh_token, g.property_ids;
end $$;

revoke all on function consume_google_analytics_pending(uuid) from public;

create or replace function cleanup_expired_google_analytics_pending()
returns int language plpgsql as $$
declare v_count int;
begin
  delete from google_analytics_pending_connections where expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

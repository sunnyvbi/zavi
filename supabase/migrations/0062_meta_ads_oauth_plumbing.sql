

create or replace function set_meta_ads_connection(
  p_tenant_id uuid,
  p_access_token text,
  p_ad_account_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old_at uuid; v_new_at uuid;
  v_old_aa uuid; v_new_aa uuid;
begin
  select vault_secret_id into v_old_at from secrets where tenant_id = p_tenant_id and key = 'meta_ads.access_token';
  if v_old_at is not null then perform vault.delete_secret(v_old_at); delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.access_token'; end if;
  v_new_at := vault.create_secret(p_access_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'meta_ads.access_token', v_new_at);

  select vault_secret_id into v_old_aa from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id';
  if v_old_aa is not null then perform vault.delete_secret(v_old_aa); delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id'; end if;
  v_new_aa := vault.create_secret(p_ad_account_id);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'meta_ads.ad_account_id', v_new_aa);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'meta_ads', p_ad_account_id, 'Meta Ads', array['ads_read', 'ads_management']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'meta_ads', 'internal', true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

revoke all on function set_meta_ads_connection(uuid, text, text) from public;

insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
select tenant_id, 'meta_ads', 'internal', true
from connector_metadata
where slug = 'meta_ads'
on conflict (tenant_id, server_id) do update set
  transport = excluded.transport,
  enabled   = true;

create table if not exists meta_ads_pending_connections (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  long_token  text not null,
  account_ids text[] not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes'
);

alter table meta_ads_pending_connections enable row level security;
revoke all on meta_ads_pending_connections from public, anon, authenticated;

create or replace function consume_meta_ads_pending(p_id uuid)
returns table(tenant_id uuid, long_token text, account_ids text[])
language plpgsql security definer set search_path = public as $$
begin
  return query
    delete from meta_ads_pending_connections m
    where m.id = p_id and m.expires_at > now()
    returning m.tenant_id, m.long_token, m.account_ids;
end $$;

revoke all on function consume_meta_ads_pending(uuid) from public;

create or replace function cleanup_expired_meta_ads_pending()
returns int language plpgsql as $$
declare
  v_count int;
begin
  delete from meta_ads_pending_connections where expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

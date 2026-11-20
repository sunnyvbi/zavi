

drop function if exists set_google_ads_connection(uuid, text, text, text, text);
drop function if exists set_google_ads_connection(uuid, text, text, text, text, text, text);

create or replace function set_google_ads_connection(
  p_tenant_id uuid,
  p_refresh_token text,
  p_customer_id text,
  p_login_customer_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old uuid; v_new uuid;
begin
  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_ads.refresh_token';
  if v_old is not null then perform vault.delete_secret(v_old); delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.refresh_token'; end if;
  v_new := vault.create_secret(p_refresh_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.refresh_token', v_new);

  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_ads.customer_id';
  if v_old is not null then perform vault.delete_secret(v_old); delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.customer_id'; end if;
  v_new := vault.create_secret(p_customer_id);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.customer_id', v_new);

  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_ads.login_customer_id';
  if v_old is not null then perform vault.delete_secret(v_old); delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.login_customer_id'; end if;
  if p_login_customer_id is not null and length(p_login_customer_id) > 0 then
    v_new := vault.create_secret(p_login_customer_id);
    insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.login_customer_id', v_new);
  end if;

  for v_old in
    select vault_secret_id from secrets
    where tenant_id = p_tenant_id and key in (
      'google_ads.access_token', 'google_ads.developer_token',
      'google_ads.client_id', 'google_ads.client_secret'
    )
  loop
    perform vault.delete_secret(v_old);
  end loop;
  delete from secrets where tenant_id = p_tenant_id
    and key in (
      'google_ads.access_token', 'google_ads.developer_token',
      'google_ads.client_id', 'google_ads.client_secret'
    );

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'google_ads', p_customer_id, 'Google Ads', array['adwords']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'google_ads', 'internal', true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

revoke all on function set_google_ads_connection(uuid, text, text, text) from public;

insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
select tenant_id, 'google_ads', 'internal', true
from connector_metadata
where slug = 'google_ads'
on conflict (tenant_id, server_id) do update set
  transport = excluded.transport,
  enabled   = true;

do $$
declare r record;
begin
  for r in
    select s.vault_secret_id from secrets s
    where s.key in ('google_ads.access_token','google_ads.developer_token',
                     'google_ads.client_id','google_ads.client_secret')
  loop
    perform vault.delete_secret(r.vault_secret_id);
  end loop;
  delete from secrets
   where key in ('google_ads.access_token','google_ads.developer_token',
                 'google_ads.client_id','google_ads.client_secret');
end $$;

create table if not exists google_ads_pending_connections (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  refresh_token text not null,
  customer_ids text[] not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '10 minutes'
);

alter table google_ads_pending_connections enable row level security;
revoke all on google_ads_pending_connections from public, anon, authenticated;

create or replace function consume_google_ads_pending(p_id uuid)
returns table(tenant_id uuid, user_id uuid, refresh_token text, customer_ids text[])
language plpgsql security definer set search_path = public as $$
begin
  return query
    delete from google_ads_pending_connections g
    where g.id = p_id and g.expires_at > now()
    returning g.tenant_id, g.user_id, g.refresh_token, g.customer_ids;
end $$;

revoke all on function consume_google_ads_pending(uuid) from public;

create or replace function cleanup_expired_google_ads_pending()
returns int language plpgsql as $$
declare v_count int;
begin
  delete from google_ads_pending_connections where expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

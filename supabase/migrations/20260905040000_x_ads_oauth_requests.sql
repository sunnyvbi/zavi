
create table if not exists x_ads_oauth_requests (
  request_token        text primary key,
  request_token_secret text not null,
  tenant_id            uuid not null references tenants(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now()
);
alter table x_ads_oauth_requests enable row level security;
revoke all on table x_ads_oauth_requests from public, anon, authenticated;

create or replace function mint_x_ads_oauth_request(
  p_tenant_id uuid,
  p_user_id uuid,
  p_request_token text,
  p_request_token_secret text,
  p_ttl_seconds int
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_request_token is null or p_request_token_secret is null then
    raise exception 'mint_x_ads_oauth_request: token and secret required' using errcode = '22023';
  end if;
  delete from x_ads_oauth_requests where expires_at < now();
  insert into x_ads_oauth_requests (request_token, request_token_secret, tenant_id, user_id, expires_at)
  values (p_request_token, p_request_token_secret, p_tenant_id, p_user_id,
          now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 900))));
end $$;
revoke all on function mint_x_ads_oauth_request(uuid, uuid, text, text, int) from public;
grant execute on function mint_x_ads_oauth_request(uuid, uuid, text, text, int) to service_role;

create or replace function consume_x_ads_oauth_request(p_request_token text)
returns table (tenant_id uuid, user_id uuid, request_token_secret text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  delete from x_ads_oauth_requests r
  where r.request_token = p_request_token and r.expires_at > now()
  returning r.tenant_id, r.user_id, r.request_token_secret;
end $$;
revoke all on function consume_x_ads_oauth_request(text) from public;
grant execute on function consume_x_ads_oauth_request(text) to service_role;

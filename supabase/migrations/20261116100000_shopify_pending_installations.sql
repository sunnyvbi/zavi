
create table public.shopify_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  shop text not null check (shop ~ '^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index shopify_oauth_states_expires_at_idx
  on public.shopify_oauth_states (expires_at);

alter table public.shopify_oauth_states enable row level security;
revoke all on table public.shopify_oauth_states from public, anon, authenticated;

create table public.shopify_pending_installations (
  id uuid primary key default gen_random_uuid(),
  shop text not null unique check (shop ~ '^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$'),
  generation bigint not null default 1 check (generation > 0),
  access_token_key text,
  refresh_token_key text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  composio_account_id text,
  superseded_composio_account_ids text[] not null default '{}',
  claimed_tenant_id uuid references public.tenants(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shopify_pending_installations enable row level security;
revoke all on table public.shopify_pending_installations from public, anon, authenticated;

create or replace function public.mint_shopify_oauth_state(
  p_state_hash text,
  p_shop text,
  p_ttl_seconds integer default 600
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_state_hash !~ '^[0-9a-f]{64}$'
     or p_shop !~ '^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$'
     or p_ttl_seconds < 60
     or p_ttl_seconds > 1800 then
    raise exception 'mint_shopify_oauth_state: invalid argument' using errcode = '22023';
  end if;

  delete from public.shopify_oauth_states where expires_at <= now();
  insert into public.shopify_oauth_states (state_hash, shop, expires_at)
  values (p_state_hash, p_shop, now() + make_interval(secs => p_ttl_seconds));
end $$;

create or replace function public.consume_shopify_oauth_state(
  p_state_hash text,
  p_shop text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_consumed boolean;
begin
  with gone as (
    delete from public.shopify_oauth_states
    where state_hash = p_state_hash
      and shop = p_shop
      and expires_at > now()
    returning 1
  )
  select exists(select 1 from gone) into v_consumed;
  return v_consumed;
end $$;

create or replace function public.store_shopify_pending_installation(
  p_shop text,
  p_access_token text,
  p_refresh_token text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz,
  p_scopes text[]
) returns table (
  installation_id uuid,
  installation_generation bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.shopify_pending_installations%rowtype;
  v_id uuid;
  v_generation bigint;
  v_access_key text;
  v_refresh_key text;
begin
  if p_shop !~ '^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$'
     or coalesce(length(p_access_token), 0) = 0
     or coalesce(length(p_refresh_token), 0) = 0
     or p_access_token_expires_at <= now()
     or p_refresh_token_expires_at <= now() then
    raise exception 'store_shopify_pending_installation: invalid argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('shopify:' || p_shop, 0));
  select * into v_existing
  from public.shopify_pending_installations
  where shop = p_shop
  for update;

  v_id := coalesce(v_existing.id, gen_random_uuid());
  v_access_key := 'shopify-pending:' || v_id::text || ':access';
  v_refresh_key := 'shopify-pending:' || v_id::text || ':refresh';
  perform public.set_platform_secret(v_access_key, p_access_token, jsonb_build_object('shop', p_shop));
  perform public.set_platform_secret(v_refresh_key, p_refresh_token, jsonb_build_object('shop', p_shop));

  if v_existing.id is null then
    insert into public.shopify_pending_installations (
      id, shop, access_token_key, refresh_token_key,
      access_token_expires_at, refresh_token_expires_at, scopes
    ) values (
      v_id, p_shop, v_access_key, v_refresh_key,
      p_access_token_expires_at, p_refresh_token_expires_at, coalesce(p_scopes, '{}')
    )
    returning generation into v_generation;
  else
    update public.shopify_pending_installations
    set generation = v_existing.generation + 1,
        access_token_key = v_access_key,
        refresh_token_key = v_refresh_key,
        access_token_expires_at = p_access_token_expires_at,
        refresh_token_expires_at = p_refresh_token_expires_at,
        scopes = coalesce(p_scopes, '{}'),
        superseded_composio_account_ids = case
          when v_existing.access_token_key is not null and v_existing.composio_account_id is not null
            then array_append(v_existing.superseded_composio_account_ids, v_existing.composio_account_id)
          else v_existing.superseded_composio_account_ids
        end,
        composio_account_id = null,
        claimed_tenant_id = v_existing.claimed_tenant_id,
        claimed_at = v_existing.claimed_at,
        updated_at = now()
    where id = v_existing.id
    returning generation into v_generation;
  end if;

  installation_id := v_id;
  installation_generation := v_generation;
  return next;
end $$;

create or replace function public.get_shopify_pending_installation(
  p_installation_id uuid,
  p_generation bigint
) returns table (
  shop text,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scopes text[],
  composio_account_id text,
  superseded_composio_account_ids text[]
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select i.shop,
         public.get_platform_secret(i.access_token_key),
         public.get_platform_secret(i.refresh_token_key),
         i.access_token_expires_at,
         i.refresh_token_expires_at,
         i.scopes,
         i.composio_account_id,
         i.superseded_composio_account_ids
  from public.shopify_pending_installations i
  where i.id = p_installation_id
    and i.generation = p_generation
    and i.access_token_key is not null
    and i.refresh_token_key is not null
    and public.get_platform_secret(i.access_token_key) is not null
    and public.get_platform_secret(i.refresh_token_key) is not null
$$;

create or replace function public.get_shopify_installation_status(
  p_installation_id uuid,
  p_generation bigint
) returns table (
  shop text,
  composio_account_id text,
  claimed_tenant_id uuid,
  claimed_at timestamptz,
  has_pending_grant boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select i.shop, i.composio_account_id, i.claimed_tenant_id, i.claimed_at,
         i.access_token_key is not null and i.refresh_token_key is not null
  from public.shopify_pending_installations i
  where i.id = p_installation_id
    and i.generation = p_generation
$$;

create or replace function public.reserve_shopify_pending_installation(
  p_installation_id uuid,
  p_generation bigint,
  p_tenant_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_pending_installations%rowtype;
begin
  select * into v_row
  from public.shopify_pending_installations
  where id = p_installation_id and generation = p_generation
  for update;

  if v_row.id is null
     or v_row.access_token_key is null
     or v_row.refresh_token_key is null then
    return false;
  end if;
  if v_row.claimed_tenant_id is not null
     and v_row.claimed_tenant_id <> p_tenant_id
     and (v_row.claimed_at is not null or v_row.updated_at > now() - interval '1 hour') then
    return false;
  end if;

  update public.shopify_pending_installations
  set claimed_tenant_id = p_tenant_id,
      updated_at = now()
  where id = v_row.id;
  return true;
end $$;

create or replace function public.rotate_shopify_pending_tokens(
  p_installation_id uuid,
  p_generation bigint,
  p_expected_refresh_token text,
  p_access_token text,
  p_refresh_token text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_pending_installations%rowtype;
begin
  select * into v_row
  from public.shopify_pending_installations
  where id = p_installation_id and generation = p_generation
  for update;
  if v_row.id is null or v_row.access_token_key is null or v_row.refresh_token_key is null then return false; end if;

  if public.get_platform_secret(v_row.refresh_token_key) is distinct from p_expected_refresh_token then return false; end if;

  perform public.set_platform_secret(v_row.access_token_key, p_access_token, jsonb_build_object('shop', v_row.shop));
  perform public.set_platform_secret(v_row.refresh_token_key, p_refresh_token, jsonb_build_object('shop', v_row.shop));

  update public.shopify_pending_installations
  set access_token_expires_at = p_access_token_expires_at,
      refresh_token_expires_at = p_refresh_token_expires_at,
      updated_at = now()
  where id = v_row.id;
  return true;
end $$;

create or replace function public.set_shopify_pending_composio_account(
  p_installation_id uuid,
  p_generation bigint,
  p_tenant_id uuid,
  p_composio_account_id text,
  p_previous_composio_account_id text default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.shopify_pending_installations
  set composio_account_id = p_composio_account_id,
      superseded_composio_account_ids = case
        when coalesce(length(p_previous_composio_account_id), 0) > 0
          and p_previous_composio_account_id <> p_composio_account_id
          and not (p_previous_composio_account_id = any(superseded_composio_account_ids))
          then array_append(superseded_composio_account_ids, p_previous_composio_account_id)
        else superseded_composio_account_ids
      end,
      updated_at = now()
  where id = p_installation_id
    and generation = p_generation
    and claimed_tenant_id = p_tenant_id
    and access_token_key is not null
    and refresh_token_key is not null
    and (composio_account_id is null or composio_account_id = p_composio_account_id)
    and coalesce(length(p_composio_account_id), 0) > 0;
  return found;
end $$;

create or replace function public.complete_shopify_pending_installation(
  p_installation_id uuid,
  p_generation bigint,
  p_tenant_id uuid,
  p_composio_account_id text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_pending_installations%rowtype;
begin
  select * into v_row
  from public.shopify_pending_installations
  where id = p_installation_id and generation = p_generation
  for update;
  if v_row.id is null then return false; end if;

  if v_row.claimed_at is not null then
    if v_row.claimed_tenant_id <> p_tenant_id then return false; end if;
    if v_row.access_token_key is null or v_row.refresh_token_key is null then
      return v_row.composio_account_id = p_composio_account_id;
    end if;
  end if;

  if v_row.claimed_tenant_id is distinct from p_tenant_id
     or v_row.access_token_key is null
     or v_row.refresh_token_key is null then
    return false;
  end if;

  perform public.delete_platform_secret(v_row.access_token_key);
  perform public.delete_platform_secret(v_row.refresh_token_key);

  update public.shopify_pending_installations
  set access_token_key = null,
      refresh_token_key = null,
      access_token_expires_at = null,
      refresh_token_expires_at = null,
      claimed_tenant_id = p_tenant_id,
      claimed_at = now(),
      composio_account_id = p_composio_account_id,
      superseded_composio_account_ids = '{}',
      updated_at = now()
  where id = v_row.id;
  return true;
end $$;

create or replace function public.delete_shopify_pending_installation_for_shop(
  p_shop text
) returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_pending_installations%rowtype;
begin
  delete from public.shopify_pending_installations
  where shop = p_shop
  returning * into v_row;
  if v_row.id is null then return '{}'; end if;
  if v_row.access_token_key is not null then perform public.delete_platform_secret(v_row.access_token_key); end if;
  if v_row.refresh_token_key is not null then perform public.delete_platform_secret(v_row.refresh_token_key); end if;
  return array_remove(
    v_row.superseded_composio_account_ids || array[v_row.composio_account_id],
    null
  );
end $$;

create or replace function public.list_shopify_pending_composio_accounts_for_shop(
  p_shop text
) returns text[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select array_remove(i.superseded_composio_account_ids || array[i.composio_account_id], null)
     from public.shopify_pending_installations i
     where i.shop = p_shop),
    '{}'::text[]
  )
$$;

create table public.shopify_privacy_requests (
  id uuid primary key default gen_random_uuid(),
  shop text not null check (shop ~ '^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$'),
  topic text not null check (topic in ('customers/data_request', 'customers/redact', 'shop/redact')),
  shopify_shop_id text,
  shopify_request_id text,
  customer_id text,
  customer_email text,
  customer_phone text,
  order_ids text[] not null default '{}',
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  completion_note text,
  unique (topic, shop, shopify_request_id, customer_id)
);

create index shopify_privacy_requests_open_idx
  on public.shopify_privacy_requests (received_at)
  where completed_at is null;

alter table public.shopify_privacy_requests enable row level security;
revoke all on table public.shopify_privacy_requests from public, anon, authenticated;

create or replace function public.record_shopify_privacy_request(
  p_shop text,
  p_topic text,
  p_shopify_shop_id text,
  p_shopify_request_id text,
  p_customer_id text,
  p_customer_email text,
  p_customer_phone text,
  p_order_ids text[]
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_shop !~ '^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$'
     or p_topic not in ('customers/data_request', 'customers/redact', 'shop/redact') then
    raise exception 'record_shopify_privacy_request: invalid argument' using errcode = '22023';
  end if;

  insert into public.shopify_privacy_requests (
    shop, topic, shopify_shop_id, shopify_request_id, customer_id, customer_email, customer_phone, order_ids
  ) values (
    p_shop, p_topic, p_shopify_shop_id, p_shopify_request_id, p_customer_id, p_customer_email, p_customer_phone, coalesce(p_order_ids, '{}')
  )
  on conflict (topic, shop, shopify_request_id, customer_id) do update
    set order_ids = excluded.order_ids,
        customer_email = coalesce(excluded.customer_email, public.shopify_privacy_requests.customer_email),
        customer_phone = coalesce(excluded.customer_phone, public.shopify_privacy_requests.customer_phone)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.shopify_connections_for_shop(
  p_shop text
) returns table (tenant_id uuid, connected_account_id text)
language sql
security definer
set search_path = public, pg_temp
as $$
  select cm.tenant_id, cm.team_id
  from public.connector_metadata cm
  where cm.slug = 'composio.shopify'
    and cm.team_name = p_shop
    and cm.team_id is not null
  limit 50
$$;

revoke all on function public.shopify_connections_for_shop(text) from public, anon, authenticated;
grant execute on function public.shopify_connections_for_shop(text) to service_role;

revoke all on function public.list_shopify_pending_composio_accounts_for_shop(text) from public, anon, authenticated;
revoke all on function public.record_shopify_privacy_request(text, text, text, text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.list_shopify_pending_composio_accounts_for_shop(text) to service_role;
grant execute on function public.record_shopify_privacy_request(text, text, text, text, text, text, text, text[]) to service_role;

revoke all on function public.mint_shopify_oauth_state(text, text, integer) from public, anon, authenticated;
revoke all on function public.consume_shopify_oauth_state(text, text) from public, anon, authenticated;
revoke all on function public.store_shopify_pending_installation(text, text, text, timestamptz, timestamptz, text[]) from public, anon, authenticated;
revoke all on function public.get_shopify_pending_installation(uuid, bigint) from public, anon, authenticated;
revoke all on function public.get_shopify_installation_status(uuid, bigint) from public, anon, authenticated;
revoke all on function public.reserve_shopify_pending_installation(uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.rotate_shopify_pending_tokens(uuid, bigint, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.set_shopify_pending_composio_account(uuid, bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.complete_shopify_pending_installation(uuid, bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.delete_shopify_pending_installation_for_shop(text) from public, anon, authenticated;

grant execute on function public.mint_shopify_oauth_state(text, text, integer) to service_role;
grant execute on function public.consume_shopify_oauth_state(text, text) to service_role;
grant execute on function public.store_shopify_pending_installation(text, text, text, timestamptz, timestamptz, text[]) to service_role;
grant execute on function public.get_shopify_pending_installation(uuid, bigint) to service_role;
grant execute on function public.get_shopify_installation_status(uuid, bigint) to service_role;
grant execute on function public.reserve_shopify_pending_installation(uuid, bigint, uuid) to service_role;
grant execute on function public.rotate_shopify_pending_tokens(uuid, bigint, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.set_shopify_pending_composio_account(uuid, bigint, uuid, text, text) to service_role;
grant execute on function public.complete_shopify_pending_installation(uuid, bigint, uuid, text) to service_role;
grant execute on function public.delete_shopify_pending_installation_for_shop(text) to service_role;

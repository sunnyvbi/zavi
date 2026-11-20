
begin;

alter table public.shopify_pending_installations
  add column if not exists grant_pending boolean not null default false,
  add column if not exists composio_token_sync_pending boolean not null default false,
  add column if not exists refresh_lease_until timestamptz;

update public.shopify_pending_installations
set grant_pending = access_token_key is not null and refresh_token_key is not null;

create index if not exists shopify_installations_refresh_due_idx
  on public.shopify_pending_installations (access_token_expires_at)
  where claimed_at is not null
    and grant_pending = false
    and access_token_key is not null
    and refresh_token_key is not null;

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
      access_token_expires_at, refresh_token_expires_at, scopes,
      grant_pending, composio_token_sync_pending
    ) values (
      v_id, p_shop, v_access_key, v_refresh_key,
      p_access_token_expires_at, p_refresh_token_expires_at, coalesce(p_scopes, '{}'),
      true, false
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
        grant_pending = true,
        composio_token_sync_pending = false,
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
         i.grant_pending
  from public.shopify_pending_installations i
  where i.id = p_installation_id
    and i.generation = p_generation
$$;

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
      composio_token_sync_pending = composio_account_id is not null,
      refresh_lease_until = null,
      updated_at = now()
  where id = v_row.id;
  return true;
end $$;

create or replace function public.acquire_shopify_refresh_lease(
  p_installation_id uuid,
  p_generation bigint,
  p_ttl_seconds integer default 60
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.shopify_pending_installations
  set refresh_lease_until = now() + make_interval(secs => greatest(5, least(coalesce(p_ttl_seconds, 60), 300))),
      updated_at = now()
  where id = p_installation_id
    and generation = p_generation
    and access_token_key is not null
    and refresh_token_key is not null
    and (refresh_lease_until is null or refresh_lease_until < now());
  return found;
end $$;

create or replace function public.release_shopify_refresh_lease(
  p_installation_id uuid,
  p_generation bigint
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.shopify_pending_installations
  set refresh_lease_until = null,
      updated_at = now()
  where id = p_installation_id
    and generation = p_generation
    and refresh_lease_until is not null;
  return found;
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
      composio_token_sync_pending = false,
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
    and grant_pending = true
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

  if v_row.claimed_at is not null and v_row.grant_pending = false then
    return v_row.claimed_tenant_id = p_tenant_id
       and v_row.composio_account_id = p_composio_account_id;
  end if;

  if v_row.claimed_tenant_id is distinct from p_tenant_id
     or v_row.composio_account_id is distinct from p_composio_account_id
     or v_row.grant_pending = false
     or v_row.access_token_key is null
     or v_row.refresh_token_key is null then
    return false;
  end if;

  update public.shopify_pending_installations
  set grant_pending = false,
      composio_token_sync_pending = false,
      claimed_tenant_id = p_tenant_id,
      claimed_at = now(),
      composio_account_id = p_composio_account_id,
      superseded_composio_account_ids = '{}',
      updated_at = now()
  where id = v_row.id;
  return true;
end $$;

create or replace function public.list_shopify_token_refresh_candidates(
  p_due_before timestamptz,
  p_limit integer default 100
) returns table (
  installation_id uuid,
  installation_generation bigint,
  tenant_id uuid,
  connected_account_id text,
  auth_config_id text,
  token_sync_pending boolean,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select i.id, i.generation, i.claimed_tenant_id, i.composio_account_id,
         c.composio_auth_config_id, i.composio_token_sync_pending,
         i.access_token_expires_at, i.refresh_token_expires_at
  from public.shopify_pending_installations i
  join public.connector_metadata c
    on c.tenant_id = i.claimed_tenant_id
   and c.slug = 'composio.shopify'
   and c.team_id = i.composio_account_id
  where i.claimed_at is not null
    and i.grant_pending = false
    and i.access_token_key is not null
    and i.refresh_token_key is not null
    and i.composio_account_id is not null
    and i.claimed_tenant_id is not null
    and c.composio_auth_config_id is not null
    and (i.composio_token_sync_pending or i.access_token_expires_at <= p_due_before)
  order by i.composio_token_sync_pending desc, i.access_token_expires_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 200))
$$;

create or replace function public.mark_shopify_composio_token_synced(
  p_installation_id uuid,
  p_generation bigint,
  p_connected_account_id text,
  p_expected_access_token text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.shopify_pending_installations i
  set composio_token_sync_pending = false,
      updated_at = now()
  where i.id = p_installation_id
    and i.generation = p_generation
    and i.composio_account_id = p_connected_account_id
    and i.access_token_key is not null
    and public.get_platform_secret(i.access_token_key) = p_expected_access_token;
  return found;
end $$;

create or replace function public.delete_shopify_installation_for_tenant(
  p_shop text,
  p_tenant_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_pending_installations%rowtype;
begin
  delete from public.shopify_pending_installations
  where shop = p_shop
    and claimed_tenant_id = p_tenant_id
  returning * into v_row;
  if v_row.id is null then return false; end if;
  if v_row.access_token_key is not null then perform public.delete_platform_secret(v_row.access_token_key); end if;
  if v_row.refresh_token_key is not null then perform public.delete_platform_secret(v_row.refresh_token_key); end if;
  return true;
end $$;

create or replace function public.cleanup_shopify_install_on_unclaim()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.claimed_tenant_id is not null and new.claimed_tenant_id is null then
    if old.access_token_key is not null then perform public.delete_platform_secret(old.access_token_key); end if;
    if old.refresh_token_key is not null then perform public.delete_platform_secret(old.refresh_token_key); end if;
    new.access_token_key := null;
    new.refresh_token_key := null;
    new.access_token_expires_at := null;
    new.refresh_token_expires_at := null;
    new.grant_pending := false;
    new.composio_token_sync_pending := false;
    new.claimed_at := null;
    new.composio_account_id := null;
    new.superseded_composio_account_ids := '{}';
  end if;
  return new;
end $$;

drop trigger if exists cleanup_shopify_install_on_unclaim on public.shopify_pending_installations;
create trigger cleanup_shopify_install_on_unclaim
before update of claimed_tenant_id on public.shopify_pending_installations
for each row execute function public.cleanup_shopify_install_on_unclaim();

revoke all on function public.list_shopify_token_refresh_candidates(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.mark_shopify_composio_token_synced(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.delete_shopify_installation_for_tenant(text, uuid) from public, anon, authenticated;
revoke all on function public.acquire_shopify_refresh_lease(uuid, bigint, integer) from public, anon, authenticated;
revoke all on function public.release_shopify_refresh_lease(uuid, bigint) from public, anon, authenticated;
revoke all on function public.cleanup_shopify_install_on_unclaim() from public, anon, authenticated;
revoke all on function public.store_shopify_pending_installation(text, text, text, timestamptz, timestamptz, text[]) from public, anon, authenticated;
revoke all on function public.get_shopify_installation_status(uuid, bigint) from public, anon, authenticated;
revoke all on function public.rotate_shopify_pending_tokens(uuid, bigint, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.set_shopify_pending_composio_account(uuid, bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.complete_shopify_pending_installation(uuid, bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.store_shopify_pending_installation(text, text, text, timestamptz, timestamptz, text[]) to service_role;
grant execute on function public.get_shopify_installation_status(uuid, bigint) to service_role;
grant execute on function public.rotate_shopify_pending_tokens(uuid, bigint, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.set_shopify_pending_composio_account(uuid, bigint, uuid, text, text) to service_role;
grant execute on function public.complete_shopify_pending_installation(uuid, bigint, uuid, text) to service_role;
grant execute on function public.list_shopify_token_refresh_candidates(timestamptz, integer) to service_role;
grant execute on function public.mark_shopify_composio_token_synced(uuid, bigint, text, text) to service_role;
grant execute on function public.delete_shopify_installation_for_tenant(text, uuid) to service_role;
grant execute on function public.acquire_shopify_refresh_lease(uuid, bigint, integer) to service_role;
grant execute on function public.release_shopify_refresh_lease(uuid, bigint) to service_role;

commit;

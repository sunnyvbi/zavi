
create table if not exists public.shopify_app_user_links (
  shop text not null,
  shopify_user_id text not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop, shopify_user_id)
);

alter table public.shopify_app_user_links enable row level security;
revoke all on public.shopify_app_user_links from public, anon, authenticated;

create or replace function public.shopify_app_member_link_available(
  p_tenant_id uuid,
  p_shop text,
  p_shopify_user_id text
) returns boolean
language sql stable security definer
set search_path = public, pg_temp as $$
  select case
    when lower(btrim(coalesce(p_shop, ''))) !~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'
      or coalesce(btrim(p_shopify_user_id), '') !~ '^[0-9]{1,64}$' then false
    when not exists (
      select 1 from public.shopify_app_user_links l
       where l.shop = lower(btrim(p_shop))
         and l.shopify_user_id = btrim(p_shopify_user_id)
    ) then true
    when exists (
      select 1 from public.shopify_app_user_links l
       where l.shop = lower(btrim(p_shop))
         and l.shopify_user_id = btrim(p_shopify_user_id)
         and l.tenant_id = p_tenant_id
    ) then true
    else not exists (
      select 1
        from public.shopify_app_user_links l
        join public.connector_metadata cm
          on cm.tenant_id = l.tenant_id
         and cm.slug = 'composio.shopify'
         and lower(cm.team_name) = l.shop
       where l.shop = lower(btrim(p_shop))
         and l.shopify_user_id = btrim(p_shopify_user_id)
    )
  end
$$;

create or replace function public.link_shopify_app_member(
  p_tenant_id uuid,
  p_shop text,
  p_shopify_user_id text,
  p_user_id uuid
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_shop text := lower(btrim(coalesce(p_shop, '')));
  v_linked uuid;
begin
  if v_shop !~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'
     or coalesce(btrim(p_shopify_user_id), '') !~ '^[0-9]{1,64}$'
     or p_user_id is null then
    return null;
  end if;

  if not exists (
    select 1 from public.tenant_users
     where tenant_id = p_tenant_id
       and user_id = p_user_id
       and role in ('owner', 'admin')
  ) or not exists (
    select 1
      from public.connector_metadata
     where tenant_id = p_tenant_id
       and slug = 'composio.shopify'
       and lower(team_name) = v_shop
    union all
    select 1
      from public.shopify_pending_installations
     where shop = v_shop
       and claimed_tenant_id = p_tenant_id
       and access_token_key is not null
  ) then
    return null;
  end if;

  insert into public.shopify_app_user_links
    (shop, shopify_user_id, tenant_id, user_id)
  values
    (v_shop, btrim(p_shopify_user_id), p_tenant_id, p_user_id)
  on conflict (shop, shopify_user_id) do update
    set tenant_id = excluded.tenant_id,
        user_id = excluded.user_id,
        updated_at = now()
    where shopify_app_user_links.tenant_id = excluded.tenant_id
       or not exists (
         select 1 from public.connector_metadata cm
          where cm.tenant_id = shopify_app_user_links.tenant_id
            and cm.slug = 'composio.shopify'
            and lower(cm.team_name) = shopify_app_user_links.shop
       )
  returning user_id into v_linked;

  return v_linked;
end $$;

create or replace function public.resolve_shopify_app_member_link(
  p_tenant_id uuid,
  p_shop text,
  p_shopify_user_id text
) returns table(user_id uuid, role text)
language sql stable security definer
set search_path = public, pg_temp as $$
  select l.user_id, tu.role
    from public.shopify_app_user_links l
    join public.tenant_users tu
      on tu.tenant_id = l.tenant_id
     and tu.user_id = l.user_id
   where l.tenant_id = p_tenant_id
     and l.shop = lower(btrim(p_shop))
     and l.shopify_user_id = btrim(p_shopify_user_id)
   limit 1
$$;

create or replace function public.delete_shopify_app_member_links(
  p_tenant_id uuid,
  p_shop text
) returns bigint
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_count bigint;
begin
  delete from public.shopify_app_user_links
   where tenant_id = p_tenant_id
     and shop = lower(btrim(p_shop));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.delete_shopify_app_member_links_for_shop(
  p_shop text
) returns bigint
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_count bigint;
begin
  delete from public.shopify_app_user_links
   where shop = lower(btrim(p_shop));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.link_shopify_app_member(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.shopify_app_member_link_available(uuid, text, text) from public, anon, authenticated;
revoke all on function public.resolve_shopify_app_member_link(uuid, text, text) from public, anon, authenticated;
revoke all on function public.delete_shopify_app_member_links(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_shopify_app_member_links_for_shop(text) from public, anon, authenticated;
grant execute on function public.link_shopify_app_member(uuid, text, text, uuid) to service_role;
grant execute on function public.shopify_app_member_link_available(uuid, text, text) to service_role;
grant execute on function public.resolve_shopify_app_member_link(uuid, text, text) to service_role;
grant execute on function public.delete_shopify_app_member_links(uuid, text) to service_role;
grant execute on function public.delete_shopify_app_member_links_for_shop(text) to service_role;

comment on table public.shopify_app_user_links is
  'Links a Shopify App Bridge staff identity to the Zavi owner/admin who claimed that shop.';

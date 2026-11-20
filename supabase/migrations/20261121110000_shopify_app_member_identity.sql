
create or replace function public.resolve_shopify_app_member(
  p_tenant_id uuid,
  p_email text
) returns table(user_id uuid, role text)
language plpgsql stable security definer
set search_path = public, auth, pg_temp as $$
declare
  v_count integer;
begin
  if p_tenant_id is null or coalesce(btrim(p_email), '') = '' then
    return;
  end if;

  select count(distinct u.id)
    into v_count
    from auth.users u
    join public.tenant_users tu
      on tu.user_id = u.id
     and tu.tenant_id = p_tenant_id
   where lower(u.email) = lower(btrim(p_email));

  if v_count <> 1 then
    return;
  end if;

  return query
  select tu.user_id, tu.role
    from auth.users u
    join public.tenant_users tu
      on tu.user_id = u.id
     and tu.tenant_id = p_tenant_id
   where lower(u.email) = lower(btrim(p_email))
   limit 1;
end $$;

revoke all on function public.resolve_shopify_app_member(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_shopify_app_member(uuid, text)
  to service_role;

comment on function public.resolve_shopify_app_member(uuid, text) is
  'Resolves one Shopify-verified staff email to exactly one existing Zavi tenant membership. The app must verify the Shopify ID token and email_verified before calling.';

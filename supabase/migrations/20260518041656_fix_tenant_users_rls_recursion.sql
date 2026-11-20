
create or replace function public.user_in_tenant(p_tenant uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.tenant_users
     where user_id = auth.uid()
       and tenant_id = p_tenant
  );
$$;

revoke all on function public.user_in_tenant(uuid) from public;
grant execute on function public.user_in_tenant(uuid) to authenticated, service_role;

comment on function public.user_in_tenant(uuid) is
  'Returns true iff the calling auth.uid() is a member of p_tenant. SECURITY DEFINER to avoid RLS self-recursion when used in tenant_users policies.';

drop policy if exists tenant_users_select_members on tenant_users;
create policy tenant_users_select_members on tenant_users for select using (
  public.user_in_tenant(tenant_id)
);

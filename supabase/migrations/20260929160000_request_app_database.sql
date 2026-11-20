
create or replace function public.request_app_database(p_tenant_id uuid)
returns text
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_status text;
begin
  if p_tenant_id is null then
    raise exception 'request_app_database: tenant_id is required' using errcode = '22023';
  end if;
  insert into tenant_resources (tenant_id, resource_kind, mode, status, external_ref)
  values (p_tenant_id, 'db', 'provisioned', 'pending', '{}'::jsonb)
  on conflict (tenant_id, resource_kind) do nothing;
  select status into v_status
    from tenant_resources
   where tenant_id = p_tenant_id and resource_kind = 'db';
  return v_status;
end $$;

revoke execute on function public.request_app_database(uuid) from public, anon, authenticated;
grant execute on function public.request_app_database(uuid) to service_role;

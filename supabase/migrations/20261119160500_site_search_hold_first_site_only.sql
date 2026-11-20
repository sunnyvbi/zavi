begin;

alter table public.sites alter column search_released_at set default now();

create or replace function public.site_hold_search(
  p_tenant_id uuid,
  p_site_id   uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_hold_search: tenant_id and site_id are required' using errcode = '22023';
  end if;
  update public.sites s
     set search_released_at = null
   where s.id = p_site_id
     and s.tenant_id = p_tenant_id
     and s.live_deploy_id is null;
end $$;

revoke all on function public.site_hold_search(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_hold_search(uuid, uuid) to service_role;

commit;

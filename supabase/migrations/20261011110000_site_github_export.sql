
alter table public.sites add column if not exists github_export jsonb;

create or replace function public.site_set_github_export(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_record    jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_set_github_export: tenant_id and site_id are required' using errcode = '22023';
  end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'site_set_github_export: record must be an object' using errcode = '22023';
  end if;
  update public.sites s set github_export = p_record
   where s.id = p_site_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception 'site_set_github_export: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
end $$;

revoke all on function public.site_set_github_export(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.site_set_github_export(uuid, uuid, jsonb) to service_role;

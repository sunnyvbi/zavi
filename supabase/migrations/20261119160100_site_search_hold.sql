begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sites' and column_name = 'search_released_at'
  ) then
    alter table public.sites add column search_released_at timestamptz;
    update public.sites set search_released_at = now();
  end if;
end $$;

create or replace function public.sites_release_search_on_edit() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if new.search_released_at is null
     and old.live_deploy_id is not null
     and new.live_deploy_id is not null
     and new.live_deploy_id is distinct from old.live_deploy_id
     and coalesce(new.publish_run_id = new.root_conductor_run_id, false) = false then
    new.search_released_at := now();
  end if;
  return new;
end $$;
revoke all on function public.sites_release_search_on_edit() from public, anon, authenticated;

drop trigger if exists sites_release_search_on_edit on public.sites;
create trigger sites_release_search_on_edit
  before update of live_deploy_id on public.sites
  for each row execute function public.sites_release_search_on_edit();

create or replace function public.site_release_search(
  p_tenant_id uuid,
  p_site_id   uuid
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_release_search: tenant_id and site_id are required' using errcode = '22023';
  end if;
  update public.sites s
     set search_released_at = now(),
         host_version = s.host_version + 1
   where s.id = p_site_id
     and s.tenant_id = p_tenant_id
     and s.search_released_at is null
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id;
  end if;
  if v_row.id is null then
    raise exception 'site_release_search: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  return v_row;
end $$;

revoke all on function public.site_release_search(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_release_search(uuid, uuid) to service_role;

commit;

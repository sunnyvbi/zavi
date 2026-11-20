
begin;

alter table public.sites
  add column if not exists kv_host_version bigint not null default 0;

update public.sites
   set kv_host_version = -1
 where live_deploy_id is not null or gateway_binding is not null or kv_deploy_id is not null;

drop index if exists public.sites_kv_drift_idx;
create index if not exists sites_host_drift_idx on public.sites (updated_at)
  where kv_host_version <> host_version;

drop trigger if exists sites_terminal_dirties_projection on public.sites;

create or replace function public.sites_bump_host_version() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.live_deploy_id is not null or new.gateway_binding is not null then
      new.kv_host_version := -1;
    end if;
    return new;
  end if;
  if new.host_version < old.host_version then
    raise exception 'sites.host_version can never go down (% -> %)', old.host_version, new.host_version using errcode = '22023';
  end if;
  if new.host_version = old.host_version and (
       new.live_deploy_id  is distinct from old.live_deploy_id
    or new.live_sha        is distinct from old.live_sha
    or new.hostname        is distinct from old.hostname
    or new.tenant_id       is distinct from old.tenant_id
    or new.gateway_binding is distinct from old.gateway_binding
    or new.gateway_config  is distinct from old.gateway_config
    or (new.status in ('deleting', 'deleted', 'fell_back_old'))
         is distinct from (old.status in ('deleting', 'deleted', 'fell_back_old'))
  ) then
    new.host_version := old.host_version + 1;
  end if;
  return new;
end $$;
revoke all on function public.sites_bump_host_version() from public, anon, authenticated;

drop trigger if exists sites_bump_host_version on public.sites;
create trigger sites_bump_host_version
  before insert or update on public.sites
  for each row execute function public.sites_bump_host_version();

create or replace function public.sites_legacy_ledger_dirties() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  new.kv_host_version := -1;
  return new;
end $$;
revoke all on function public.sites_legacy_ledger_dirties() from public, anon, authenticated;

drop trigger if exists sites_legacy_ledger_dirties on public.sites;
create trigger sites_legacy_ledger_dirties
  before update of kv_deploy_id on public.sites
  for each row execute function public.sites_legacy_ledger_dirties();

create or replace function public.site_mark_host_projected(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_version   bigint,
  p_drift     boolean
) returns int
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_count int;
begin
  if p_tenant_id is null or p_site_id is null or p_version is null then
    raise exception 'site_mark_host_projected: tenant_id, site_id and version are required' using errcode = '22023';
  end if;
  update public.sites s set
    kv_host_version = p_version,
    kv_projected_at = now(),
    kv_drift_count  = case when coalesce(p_drift, false) then s.kv_drift_count + 1 else 0 end
  where s.id = p_site_id and s.tenant_id = p_tenant_id
    and s.host_version = p_version
  returning s.kv_drift_count into v_count;
  if not found then
    return -1;
  end if;
  return v_count;
end $$;
revoke all on function public.site_mark_host_projected(uuid, uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.site_mark_host_projected(uuid, uuid, bigint, boolean) to service_role;

create or replace function public.site_projection_drift_batch(
  p_settle_before timestamptz,
  p_limit         int
) returns table (tenant_id uuid, site_id uuid)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_settle_before is null then
    raise exception 'site_projection_drift_batch: settle_before is required' using errcode = '22023';
  end if;
  return query
    select s.tenant_id, s.id
      from public.sites s
     where s.kv_host_version <> s.host_version
       and s.updated_at < p_settle_before
     order by s.updated_at
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;
revoke all on function public.site_projection_drift_batch(timestamptz, int) from public, anon, authenticated;
grant execute on function public.site_projection_drift_batch(timestamptz, int) to service_role;

commit;


begin;

alter table public.sites
  add column if not exists kv_deploy_id    text,
  add column if not exists kv_projected_at timestamptz,
  add column if not exists kv_drift_count  int not null default 0;

create index if not exists sites_kv_drift_idx on public.sites (updated_at)
  where kv_deploy_id is distinct from
        (case when status in ('deleting', 'deleted', 'fell_back_old') then null else live_deploy_id end);

create or replace function public.site_activate_if_desired(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_sha       text,
  p_deploy_id text,
  p_live_url  text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_sha is null or p_deploy_id is null then
    raise exception 'site_activate_if_desired: tenant_id, site_id, sha and deploy_id are required' using errcode = '22023';
  end if;
  update public.sites s set
    live_sha       = p_sha,
    live_deploy_id = p_deploy_id,
    live_url       = p_live_url,
    updated_at     = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id and s.desired_sha = p_sha
    and s.status not in ('deleting', 'deleted', 'fell_back_old')
    and (s.live_deploy_id is null
         or s.live_deploy_id !~ '^d[0-9a-z]{9}-[0-9a-f]{8}$'
         or p_deploy_id !~ '^d[0-9a-z]{9}-[0-9a-f]{8}$'
         or (substr(s.live_deploy_id, 2, 9) collate "C") <= (substr(p_deploy_id, 2, 9) collate "C"));
  return found;
end $$;
revoke all on function public.site_activate_if_desired(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.site_activate_if_desired(uuid, uuid, text, text, text) to service_role;

create or replace function public.site_mark_projected(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_deploy_id text,
  p_drift     boolean
) returns int
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_count int;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_mark_projected: tenant_id and site_id are required' using errcode = '22023';
  end if;
  update public.sites s set
    kv_deploy_id    = p_deploy_id,
    kv_projected_at = now(),
    kv_drift_count  = case when coalesce(p_drift, false) then s.kv_drift_count + 1 else 0 end
  where s.id = p_site_id and s.tenant_id = p_tenant_id
    and (case when s.status in ('deleting', 'deleted', 'fell_back_old') then null else s.live_deploy_id end)
        is not distinct from p_deploy_id
  returning s.kv_drift_count into v_count;
  if not found then
    return -1;
  end if;
  return v_count;
end $$;
revoke all on function public.site_mark_projected(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.site_mark_projected(uuid, uuid, text, boolean) to service_role;

create or replace function public.site_note_projection_drift(
  p_tenant_id uuid,
  p_site_id   uuid
) returns int
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_count int;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_note_projection_drift: tenant_id and site_id are required' using errcode = '22023';
  end if;
  update public.sites s set kv_drift_count = s.kv_drift_count + 1
   where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning s.kv_drift_count into v_count;
  return coalesce(v_count, 0);
end $$;
revoke all on function public.site_note_projection_drift(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_note_projection_drift(uuid, uuid) to service_role;

create or replace function public.sites_terminal_dirties_projection() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if new.status in ('deleting', 'deleted', 'fell_back_old')
     and old.status not in ('deleting', 'deleted', 'fell_back_old') then
    new.kv_deploy_id := 'pending-removal';
  end if;
  return new;
end $$;
revoke all on function public.sites_terminal_dirties_projection() from public, anon, authenticated;

drop trigger if exists sites_terminal_dirties_projection on public.sites;
create trigger sites_terminal_dirties_projection
  before update of status on public.sites
  for each row execute function public.sites_terminal_dirties_projection();

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
     where s.kv_deploy_id is distinct from
           (case when s.status in ('deleting', 'deleted', 'fell_back_old') then null else s.live_deploy_id end)
       and s.updated_at < p_settle_before
     order by s.updated_at
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;
revoke all on function public.site_projection_drift_batch(timestamptz, int) from public, anon, authenticated;
grant execute on function public.site_projection_drift_batch(timestamptz, int) to service_role;

commit;

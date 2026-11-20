begin;

drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text);
drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text, bigint);
drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text, uuid);

create or replace function public.site_activate_if_desired(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_sha        text,
  p_deploy_id  text,
  p_live_url   text,
  p_generation bigint default null,
  p_conductor_run_id uuid default null
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
         or (substr(s.live_deploy_id, 2, 9) collate "C") <= (substr(p_deploy_id, 2, 9) collate "C"))
    and ((p_generation is null and s.publish_generation = 0) or s.publish_generation = p_generation)
    and (p_conductor_run_id is null or exists (select 1 from public.conductor_runs r where r.id = p_conductor_run_id and r.tenant_id = p_tenant_id and r.status in ('provisioning', 'active', 'paused')));
  return found;
end $$;

revoke all on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint, uuid) to service_role;

create or replace function public.site_claim_stranded(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_cutoff     timestamptz,
  p_last_error text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_cutoff is null then
    raise exception 'site_claim_stranded: tenant_id, site_id and cutoff are required' using errcode = '22023';
  end if;
  update public.sites s
     set status = 'deleting', last_error = left(coalesce(p_last_error, ''), 500), updated_at = now()
   where s.id = p_site_id
     and s.tenant_id = p_tenant_id
     and s.status in ('provisioning', 'building')
     and s.updated_at < p_cutoff
     and s.live_deploy_id is null
     and not exists (select 1 from public.conductor_runs r
                      where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
                        and (r.status in ('provisioning', 'active', 'paused')
                             or (r.status = 'done' and s.status = 'building')));
  return found;
end $$;

revoke all on function public.site_claim_stranded(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.site_claim_stranded(uuid, uuid, timestamptz, text) to service_role;

create or replace function public.site_settle_stopped(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_to         text,
  p_last_error text
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
begin
  if p_tenant_id is null or p_site_id is null or p_to is null then
    raise exception 'site_settle_stopped: tenant_id, site_id and to are required' using errcode = '22023';
  end if;
  if p_to not in ('building', 'failed') then
    raise exception 'site_settle_stopped: to must be building or failed' using errcode = '22023';
  end if;
  update public.sites s set
    status     = case when s.live_deploy_id is not null then 'live' else p_to end,
    last_error = left(coalesce(p_last_error, ''), 500),
    updated_at = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id and s.status in ('building', 'publishing')
  returning * into v_row;
  if not found then
    return null;
  end if;
  return v_row;
end $$;

revoke all on function public.site_settle_stopped(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_settle_stopped(uuid, uuid, text, text) to service_role;

commit;

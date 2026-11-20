
begin;

create or replace function continue_paused_build_with_site(
  p_tenant_id           uuid,
  p_run_id              uuid,
  p_expected_updated_at timestamptz,
  p_goal_graph          jsonb,
  p_site_id             uuid
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status  text;
  v_outcome text;
begin
  if p_site_id is null then
    return continue_paused_build(p_tenant_id, p_run_id, p_expected_updated_at, p_goal_graph);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));
  select s.status into v_status
    from public.sites s
   where s.id = p_site_id
     and s.tenant_id = p_tenant_id
     and s.root_conductor_run_id = p_run_id
   for update;
  if v_status is null or v_status in ('fell_back_old', 'deleting', 'deleted') then
    return 'site_gone';
  end if;
  if exists (
    select 1 from public.site_providers sp
     where sp.site_id = p_site_id
       and sp.tenant_id = p_tenant_id
       and sp.state not in ('claimed', 'created')
  ) then
    return 'site_gone';
  end if;
  v_outcome := continue_paused_build(p_tenant_id, p_run_id, p_expected_updated_at, p_goal_graph);
  if v_outcome = 'resumed' and v_status = 'failed' then
    update public.sites
       set status = 'building', last_error = null, updated_at = now()
     where id = p_site_id and tenant_id = p_tenant_id and status = 'failed';
  end if;
  return v_outcome;
end $$;
revoke all on function continue_paused_build_with_site(uuid, uuid, timestamptz, jsonb, uuid) from public, anon, authenticated;
grant execute on function continue_paused_build_with_site(uuid, uuid, timestamptz, jsonb, uuid) to service_role;

create or replace function public.sites_fail_only_after_run() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.status = 'failed'
     and old.status in ('provisioning', 'building', 'publishing')
     and new.root_conductor_run_id is not null
     and exists (
       select 1 from public.conductor_runs r
        where r.id = new.root_conductor_run_id
          and r.tenant_id = new.tenant_id
          and r.status in ('provisioning', 'active')
     ) then
    raise exception 'site % cannot be failed while its build run is still running', new.id using errcode = '55000';
  end if;
  return new;
end $$;
revoke all on function public.sites_fail_only_after_run() from public, anon, authenticated;
drop trigger if exists sites_fail_only_after_run on public.sites;
create trigger sites_fail_only_after_run
  before update of status on public.sites
  for each row execute function public.sites_fail_only_after_run();

commit;

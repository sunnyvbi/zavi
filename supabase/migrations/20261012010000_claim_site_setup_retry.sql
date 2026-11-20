
begin;

create or replace function public.claim_site_setup_retry(
  p_tenant_id           uuid,
  p_run_id              uuid,
  p_expected_updated_at timestamptz,
  p_site_id             uuid
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run     record;
  v_site_id uuid;
  v_status  text;
begin
  if p_tenant_id is null or p_run_id is null or p_expected_updated_at is null then
    raise exception 'claim_site_setup_retry: tenant_id, run_id and expected_updated_at are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));

  select r.id, r.status, r.failure_class, r.paused_at, r.updated_at, r.goal_graph
    into v_run
    from conductor_runs r
   where r.id = p_run_id
     and r.tenant_id = p_tenant_id
     and r.kind = 'build_app'
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_run.status <> 'failed'
     or v_run.paused_at is not null
     or coalesce(v_run.failure_class, '') <> 'provision_failed'
     or not exists (
       select 1
         from jsonb_array_elements(case when jsonb_typeof(v_run.goal_graph) = 'array' then v_run.goal_graph else '[]'::jsonb end) as e(node)
        where jsonb_typeof(e.node) = 'object'
          and jsonb_typeof(e.node->'payload') = 'object'
          and jsonb_typeof(e.node->'payload'->'site_setup') = 'object'
          and e.node->'payload'->'site_setup'->'retryable' = 'true'::jsonb
     ) then
    return 'not_resumable';
  end if;
  if v_run.updated_at is distinct from p_expected_updated_at then
    return 'changed_concurrently';
  end if;
  if exists (
    select 1 from conductor_runs o
     where o.tenant_id = p_tenant_id
       and o.kind = 'build_app'
       and o.id <> p_run_id
       and o.status in ('provisioning', 'active')
  ) then
    return 'another_build_running';
  end if;

  select s.id, s.status into v_site_id, v_status
    from public.sites s
   where s.tenant_id = p_tenant_id
     and s.root_conductor_run_id = p_run_id
     and (p_site_id is null or s.id = p_site_id)
   for update;
  if p_site_id is not null and v_site_id is null then
    return 'site_gone';
  end if;
  if v_site_id is not null then
    if v_status not in ('provisioning', 'building') then
      return 'site_gone';
    end if;
    if exists (
      select 1 from public.site_providers sp
       where sp.site_id = v_site_id
         and sp.tenant_id = p_tenant_id
         and sp.state not in ('claimed', 'created')
    ) then
      return 'site_gone';
    end if;
    update public.sites set updated_at = now()
     where id = v_site_id and tenant_id = p_tenant_id;
  end if;

  update conductor_runs
     set status = 'provisioning', failure_class = null, failure_reason = null, updated_at = now()
   where id = p_run_id
     and tenant_id = p_tenant_id;
  return 'resumed';
end $$;

revoke all on function public.claim_site_setup_retry(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.claim_site_setup_retry(uuid, uuid, timestamptz, uuid) to service_role;

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
     and not exists (select 1 from public.conductor_runs r
                      where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
                        and r.status in ('provisioning', 'active', 'paused'));
  return found;
end $$;

revoke all on function public.site_claim_stranded(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.site_claim_stranded(uuid, uuid, timestamptz, text) to service_role;

create or replace function public.site_reaper_candidates(
  p_cutoff timestamptz,
  p_limit  int
) returns table (tenant_id uuid, site_id uuid, status text, tenant_slug text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_cutoff is null then
    raise exception 'site_reaper_candidates: cutoff is required' using errcode = '22023';
  end if;
  return query
    select s.tenant_id, s.id, s.status, t.slug
      from public.sites s
      join public.tenants t on t.id = s.tenant_id
     where (
         exists (select 1 from public.site_providers p
                  where p.site_id = s.id and p.tenant_id = s.tenant_id and p.state <> 'deleted'
                    and not (p.state = 'delete_scheduled'
                             and (p.scheduled_delete_at is null or p.scheduled_delete_at > now()))
                    and not (p.ref @> '{"retained": true}'::jsonb))
         and (
           (s.status in ('fell_back_old', 'failed', 'deleting', 'deleted')
            and (
              s.updated_at < p_cutoff
              or exists (select 1 from public.site_providers p
                          where p.site_id = s.id and p.tenant_id = s.tenant_id
                            and (p.state in ('cleanup_pending', 'delete_issuing')
                                 or (p.state = 'delete_scheduled' and p.scheduled_delete_at <= now())))
            ))
           or
           (s.status in ('provisioning', 'building')
            and s.updated_at < p_cutoff
            and not exists (select 1 from public.conductor_runs r
                             where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
                               and r.status in ('provisioning', 'active', 'paused')))
         )
       )
       or (
         s.status in ('provisioning', 'building')
         and s.updated_at < p_cutoff
         and not exists (select 1 from public.site_providers p
                          where p.site_id = s.id and p.tenant_id = s.tenant_id)
         and not exists (select 1 from public.conductor_runs r
                          where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
                            and r.status in ('provisioning', 'active', 'paused'))
       )
       or (
         s.status = 'deleting'
         and s.updated_at < p_cutoff
         and not exists (select 1 from public.site_providers p
                          where p.site_id = s.id and p.tenant_id = s.tenant_id)
       )
     order by s.updated_at
     limit least(greatest(coalesce(p_limit, 25), 1), 200);
end $$;

revoke all on function public.site_reaper_candidates(timestamptz, int) from public, anon, authenticated;
grant execute on function public.site_reaper_candidates(timestamptz, int) to service_role;

commit;

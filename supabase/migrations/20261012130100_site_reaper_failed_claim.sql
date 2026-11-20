
begin;

create or replace function public.site_claim_failed(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_cutoff     timestamptz,
  p_last_error text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_cutoff is null then
    raise exception 'site_claim_failed: tenant_id, site_id and cutoff are required' using errcode = '22023';
  end if;
  update public.sites s
     set status = 'deleting', last_error = left(coalesce(p_last_error, ''), 500), updated_at = now()
   where s.id = p_site_id
     and s.tenant_id = p_tenant_id
     and s.status = 'failed'
     and s.updated_at < p_cutoff
     and s.live_sha is null
     and s.live_deploy_id is null
     and not exists (select 1 from public.conductor_runs r
                      where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
                        and r.status in ('provisioning', 'active', 'paused'));
  return found;
end $$;

revoke all on function public.site_claim_failed(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.site_claim_failed(uuid, uuid, timestamptz, text) to service_role;

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
     where ((
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
       ))
       and not (
         s.status in ('failed', 'provisioning', 'building')
         and (
           s.live_sha is not null
           or s.live_deploy_id is not null
           or exists (select 1 from public.conductor_runs r
                       where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
                         and r.status in ('provisioning', 'active', 'paused'))
         )
       )
     order by s.updated_at
     limit least(greatest(coalesce(p_limit, 25), 1), 200);
end $$;

revoke all on function public.site_reaper_candidates(timestamptz, int) from public, anon, authenticated;
grant execute on function public.site_reaper_candidates(timestamptz, int) to service_role;

commit;

begin;

create or replace function public.site_queued_change_prune(p_tenant_id uuid) returns void
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  delete from public.site_queued_change q
   where q.tenant_id = p_tenant_id
     and (
       q.queued_at < now() - interval '24 hours'
       or (q.status = 'running' and q.claimed_at < now() - interval '15 minutes')
     );
$$;

create or replace function public.site_claim_queued_change(
  p_tenant_id uuid
) returns table (site_id uuid, conductor_run_id uuid, message text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'site_claim_queued_change: tenant_id is required' using errcode = '22023';
  end if;
  perform public.site_queued_change_prune(p_tenant_id);
  return query
  update public.site_queued_change q
     set status = 'running',
         claimed_at = now()
   where q.site_id = (
           select n.site_id
             from public.site_queued_change n
            where n.tenant_id = p_tenant_id
              and n.status = 'queued'
              and not exists (
                select 1 from public.conductor_runs r
                 where r.id = n.held_by_run_id and r.status in ('provisioning', 'active'))
              and not exists (
                select 1 from public.conductor_runs r
                 where r.id = coalesce(n.held_by_run_id, n.conductor_run_id) and r.status in ('failed', 'halted'))
            order by n.queued_at
            limit 1
            for update skip locked
         )
     and q.status = 'queued'
  returning q.site_id, q.conductor_run_id, q.message;
end $$;

create or replace function public.site_drop_stopped_queued_changes(
  p_tenant_id uuid
) returns setof uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'site_drop_stopped_queued_changes: tenant_id is required' using errcode = '22023';
  end if;
  return query
  delete from public.site_queued_change q
   where q.tenant_id = p_tenant_id
     and q.status = 'queued'
     and exists (
       select 1 from public.conductor_runs r
        where r.id = coalesce(q.held_by_run_id, q.conductor_run_id) and r.status in ('failed', 'halted'))
  returning q.conductor_run_id;
end $$;

revoke all on function public.site_queued_change_prune(uuid) from public, anon, authenticated;
grant execute on function public.site_queued_change_prune(uuid) to service_role;
revoke all on function public.site_claim_queued_change(uuid) from public, anon, authenticated;
grant execute on function public.site_claim_queued_change(uuid) to service_role;
revoke all on function public.site_drop_stopped_queued_changes(uuid) from public, anon, authenticated;
grant execute on function public.site_drop_stopped_queued_changes(uuid) to service_role;

commit;

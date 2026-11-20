begin;

alter table public.site_queued_change add column if not exists held_by_run_id uuid;

create or replace function public.site_queued_change_prune(p_tenant_id uuid) returns void
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  delete from public.site_queued_change q
   where q.tenant_id = p_tenant_id
     and (
       q.queued_at < now() - interval '24 hours'
       or (q.status = 'running' and q.claimed_at < now() - interval '15 minutes')
       or (q.status = 'queued' and exists (
             select 1 from public.conductor_runs r
              where r.id in (q.conductor_run_id, q.held_by_run_id) and r.status in ('failed', 'halted')))
     );
$$;

create or replace function public.site_queue_change(
  p_tenant_id        uuid,
  p_site_id          uuid,
  p_conductor_run_id uuid,
  p_message          text,
  p_user_id          uuid default null
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_status  text;
  v_held_by uuid;
begin
  if p_tenant_id is null or p_site_id is null or p_conductor_run_id is null then
    raise exception 'site_queue_change: tenant_id, site_id and conductor_run_id are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then
    raise exception 'site_queue_change: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  perform public.site_queued_change_prune(p_tenant_id);
  select q.status into v_status
    from public.site_queued_change q
   where q.site_id = p_site_id
   for update;
  if v_status = 'running' then
    return 'busy';
  end if;
  select r.id into v_held_by
    from public.conductor_runs r
   where r.tenant_id = p_tenant_id
     and r.status in ('provisioning', 'active')
     and r.kind is distinct from 'company_goal'
     and (
       public._build_graph_site_id(r.goal_graph) is null
       or public._build_graph_site_id(r.goal_graph) = lower(p_site_id::text)
     )
   order by public._build_graph_site_id(r.goal_graph) is null, r.created_at desc
   limit 1;
  insert into public.site_queued_change (site_id, tenant_id, conductor_run_id, held_by_run_id, message, queued_by, status, queued_at, claimed_at)
  values (p_site_id, p_tenant_id, p_conductor_run_id, v_held_by, btrim(p_message), p_user_id, 'queued', now(), null)
  on conflict (site_id) do update
    set conductor_run_id = excluded.conductor_run_id,
        held_by_run_id = excluded.held_by_run_id,
        message = excluded.message,
        queued_by = excluded.queued_by,
        queued_at = now()
  where public.site_queued_change.status = 'queued';
  return case when v_status is null then 'queued' else 'replaced' end;
end $$;

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
            order by n.queued_at
            limit 1
            for update skip locked
         )
     and q.status = 'queued'
  returning q.site_id, q.conductor_run_id, q.message;
end $$;

drop function if exists public.site_discard_queued_change(uuid, uuid);

create function public.site_discard_queued_change(
  p_tenant_id        uuid,
  p_conductor_run_id uuid
) returns setof uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_conductor_run_id is null then
    raise exception 'site_discard_queued_change: tenant_id and conductor_run_id are required' using errcode = '22023';
  end if;
  return query
  delete from public.site_queued_change q
   where q.tenant_id = p_tenant_id
     and q.status = 'queued'
     and (q.conductor_run_id = p_conductor_run_id or q.held_by_run_id = p_conductor_run_id)
  returning q.conductor_run_id;
end $$;

revoke all on function public.site_queued_change_prune(uuid) from public, anon, authenticated;
grant execute on function public.site_queued_change_prune(uuid) to service_role;
revoke all on function public.site_queue_change(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.site_queue_change(uuid, uuid, uuid, text, uuid) to service_role;
revoke all on function public.site_claim_queued_change(uuid) from public, anon, authenticated;
grant execute on function public.site_claim_queued_change(uuid) to service_role;
revoke all on function public.site_discard_queued_change(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_discard_queued_change(uuid, uuid) to service_role;

commit;

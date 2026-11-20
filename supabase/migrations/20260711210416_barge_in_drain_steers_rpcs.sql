
create or replace function drain_agent_run_steers(
  p_run_id        uuid,
  p_tenant_id     uuid,
  p_after_seq     bigint,
  p_max           int,
  p_lease_seconds int default 30
) returns setof agent_run_steers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.agent_runs r
    where r.id = p_run_id and r.tenant_id = p_tenant_id
  ) then
    return;
  end if;

  return query
  with candidates as (
    select s.id
    from public.agent_run_steers s
    where s.run_id = p_run_id
      and s.tenant_id = p_tenant_id
      and s.seq > p_after_seq
      and (
        s.status = 'pending'
        or (s.status = 'leased' and s.lease_until is not null and s.lease_until < now())
      )
    order by s.seq
    limit greatest(p_max, 0)
    for update skip locked
  )
  update public.agent_run_steers s
     set status = 'leased',
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
    from candidates c
   where s.id = c.id
  returning s.*;
end;
$$;

revoke all on function drain_agent_run_steers(uuid, uuid, bigint, int, int) from public, anon, authenticated;
grant execute on function drain_agent_run_steers(uuid, uuid, bigint, int, int) to service_role;

create or replace function mark_agent_run_steers_drained(
  p_ids       uuid[],
  p_run_id    uuid,
  p_tenant_id uuid
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  update public.agent_run_steers s
     set status = 'drained',
         drained_at = now()
   where s.id = any(p_ids)
     and s.run_id = p_run_id
     and s.tenant_id = p_tenant_id
     and s.status = 'leased';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function mark_agent_run_steers_drained(uuid[], uuid, uuid) from public, anon, authenticated;
grant execute on function mark_agent_run_steers_drained(uuid[], uuid, uuid) to service_role;

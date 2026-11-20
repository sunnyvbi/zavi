
begin;

alter table conductor_runs drop constraint if exists conductor_runs_status_check;
alter table conductor_runs
  add constraint conductor_runs_status_check
  check (status in ('provisioning','active','halted','done','failed','proposed','paused'));

alter table conductor_runs add column if not exists paused_at timestamptz;

create or replace function continue_paused_build(
  p_tenant_id           uuid,
  p_run_id              uuid,
  p_expected_updated_at timestamptz,
  p_goal_graph          jsonb
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));
  if exists (
    select 1 from conductor_runs n, conductor_runs me
     where me.id = p_run_id
       and n.tenant_id = p_tenant_id
       and n.kind = 'build_app'
       and n.id <> p_run_id
       and n.created_at > me.created_at
       and coalesce(n.goal_graph->0->'payload'->>'refine_mode', '') <> 'true'
       and coalesce(n.objective, '') not like '[refine]%'
  ) then
    return 'superseded';
  end if;
  if exists (
    select 1 from conductor_runs
     where tenant_id = p_tenant_id
       and kind = 'build_app'
       and id <> p_run_id
       and status in ('provisioning', 'active')
  ) then
    return 'another_build_running';
  end if;
  update conductor_runs
     set status = 'active', paused_at = null, failure_class = null,
         failure_reason = null, goal_graph = p_goal_graph, updated_at = now()
   where id = p_run_id
     and tenant_id = p_tenant_id
     and kind = 'build_app'
     and status = 'paused'
     and updated_at = p_expected_updated_at
  returning id into v_id;
  if v_id is null then
    return 'changed_concurrently';
  end if;
  return 'resumed';
end $$;
revoke all on function continue_paused_build(uuid, uuid, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function continue_paused_build(uuid, uuid, timestamptz, jsonb) to service_role;

commit;

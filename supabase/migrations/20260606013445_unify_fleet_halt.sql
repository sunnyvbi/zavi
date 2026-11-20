
begin;

drop function if exists is_fleet_halted();

create function is_fleet_halted()
returns boolean
language sql security definer set search_path = public stable as $$
  select case
           when not exists (select 1 from system_config where id = 1)
             then true
           else coalesce(
             (select (blob->>'fleet_halt')::boolean from system_config where id = 1),
             false
           )
         end;
$$;

revoke all on function is_fleet_halted() from public;
grant execute on function is_fleet_halted() to authenticated, service_role;

drop function if exists set_fleet_kill(boolean, text);
drop table if exists autopilot_fleet_kill;

create or replace function stop_tenant_autopilot(
  p_tenant_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_run_ids uuid[];
  v_id      uuid;
  v_count   int := 0;
begin
  if p_tenant_id is null then
    raise exception 'stop_tenant_autopilot: tenant_id is required'
      using errcode = '22023';
  end if;

  with halted as (
    update conductor_runs
       set status = 'halted', updated_at = now()
     where tenant_id = p_tenant_id
       and kind = 'company_goal'
       and status in ('active')
    returning id
  )
  select array_agg(id) into v_run_ids from halted;

  if v_run_ids is not null then
    foreach v_id in array v_run_ids loop
      perform append_autopilot_action(
        p_tenant_id,
        v_id,
        null,
        'halted',
        null,
        null,
        null,
        0::numeric,
        'halted',
        null,
        jsonb_build_object(
          'kind', 'tenant_stop',
          'halted_at', now()
        )
      );
      v_count := v_count + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'halted_runs', v_count,
    'halted_run_ids', coalesce(to_jsonb(v_run_ids), '[]'::jsonb)
  );
end $$;

revoke all on function stop_tenant_autopilot(uuid) from public;
grant execute on function stop_tenant_autopilot(uuid) to service_role;

commit;

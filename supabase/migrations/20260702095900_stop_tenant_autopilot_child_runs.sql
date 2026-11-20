
begin;

create or replace function stop_tenant_autopilot(
  p_tenant_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_run_ids uuid[];
  v_id      uuid;
  v_count   int := 0;
  v_stopped_children int := 0;
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

    update agent_runs ar
       set stop_requested = true
     where ar.tenant_id = p_tenant_id
       and ar.status = 'running'
       and ar.stop_requested is distinct from true
       and ar.id in (
         select (node->>'child_run_id')::uuid
           from conductor_runs cr
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(cr.goal_graph) = 'array'
                 then cr.goal_graph else '[]'::jsonb end
          ) node
          where cr.id = any(v_run_ids)
            and cr.tenant_id = p_tenant_id
            and (node->>'child_run_id')
                ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       );
    get diagnostics v_stopped_children = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'halted_runs', v_count,
    'halted_run_ids', coalesce(to_jsonb(v_run_ids), '[]'::jsonb),
    'stopped_child_runs', v_stopped_children
  );
end $$;

revoke all on function stop_tenant_autopilot(uuid) from public;
grant execute on function stop_tenant_autopilot(uuid) to service_role;

commit;

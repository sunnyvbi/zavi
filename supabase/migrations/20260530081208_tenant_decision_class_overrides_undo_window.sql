
begin;

alter table tenant_decision_class_overrides
  add column if not exists undo_window_minutes int not null default 15;

create or replace function undo_dispatched_node(
  p_tenant_id        uuid,
  p_conductor_run_id uuid,
  p_node_id          text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_graph         jsonb;
  v_node          jsonb;
  v_node_idx      int;
  v_node_status   text;
  v_target_slug   text;
  v_dispatch      record;
  v_decision_class text;
  v_window_min    int;
  v_elapsed_min   int;
  v_new_ledger_id uuid;
  v_new_graph     jsonb;
begin
  if p_tenant_id is null or p_conductor_run_id is null or p_node_id is null then
    raise exception 'undo_dispatched_node: tenant_id, conductor_run_id, and node_id are required'
      using errcode = '22023';
  end if;

  select goal_graph into v_graph
  from conductor_runs
  where id = p_conductor_run_id
    and tenant_id = p_tenant_id;

  if v_graph is null then
    return jsonb_build_object('ok', false, 'reason', 'conductor_run_not_found');
  end if;

  select idx - 1, elem
    into v_node_idx, v_node
  from jsonb_array_elements(v_graph) with ordinality as t(elem, idx)
  where (elem->>'id') = p_node_id
  limit 1;

  if v_node is null then
    return jsonb_build_object('ok', false, 'reason', 'node_not_found');
  end if;

  v_node_status := v_node->>'status';
  v_target_slug := v_node->>'target_agent_slug';

  if v_node_status <> 'dispatched' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'not_dispatched',
      'status', v_node_status
    );
  end if;

  select l.created_at, l.decision_id
    into v_dispatch
  from autopilot_action_ledger l
  where l.conductor_run_id = p_conductor_run_id
    and l.node_id = p_node_id
    and l.action in ('dispatch', 'dispatched')
  order by l.created_at desc
  limit 1;

  if v_dispatch.created_at is null then
    return jsonb_build_object('ok', false, 'reason', 'no_dispatch_ledger');
  end if;

  if v_dispatch.decision_id is not null then
    select decision_class into v_decision_class
    from decisions
    where id = v_dispatch.decision_id;

    if v_decision_class is not null then
      select undo_window_minutes into v_window_min
      from tenant_decision_class_overrides
      where tenant_id = p_tenant_id
        and decision_class = v_decision_class;
    end if;
  end if;

  v_window_min := coalesce(v_window_min, 15);

  v_elapsed_min := floor(extract(epoch from (now() - v_dispatch.created_at)) / 60)::int;

  if v_elapsed_min > v_window_min then
    return jsonb_build_object(
      'ok', false,
      'reason', 'window_expired',
      'elapsed_minutes', v_elapsed_min,
      'window_minutes', v_window_min
    );
  end if;

  v_new_ledger_id := append_autopilot_action(
    p_tenant_id,
    p_conductor_run_id,
    p_node_id,
    'undo',
    v_target_slug,
    null,
    v_dispatch.decision_id,
    0::numeric,
    'undone',
    null,
    jsonb_build_object(
      'reverted_from_status', 'dispatched',
      'reverted_to_status', 'pending',
      'window_minutes', v_window_min,
      'elapsed_minutes', v_elapsed_min,
      'decision_class', v_decision_class
    )
  );

  v_new_graph := jsonb_set(
    v_graph,
    array[v_node_idx::text, 'status'],
    to_jsonb('pending'::text),
    false
  );

  update conductor_runs
     set goal_graph = v_new_graph,
         updated_at = now()
   where id = p_conductor_run_id
     and tenant_id = p_tenant_id;

  return jsonb_build_object('ok', true, 'ledger_id', v_new_ledger_id);
end $$;

revoke all on function undo_dispatched_node(uuid, uuid, text) from public;
grant execute on function undo_dispatched_node(uuid, uuid, text) to service_role;

commit;

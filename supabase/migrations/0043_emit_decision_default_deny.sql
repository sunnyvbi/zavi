
create or replace function emit_decision(
  p_tenant_id uuid,
  p_agent_run_id uuid,
  p_decision_class text,
  p_body jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_autonomy decision_autonomy; v_handler text; v_status text; v_class_exists boolean;
begin
  select exists(select 1 from decision_classes where slug = p_decision_class) into v_class_exists;
  if not v_class_exists then
    raise exception 'unknown decision_class: %', p_decision_class
      using errcode = '23514';
  end if;

  v_autonomy := effective_autonomy(p_tenant_id, p_decision_class);
  select dispatch_handler into v_handler
  from decision_classes where slug = p_decision_class;

  if v_autonomy = 'forbidden' then
    v_status := 'rejected';
  elsif v_autonomy = 'auto' then
    v_status := 'proposed';
  else
    v_status := 'proposed';
  end if;

  insert into decisions (
    tenant_id, agent_run_id, decision_class, body, status,
    autonomy_at_emit, handler
  ) values (
    p_tenant_id, p_agent_run_id, p_decision_class, p_body, v_status,
    v_autonomy, v_handler
  ) returning id into v_id;

  return v_id;
end $$;
revoke all on function emit_decision(uuid, uuid, text, jsonb) from public;
grant execute on function emit_decision(uuid, uuid, text, jsonb) to service_role;

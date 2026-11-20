
create or replace function decide_decision_as_staff(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_action text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_status text;
  v_new_status text;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'invalid action %', p_action using errcode = '22023';
  end if;

  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;

  if v_tenant <> p_tenant_id then
    raise exception 'cross_tenant: decision % belongs to a different tenant', p_decision_id
      using errcode = '42501';
  end if;

  if v_status <> 'proposed' then
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;

  v_new_status := case when p_action = 'approve' then 'approved' else 'rejected' end;

  update decisions
     set status = v_new_status, approved_by = p_actor_user_id, approved_at = now()
   where id = p_decision_id and status = 'proposed';

  return jsonb_build_object('changed', true, 'status', v_new_status);
end $$;

revoke all on function decide_decision_as_staff(uuid, uuid, uuid, text) from public, authenticated, anon;
grant execute on function decide_decision_as_staff(uuid, uuid, uuid, text) to service_role;

create or replace function edit_decision_body_as_staff(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_body jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_status text;
begin
  if p_body is null then
    raise exception 'p_body is required' using errcode = '22023';
  end if;

  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_tenant <> p_tenant_id then
    return jsonb_build_object('ok', false, 'reason', 'cross_tenant');
  end if;

  if v_status <> 'proposed' then
    return jsonb_build_object('ok', false, 'reason', 'not_proposed', 'status', v_status);
  end if;

  update decisions
     set body = p_body
   where id = p_decision_id and status = 'proposed';

  return jsonb_build_object('ok', true);
end $$;

revoke all on function edit_decision_body_as_staff(uuid, uuid, uuid, jsonb) from public, authenticated, anon;
grant execute on function edit_decision_body_as_staff(uuid, uuid, uuid, jsonb) to service_role;

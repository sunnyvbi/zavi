
create or replace function edit_decision_body_if_proposed(
  p_decision_id   uuid,
  p_tenant_id     uuid,
  p_actor_user_id uuid,
  p_body          jsonb
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
  if not exists (
    select 1 from tenant_users
    where user_id = p_actor_user_id and tenant_id = p_tenant_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  if v_status <> 'proposed' then
    return jsonb_build_object('ok', false, 'reason', 'not_proposed', 'status', v_status);
  end if;

  update decisions
     set body = p_body
   where id = p_decision_id and status = 'proposed';

  return jsonb_build_object('ok', true);
end $$;

revoke all on function edit_decision_body_if_proposed(uuid, uuid, uuid, jsonb) from public, authenticated, anon;
grant execute on function edit_decision_body_if_proposed(uuid, uuid, uuid, jsonb) to service_role;


create or replace function decide_decision_as_actor(
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

  if not exists (
    select 1 from tenant_users
    where user_id = p_actor_user_id and tenant_id = p_tenant_id
  ) then
    raise exception 'not_member: actor is not a member of tenant %', p_tenant_id
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

revoke all on function decide_decision_as_actor(uuid, uuid, uuid, text) from public;
revoke all on function decide_decision_as_actor(uuid, uuid, uuid, text) from authenticated;
grant execute on function decide_decision_as_actor(uuid, uuid, uuid, text) to service_role;

create or replace function resolve_slack_approver(
  p_tenant_id uuid,
  p_slack_user_id text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_member_id uuid;
  v_email text;
  v_user_id uuid;
begin
  if p_tenant_id is null or p_slack_user_id is null or p_slack_user_id = '' then
    return null;
  end if;

  select tm.id, tm.primary_email
    into v_member_id, v_email
  from team_member_identities tmi
  join team_members tm on tm.id = tmi.member_id
  where tmi.tenant_id = p_tenant_id
    and tmi.provider = 'slack'
    and tmi.external_id = p_slack_user_id
    and tm.status = 'active'
  limit 1;

  if v_member_id is null or v_email is null then
    return null;
  end if;

  select u.id
    into v_user_id
  from auth.users u
  join tenant_users tu on tu.user_id = u.id and tu.tenant_id = p_tenant_id
  where lower(u.email) = lower(v_email)
  limit 1;

  return v_user_id;
end $$;

revoke all on function resolve_slack_approver(uuid, text) from public;
revoke all on function resolve_slack_approver(uuid, text) from authenticated;
grant execute on function resolve_slack_approver(uuid, text) to service_role;

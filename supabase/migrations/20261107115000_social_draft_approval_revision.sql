create or replace function public.approve_social_draft_as_actor(
  p_decision_id uuid, p_tenant_id uuid, p_actor_user_id uuid,
  p_expected_body jsonb, p_body jsonb, p_source text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row decisions%rowtype;
begin
  select * into v_row from decisions where id = p_decision_id for update;
  if not found then
    raise exception 'decision not found' using errcode = '42704';
  end if;
  if v_row.tenant_id is distinct from p_tenant_id then
    raise exception 'cross_tenant' using errcode = '42501';
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  if p_source is not null and p_source <> 'cgo' then
    raise exception 'invalid approval source' using errcode = '22023';
  end if;
  if v_row.decision_class is distinct from 'social.publish.v2' then
    raise exception 'invalid decision class' using errcode = '22023';
  end if;
  if v_row.status <> 'proposed' then
    return jsonb_build_object('changed', false, 'status', v_row.status);
  end if;
  if v_row.body is distinct from p_expected_body then
    raise exception 'stale_card' using errcode = '40001';
  end if;
  if jsonb_typeof(p_body) is distinct from 'object' then
    raise exception 'invalid body' using errcode = '22023';
  end if;
  update decisions set body = p_body where id = p_decision_id;
  if p_source = 'cgo' then
    return decide_decision_as_cgo(p_decision_id, p_tenant_id, p_actor_user_id, 'approve');
  end if;
  return decide_decision_as_actor(p_decision_id, p_tenant_id, p_actor_user_id, 'approve');
end $$;
revoke all on function public.approve_social_draft_as_actor(uuid,uuid,uuid,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.approve_social_draft_as_actor(uuid,uuid,uuid,jsonb,jsonb,text) to service_role;

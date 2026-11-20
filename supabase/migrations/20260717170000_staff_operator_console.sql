
alter table decisions
  add column if not exists approved_by_source text;

comment on column decisions.approved_by_source is
  'Source of the approval actor by class: ''staff'' for an admin/staff-console override (decide_decision_as_staff), NULL for a tenant-human approval. Read by capGovernsDispatch so a staff override does not count as tenant spend authority for the ads cap.';

create or replace function decide_decision_as_staff(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_action text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
     set status             = v_new_status,
         approved_by        = case when p_action = 'approve' then p_actor_user_id else approved_by end,
         approved_at        = case when p_action = 'approve' then now()          else approved_at end,
         approved_by_source = case when p_action = 'approve' then 'staff'        else approved_by_source end,
         rejected_by        = case when p_action = 'reject'  then p_actor_user_id else rejected_by end,
         rejected_at        = case when p_action = 'reject'  then now()          else rejected_at end
   where id = p_decision_id and status = 'proposed';

  return jsonb_build_object('changed', true, 'status', v_new_status);
end $$;

revoke all on function decide_decision_as_staff(uuid, uuid, uuid, text) from public, authenticated, anon;
grant execute on function decide_decision_as_staff(uuid, uuid, uuid, text) to service_role;

do $$
begin
  raise notice '20260717170000: decisions.approved_by_source added; decide_decision_as_staff stamps ''staff'' on approve (ads-cap bypass closed for staff overrides).';
end $$;

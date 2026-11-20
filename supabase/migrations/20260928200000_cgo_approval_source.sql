
comment on column decisions.approved_by_source is
  'Source of the approval actor by class: ''staff'' for an admin/staff-console override (decide_decision_as_staff), ''cgo'' for an Autopilot approval by the CGO (decide_decision_as_cgo), NULL for a tenant-human approval. Read by capGovernsDispatch: only NULL may bypass the ads spend cap.';

comment on column channel_actions.approved_by_source is
  'Source of the approval actor by class: ''staff'' for a staff route, ''cgo'' for an Autopilot approval by the CGO, NULL for a tenant-human approval. Read by capGovernsDispatch: only NULL may bypass the ads spend cap.';

create or replace function decide_decision_as_cgo(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_action text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_status text;
  v_rows int;
  v_final_status text;
begin
  if p_action is distinct from 'approve' then
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
     where user_id = p_actor_user_id and tenant_id = p_tenant_id and role = 'owner'
  ) then
    raise exception 'not_member: actor is not the owner of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  if v_status <> 'proposed' then
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;

  update decisions
     set status             = 'approved',
         approved_by        = p_actor_user_id,
         approved_at        = now(),
         approved_by_source = 'cgo'
   where id = p_decision_id and status = 'proposed';

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select status into v_final_status from decisions where id = p_decision_id;
    return jsonb_build_object('changed', false, 'status', coalesce(v_final_status, v_status));
  end if;

  return jsonb_build_object('changed', true, 'status', 'approved');
end $$;

revoke all on function decide_decision_as_cgo(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function decide_decision_as_cgo(uuid, uuid, uuid, text) to service_role;

create or replace function approve_channel_action(
  p_tenant_id     uuid,
  p_action_id     uuid,
  p_event_key     text,
  p_actor_user_id uuid default null,
  p_source        text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     channel_actions%rowtype;
  v_key     text := left(nullif(trim(p_event_key), ''), 200);
  v_attempt int;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_key is null then
    return jsonb_build_object('ok', false, 'code', 'event_key_required');
  end if;
  if p_source is not null and p_source not in ('staff', 'cgo') then
    return jsonb_build_object('ok', false, 'code', 'invalid_source');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if p_actor_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'approver_required');
  end if;
  if not exists (
    select 1 from tenant_users tu
     where tu.tenant_id = p_tenant_id and tu.user_id = p_actor_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_row.exec_class is null then
    return jsonb_build_object('ok', false, 'code', 'not_executable');
  end if;

  if exists (select 1 from channel_action_events
              where action_id = p_action_id and event_key = v_key) then
    select count(*) into v_attempt from channel_action_events
     where action_id = p_action_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'attempt', v_attempt,
                              'exec_class', v_row.exec_class);
  end if;

  if v_row.exec_status in ('queued', 'dispatching') then
    select count(*) into v_attempt from channel_action_events
     where action_id = p_action_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'queued', true,
                              'attempt', v_attempt,
                              'exec_status', v_row.exec_status);
  end if;
  if v_row.exec_status = 'executed' then
    return jsonb_build_object('ok', false, 'code', 'already_executed');
  end if;
  if v_row.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'illegal_transition',
                              'from', v_row.status, 'to', 'approved');
  end if;

  update channel_actions
     set exec_status        = 'queued',
         exec_result        = null,
         exec_claim_id      = null,
         exec_claimed_at    = null,
         approved_by        = p_actor_user_id,
         approved_by_source = p_source
   where id = p_action_id;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, actor_user_id, event_key)
  values
    (p_tenant_id, p_action_id, 'approved',
     case when p_source = 'cgo' then 'system' else 'founder' end,
     p_actor_user_id, v_key);

  select count(*) into v_attempt from channel_action_events
   where action_id = p_action_id and event = 'approved';

  return jsonb_build_object('ok', true, 'replayed', false, 'attempt', v_attempt,
                            'exec_class', v_row.exec_class);
end $$;

revoke all on function approve_channel_action(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function approve_channel_action(uuid, uuid, text, uuid, text) to service_role;

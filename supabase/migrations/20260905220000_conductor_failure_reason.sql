
begin;

alter table conductor_runs add column if not exists failure_reason text;
alter table conductor_runs add column if not exists failure_class  text;

alter table conductor_runs drop constraint if exists conductor_runs_failure_class_check;
alter table conductor_runs
  add constraint conductor_runs_failure_class_check
  check (failure_class is null or failure_class in (
    'stage_failed',
    'dispatch_failed',
    'provider_capacity',
    'repair_exhausted',
    'acceptance_failed',
    'deploy_failed',
    'budget_halted',
    'class_cap_halted',
    'stale_reaped',
    'user_cancelled',
    'unknown',
    'provision_failed',
    'coach_precedence'
  ));

create or replace function cancel_conductor_run(
  p_tenant_id               uuid,
  p_conductor_run_id        uuid,
  p_reason                  text        default 'user_cancel',
  p_require_updated_before  timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior_status     text;
  v_updated          uuid;
  v_ledger_id        uuid;
  v_stopped_children int := 0;
  v_failure_class    text;
  v_failure_reason   text;
begin
  v_failure_class := case p_reason
    when 'user_cancel'      then 'user_cancelled'
    when 'stale_slot_reap'  then 'stale_reaped'
    when 'coach_precedence' then 'coach_precedence'
    else 'unknown'
  end;
  v_failure_reason := case v_failure_class
    when 'user_cancelled'   then 'Cancelled from the workspace.'
    when 'stale_reaped'     then 'No progress within the staleness window; the wedged build slot was reclaimed.'
    when 'coach_precedence' then 'Superseded by a newer build.'
    else 'Terminated: ' || coalesce(p_reason, 'reason not supplied')
  end;
  if p_tenant_id is null or p_conductor_run_id is null then
    raise exception 'cancel_conductor_run: tenant_id and conductor_run_id are required'
      using errcode = '22023';
  end if;

  select status into v_prior_status
  from conductor_runs
  where id = p_conductor_run_id
    and tenant_id = p_tenant_id;

  if v_prior_status is null then
    return jsonb_build_object('ok', false, 'reason', 'conductor_run_not_found');
  end if;

  if v_prior_status in ('halted', 'done', 'failed') then
    return jsonb_build_object(
      'ok', true,
      'cancelled', false,
      'prior_status', v_prior_status
    );
  end if;

  update conductor_runs
     set status = 'failed',
         updated_at = now(),
         failure_class  = v_failure_class,
         failure_reason = v_failure_reason
   where id = p_conductor_run_id
     and tenant_id = p_tenant_id
     and status in ('provisioning', 'active')
     and (p_require_updated_before is null or updated_at < p_require_updated_before)
  returning id into v_updated;

  if v_updated is null then
    select status into v_prior_status
    from conductor_runs
    where id = p_conductor_run_id
      and tenant_id = p_tenant_id;
    return jsonb_build_object(
      'ok', true,
      'cancelled', false,
      'prior_status', coalesce(v_prior_status, 'unknown')
    );
  end if;

  with stopped as (
    update agent_runs
       set stop_requested = true
     where tenant_id = p_tenant_id
       and status in ('queued', 'running')
       and id in (
         select dh.target_run_id
         from dispatch_history dh
         where dh.tenant_id = p_tenant_id
           and dh.source_run_id = p_conductor_run_id
           and dh.target_run_id is not null
       )
    returning 1
  )
  select count(*) into v_stopped_children from stopped;

  v_ledger_id := append_autopilot_action(
    p_tenant_id,
    p_conductor_run_id,
    null,
    'undo',
    null,
    null,
    null,
    0::numeric,
    'cancelled',
    null,
    jsonb_build_object(
      'kind', p_reason,
      'cancelled_at', now(),
      'prior_status', v_prior_status,
      'stopped_children', v_stopped_children
    )
  );

  return jsonb_build_object(
    'ok', true,
    'cancelled', true,
    'prior_status', v_prior_status,
    'stopped_children', v_stopped_children,
    'ledger_id', v_ledger_id
  );
end $$;

revoke all on function cancel_conductor_run(uuid, uuid, text, timestamptz) from public;
revoke all on function cancel_conductor_run(uuid, uuid, text, timestamptz) from anon;
revoke all on function cancel_conductor_run(uuid, uuid, text, timestamptz) from authenticated;
grant execute on function cancel_conductor_run(uuid, uuid, text, timestamptz) to service_role;

commit;

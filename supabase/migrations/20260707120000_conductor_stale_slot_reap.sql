
begin;

drop function if exists cancel_conductor_run(uuid, uuid);

create or replace function cancel_conductor_run(
  p_tenant_id               uuid,
  p_conductor_run_id        uuid,
  p_reason                  text        default 'user_cancel',
  p_require_updated_before  timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prior_status     text;
  v_updated          uuid;
  v_ledger_id        uuid;
  v_stopped_children int := 0;
begin
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
     set status = 'failed', updated_at = now()
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
grant execute on function cancel_conductor_run(uuid, uuid, text, timestamptz) to service_role;

commit;

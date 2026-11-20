
begin;

create or replace function cancel_conductor_run(
  p_tenant_id        uuid,
  p_conductor_run_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prior_status text;
  v_updated      uuid;
  v_ledger_id    uuid;
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
      'kind', 'user_cancel',
      'cancelled_at', now(),
      'prior_status', v_prior_status
    )
  );

  return jsonb_build_object(
    'ok', true,
    'cancelled', true,
    'prior_status', v_prior_status,
    'ledger_id', v_ledger_id
  );
end $$;

revoke all on function cancel_conductor_run(uuid, uuid) from public;
grant execute on function cancel_conductor_run(uuid, uuid) to service_role;

commit;

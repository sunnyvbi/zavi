
begin;

alter table tenant_channels add column if not exists cgo_run_id uuid;
alter table tenant_channels add column if not exists cgo_plan_id uuid;

update tenant_channels c
   set cgo_plan_id = g.id
  from growth_plan g
 where c.cgo_reason is not null
   and c.cgo_plan_id is null
   and g.tenant_id = c.tenant_id
   and g.status = 'live'
   and g.created_at <= c.cgo_set_at;

create or replace function pause_channel_by_cgo(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_reason       text,
  p_run_id       uuid
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_plan    uuid;
  v_outcome text;
begin
  if p_tenant_id is null or p_channel_slug is null or nullif(trim(coalesce(p_reason, '')), '') is null then
    return 'failed';
  end if;
  select id into v_plan from growth_plan
   where tenant_id = p_tenant_id and status = 'live' for share;
  if v_plan is null then
    select id into v_plan from growth_plan
     where tenant_id = p_tenant_id and status = 'live' for share;
  end if;

  v_outcome := set_channel_in_plan_by_cgo(p_tenant_id, p_channel_slug, false);
  if v_outcome = 'ok' then
    update tenant_channels
       set cgo_reason  = left(p_reason, 300),
           cgo_set_at  = now(),
           cgo_run_id  = p_run_id,
           cgo_plan_id = v_plan
     where tenant_id = p_tenant_id and channel_slug = p_channel_slug;
  end if;
  return v_outcome;
end $$;
revoke all on function pause_channel_by_cgo(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function pause_channel_by_cgo(uuid, text, text, uuid) to service_role;

create or replace function claim_cgo_pause(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_window_days  int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row    tenant_channels%rowtype;
  v_plan   uuid;
  v_live   boolean;
  v_result text;
begin
  if p_tenant_id is null or p_channel_slug is null or p_window_days is null or p_window_days <= 0 then
    raise exception 'claim_cgo_pause: tenant, channel and a positive window are required'
      using errcode = '22023';
  end if;

  select cgo_plan_id into v_plan
    from tenant_channels
   where tenant_id = p_tenant_id and channel_slug = p_channel_slug;
  perform 1
     from growth_plan
    where id = v_plan
      and tenant_id = p_tenant_id
      and status = 'live'
    for update;
  v_live := found;

  select * into v_row
    from tenant_channels
   where tenant_id = p_tenant_id and channel_slug = p_channel_slug
   for update;
  if not found or v_row.cgo_reason is null or v_row.plan_selected then
    return jsonb_build_object('ok', false, 'code', 'nothing_to_undo');
  end if;
  if v_row.cgo_set_at is null or v_row.cgo_set_at < now() - make_interval(days => p_window_days) then
    return jsonb_build_object('ok', false, 'code', 'outside_window');
  end if;
  if not v_live or v_row.cgo_plan_id is distinct from v_plan then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;

  update tenant_channels
     set cgo_reason = null, cgo_set_at = null, cgo_run_id = null, cgo_plan_id = null
   where tenant_id = p_tenant_id and channel_slug = p_channel_slug;

  v_result := set_channel_in_plan(p_tenant_id, p_channel_slug, true);
  if v_result not in ('ok', 'already_in_plan') then
    raise exception 'claim_cgo_pause: re-adding % returned %', p_channel_slug, v_result;
  end if;

  return jsonb_build_object(
    'ok', true,
    'why', v_row.cgo_reason,
    'at', v_row.cgo_set_at,
    'run_id', v_row.cgo_run_id
  );
end $$;
revoke all on function claim_cgo_pause(uuid, text, int) from public, anon, authenticated;
grant execute on function claim_cgo_pause(uuid, text, int) to service_role;

create or replace function refund_autopilot_run(
  p_tenant_id uuid,
  p_run_id    uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_credits int;
  v_ps      date;
  v_key     text;
begin
  if p_tenant_id is null then
    raise exception 'refund_autopilot_run: tenant required' using errcode = '22023';
  end if;
  if p_run_id is null then
    return jsonb_build_object('status', 'no_run', 'credits', 0);
  end if;
  if not exists (
    select 1 from agent_runs
     where id = p_run_id and tenant_id = p_tenant_id and agent_slug = 'cgo'
  ) then
    return jsonb_build_object('status', 'no_run', 'credits', 0);
  end if;

  if not exists (
    select 1 from tenant_credit_ledger
     where run_id = p_run_id and tenant_id = p_tenant_id and kind in ('settle', 'refund')
  ) or exists (
    select 1 from tenant_credit_ledger r
     where r.run_id = p_run_id and r.tenant_id = p_tenant_id and r.kind = 'reserve'
       and not exists (
         select 1 from tenant_credit_ledger t
          where t.run_id = r.run_id and t.attempt = r.attempt and t.kind in ('settle', 'refund')
       )
  ) then
    return jsonb_build_object('status', 'pending', 'credits', 0);
  end if;

  select coalesce(sum(coalesce(debited, amount)), 0)::int into v_credits
    from tenant_credit_ledger
   where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'settle';
  if v_credits <= 0 then
    return jsonb_build_object('status', 'nothing_charged', 'credits', 0);
  end if;

  perform _credit_balance_touch(p_tenant_id);
  select period_start into v_ps from tenant_credit_balances where tenant_id = p_tenant_id;
  v_key := 'autopilot-guarantee:' || p_run_id::text;

  insert into tenant_credit_ledger
    (tenant_id, run_id, kind, amount, source, cost_usd, period_start, grant_key)
  values
    (p_tenant_id, null, 'grant', v_credits, 'purchased', null, v_ps, v_key)
  on conflict (grant_key) where kind = 'grant' and grant_key is not null
  do nothing;
  if not found then
    return jsonb_build_object('status', 'already_refunded', 'credits', v_credits);
  end if;

  update tenant_credit_balances
     set purchased_balance = purchased_balance + v_credits, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into admin_action_log (staff_email, tenant_id, action, target, after_state, on_behalf)
  values ('system:autopilot-guarantee', p_tenant_id, 'credit_grant', v_key,
          jsonb_build_object('credits', v_credits, 'reason', 'Autopilot Guarantee claim', 'run_id', p_run_id), false);

  return jsonb_build_object('status', 'refunded', 'credits', v_credits);
end $$;
revoke all on function refund_autopilot_run(uuid, uuid) from public, anon, authenticated;
grant execute on function refund_autopilot_run(uuid, uuid) to service_role;

do $$
begin
  raise notice '20260927150000: pause_channel_by_cgo + claim_cgo_pause + refund_autopilot_run (Autopilot Guarantee)';
end $$;

commit;


begin;

alter table setup_draft_refunds
  add column if not exists reason text not null default 'setup_draft'
  check (reason in ('setup_draft', 'autopilot_guarantee'));
comment on table setup_draft_refunds is
  'One row per refunded settle (run_id, attempt), from the setup-draft refund or the Autopilot Guarantee. Service role only.';

create or replace function _refund_settle_to_source_buckets(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_attempt   int,
  p_reason    text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s       record;
  v_bal_ps  date;
  v_bal_pe  date;
  v_bal_dpe date;
  v_bal_ig  bigint;
  v_bal_dg  bigint;
  v_res_day date;
  v_d       int := 0;
  v_i       int := 0;
  v_p       int := 0;
  v_total   int;
begin
  perform _credit_balance_touch(p_tenant_id);

  if exists (
    select 1 from tenant_credit_ledger
     where tenant_id = p_tenant_id and kind = 'grant'
       and grant_key in ('setup-draft:' || p_run_id::text || ':' || p_attempt::text,
                         'autopilot-guarantee:' || p_run_id::text)
  ) or exists (
    select 1 from setup_draft_refunds where run_id = p_run_id and attempt = p_attempt
  ) then
    return jsonb_build_object('status', 'already', 'credits', 0);
  end if;

  select debited, amount, debited_daily, debited_included, debited_purchased, period_start,
         included_gen, daily_gen
    into v_s
    from tenant_credit_ledger
   where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'settle' and coalesce(attempt, 0) = p_attempt;
  if not found then
    return jsonb_build_object('status', 'no_settle', 'credits', 0);
  end if;

  select min(created_at)::date into v_res_day
    from tenant_credit_ledger
   where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'reserve' and coalesce(attempt, 0) = p_attempt;

  v_total := greatest(coalesce(v_s.debited_daily, 0), 0)
           + greatest(coalesce(v_s.debited_included, 0), 0)
           + greatest(coalesce(v_s.debited_purchased, 0), 0);
  if v_s.debited is null or v_s.debited_daily is null or v_s.debited_included is null
     or v_s.debited_purchased is null or v_total > v_s.debited or v_res_day is null then
    insert into setup_draft_refunds (run_id, attempt, tenant_id, forfeited, reason)
    values (p_run_id, p_attempt, p_tenant_id, greatest(coalesce(v_s.debited, v_s.amount, 0), 0), p_reason);
    return jsonb_build_object('status', 'untracked', 'credits', 0,
                              'forfeited', greatest(coalesce(v_s.debited, v_s.amount, 0), 0));
  end if;

  select period_start, period_end, daily_period_end, included_gen, daily_gen
    into v_bal_ps, v_bal_pe, v_bal_dpe, v_bal_ig, v_bal_dg
    from tenant_credit_balances where tenant_id = p_tenant_id;

  v_p := greatest(v_s.debited_purchased, 0);
  if v_s.included_gen is not null and v_s.daily_gen is not null then
    if v_bal_ig = v_s.included_gen then
      v_i := greatest(v_s.debited_included, 0);
    end if;
    if v_bal_dg = v_s.daily_gen then
      v_d := greatest(v_s.debited_daily, 0);
    end if;
  else
    if v_bal_ps = v_s.period_start
       and not (v_bal_pe - v_bal_ps > 1 and v_s.period_start = v_res_day) then
      v_i := greatest(v_s.debited_included, 0);
    end if;
    if v_bal_dpe is not null and v_bal_dpe = v_res_day + 1 then
      v_d := greatest(v_s.debited_daily, 0);
    end if;
  end if;

  insert into setup_draft_refunds
    (run_id, attempt, tenant_id, refunded_daily, refunded_included, refunded_purchased, forfeited, reason)
  values
    (p_run_id, p_attempt, p_tenant_id, v_d, v_i, v_p, v_total - v_d - v_i - v_p, p_reason);

  update tenant_credit_balances
     set purchased_balance = purchased_balance + v_p,
         included_used     = greatest(included_used - v_i, 0),
         daily_used        = greatest(daily_used - v_d, 0),
         updated_at        = now()
   where tenant_id = p_tenant_id;

  return jsonb_build_object(
    'status', 'refunded',
    'credits', v_d + v_i + v_p,
    'daily', v_d, 'included', v_i, 'purchased', v_p,
    'forfeited', v_total - v_d - v_i - v_p
  );
end $$;
revoke all on function _refund_settle_to_source_buckets(uuid, uuid, int, text) from public, anon, authenticated, service_role;

create or replace function refund_setup_draft_settle(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_attempt   int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'refund_setup_draft_settle: service role only' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_run_id is null or p_attempt is null then
    raise exception 'refund_setup_draft_settle: tenant, run and attempt required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from setup_draft_admissions where run_id = p_run_id and tenant_id = p_tenant_id
  ) then
    return jsonb_build_object('status', 'not_setup_draft', 'credits', 0);
  end if;
  return _refund_settle_to_source_buckets(p_tenant_id, p_run_id, p_attempt, 'setup_draft');
end $$;
revoke all on function refund_setup_draft_settle(uuid, uuid, int) from public, anon, authenticated;
grant execute on function refund_setup_draft_settle(uuid, uuid, int) to service_role;

create or replace function refund_autopilot_run(
  p_tenant_id uuid,
  p_run_id    uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_debited   int;
  v_att       int;
  v_r         jsonb;
  v_new       int := 0;
  v_d         int := 0;
  v_i         int := 0;
  v_p         int := 0;
  v_forfeit   int := 0;
  v_untracked int := 0;
  v_credits   int;
  v_status    text;
  v_key       text;
begin
  if auth.uid() is not null then
    raise exception 'refund_autopilot_run: service role only' using errcode = '42501';
  end if;
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

  select coalesce(sum(coalesce(debited, amount)), 0)::int into v_debited
    from tenant_credit_ledger
   where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'settle';
  if v_debited <= 0 then
    return jsonb_build_object('status', 'nothing_charged', 'credits', 0);
  end if;

  for v_att in
    select distinct coalesce(attempt, 0) from tenant_credit_ledger
     where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'settle'
     order by 1
  loop
    v_r := _refund_settle_to_source_buckets(p_tenant_id, p_run_id, v_att, 'autopilot_guarantee');
    if v_r->>'status' = 'refunded' then
      v_new     := v_new + 1;
      v_d       := v_d + (v_r->>'daily')::int;
      v_i       := v_i + (v_r->>'included')::int;
      v_p       := v_p + (v_r->>'purchased')::int;
      v_forfeit := v_forfeit + (v_r->>'forfeited')::int;
    elsif v_r->>'status' = 'untracked' then
      v_new       := v_new + 1;
      v_untracked := v_untracked + (v_r->>'forfeited')::int;
    end if;
  end loop;

  if v_new = 0 then
    if (select coalesce(sum(refunded_daily + refunded_included + refunded_purchased), 0)
          from setup_draft_refunds
         where run_id = p_run_id and tenant_id = p_tenant_id) >= v_debited
    or exists (
      select 1 from tenant_credit_ledger
       where tenant_id = p_tenant_id and kind = 'grant'
         and (grant_key = 'autopilot-guarantee:' || p_run_id::text
              or grant_key like 'setup-draft:' || p_run_id::text || ':%')
    ) then
      return jsonb_build_object('status', 'already_refunded', 'credits', 0);
    end if;
    return jsonb_build_object('status', 'already_claimed', 'credits', 0);
  end if;

  v_credits := v_d + v_i + v_p;
  v_status  := case when v_credits > 0 then 'refunded'
                    when v_untracked > 0 then 'untracked'
                    else 'expired' end;
  v_key := 'autopilot-guarantee:' || p_run_id::text;

  insert into admin_action_log (staff_email, tenant_id, action, target, after_state, on_behalf)
  values ('system:autopilot-guarantee', p_tenant_id, 'credit_refund', v_key,
          jsonb_build_object('reason', 'Autopilot Guarantee claim', 'run_id', p_run_id, 'status', v_status,
                             'credits', v_credits, 'daily', v_d, 'included', v_i, 'purchased', v_p,
                             'forfeited', v_forfeit, 'untracked', v_untracked),
          false);

  return jsonb_build_object(
    'status', v_status, 'credits', v_credits,
    'daily', v_d, 'included', v_i, 'purchased', v_p,
    'forfeited', v_forfeit, 'untracked', v_untracked
  );
end $$;
revoke all on function refund_autopilot_run(uuid, uuid) from public, anon, authenticated;
grant execute on function refund_autopilot_run(uuid, uuid) to service_role;

do $$
begin
  raise notice '20261016140000: Autopilot Guarantee refunds go back to their source buckets';
end $$;

commit;

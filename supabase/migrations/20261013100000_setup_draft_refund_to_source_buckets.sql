
begin;

create table if not exists setup_draft_refunds (
  run_id             uuid not null references agent_runs(id) on delete cascade,
  attempt            int  not null,
  tenant_id          uuid not null references tenants(id) on delete cascade,
  refunded_daily     int  not null default 0 check (refunded_daily >= 0),
  refunded_included  int  not null default 0 check (refunded_included >= 0),
  refunded_purchased int  not null default 0 check (refunded_purchased >= 0),
  forfeited          int  not null default 0 check (forfeited >= 0),
  created_at         timestamptz not null default now(),
  primary key (run_id, attempt)
);
alter table setup_draft_refunds enable row level security;
revoke all on table setup_draft_refunds from anon, authenticated;

create or replace function refund_setup_draft_settle(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_attempt   int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s      record;
  v_bal_ps date;
  v_bal_dpe date;
  v_res_day date;
  v_d      int := 0;
  v_i      int := 0;
  v_p      int := 0;
  v_total  int;
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

  perform _credit_balance_touch(p_tenant_id);

  if exists (
    select 1 from tenant_credit_ledger
     where tenant_id = p_tenant_id and kind = 'grant'
       and grant_key = 'setup-draft:' || p_run_id::text || ':' || p_attempt::text
  ) or exists (
    select 1 from setup_draft_refunds where run_id = p_run_id and attempt = p_attempt
  ) then
    return jsonb_build_object('status', 'already', 'credits', 0);
  end if;

  select debited, debited_daily, debited_included, debited_purchased,
         period_start
    into v_s
    from tenant_credit_ledger
   where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'settle' and coalesce(attempt, 0) = p_attempt;
  if not found then
    return jsonb_build_object('status', 'no_settle', 'credits', 0);
  end if;
  if v_s.debited_daily is null or v_s.debited_included is null or v_s.debited_purchased is null then
    insert into setup_draft_refunds (run_id, attempt, tenant_id, forfeited)
    values (p_run_id, p_attempt, p_tenant_id, greatest(coalesce(v_s.debited, 0), 0));
    return jsonb_build_object('status', 'untracked', 'credits', 0);
  end if;

  select period_start, daily_period_end into v_bal_ps, v_bal_dpe
    from tenant_credit_balances where tenant_id = p_tenant_id;
  select min(created_at)::date into v_res_day
    from tenant_credit_ledger
   where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'reserve' and coalesce(attempt, 0) = p_attempt;

  v_p := greatest(v_s.debited_purchased, 0);
  if v_bal_ps = v_s.period_start then
    v_i := greatest(v_s.debited_included, 0);
  end if;
  if v_bal_dpe is not null and v_res_day is not null and v_bal_dpe = v_res_day + 1 then
    v_d := greatest(v_s.debited_daily, 0);
  end if;
  v_total := greatest(v_s.debited_daily, 0) + greatest(v_s.debited_included, 0) + greatest(v_s.debited_purchased, 0);

  insert into setup_draft_refunds
    (run_id, attempt, tenant_id, refunded_daily, refunded_included, refunded_purchased, forfeited)
  values
    (p_run_id, p_attempt, p_tenant_id, v_d, v_i, v_p, v_total - v_d - v_i - v_p);

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
revoke all on function refund_setup_draft_settle(uuid, uuid, int) from public, anon, authenticated;
grant execute on function refund_setup_draft_settle(uuid, uuid, int) to service_role;

do $$
begin
  raise notice '20261013100000: setup draft refunds go back to their source buckets';
end $$;

commit;

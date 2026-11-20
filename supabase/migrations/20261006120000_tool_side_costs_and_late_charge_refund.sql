
begin;

create table if not exists agent_run_side_costs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references agent_runs(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  cost_key    text not null check (length(cost_key) between 1 and 200),
  usd         numeric(12,6) not null check (usd >= 0),
  source      text not null check (length(source) between 1 and 80),
  created_at  timestamptz not null default now(),
  unique (run_id, cost_key)
);
alter table agent_run_side_costs enable row level security;
revoke all on table agent_run_side_costs from anon, authenticated;

create or replace function add_run_side_cost(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_cost_key  text,
  p_usd       numeric,
  p_source    text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant   uuid;
  v_finished timestamptz;
  v_inserted int;
begin
  if p_tenant_id is null or p_run_id is null or nullif(p_cost_key, '') is null
     or nullif(p_source, '') is null or p_usd is null or p_usd < 0 then
    raise exception 'add_run_side_cost: tenant, run, key, source and a non-negative usd are required'
      using errcode = '22023';
  end if;
  select tenant_id, finished_at into v_tenant, v_finished
    from agent_runs where id = p_run_id for share;
  if v_tenant is null then
    return 'no_run';
  end if;
  if v_tenant is distinct from p_tenant_id then
    raise exception 'tenant_mismatch' using errcode = '42501';
  end if;
  if v_finished is not null then
    return 'run_finished';
  end if;
  if p_usd = 0 then
    return 'zero';
  end if;
  insert into agent_run_side_costs (run_id, tenant_id, cost_key, usd, source)
  values (p_run_id, p_tenant_id, p_cost_key, p_usd, p_source)
  on conflict (run_id, cost_key) do nothing
  returning 1 into v_inserted;
  if v_inserted is null then
    return 'already';
  end if;
  return 'added';
end $$;
revoke all on function add_run_side_cost(uuid, uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function add_run_side_cost(uuid, uuid, text, numeric, text) to service_role;

create or replace function _trg_fold_run_side_costs()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  NEW.cost_usd := coalesce(NEW.cost_usd, 0)
    + coalesce((select sum(usd) from agent_run_side_costs where run_id = NEW.id), 0);
  return NEW;
end $$;
revoke all on function _trg_fold_run_side_costs() from public, anon, authenticated;

drop trigger if exists trg_agent_runs_fold_side_costs on agent_runs;
create trigger trg_agent_runs_fold_side_costs
  before update on agent_runs
  for each row
  when (OLD.finished_at is null and NEW.finished_at is not null)
  execute function _trg_fold_run_side_costs();

alter table tenant_credit_ledger add column if not exists debited_daily int;
alter table tenant_credit_ledger add column if not exists debited_included int;
alter table tenant_credit_ledger add column if not exists debited_purchased int;
comment on column tenant_credit_ledger.debited_daily is
  'settle rows (from 20261006120000): credits drawn from the daily grant. null on older rows.';
comment on column tenant_credit_ledger.debited_included is
  'settle rows (from 20261006120000): credits drawn from the monthly included pool. null on older rows.';
comment on column tenant_credit_ledger.debited_purchased is
  'settle rows (from 20261006120000): credits drawn from purchased_balance. null on older rows.';

create or replace function finalize_run_credits(
  p_run_id          uuid,
  p_cost_usd        numeric,
  p_terminal_reason text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant     uuid;
  v_held       int;
  v_ps         date;
  v_attempt    int;
  v_credits    int;
  v_ia         int;
  v_iu         int;
  v_da         int;
  v_du         int;
  v_pb         int;
  v_room       int;
  v_daily_room int;
  v_from_day   int;
  v_from_inc   int;
  v_from_pur   int;
  v_rem        int;
  v_inserted   int;
begin
  select r.tenant_id, r.amount, r.period_start, r.attempt
    into v_tenant, v_held, v_ps, v_attempt
  from tenant_credit_ledger r
  where r.run_id = p_run_id and r.kind = 'reserve'
    and not exists (
      select 1 from tenant_credit_ledger t
      where t.run_id = p_run_id and t.kind in ('settle','refund') and t.attempt = r.attempt
    )
  order by r.attempt asc
  limit 1;
  if v_tenant is null then
    return 'noop';
  end if;

  perform 1 from tenant_credit_balances where tenant_id = v_tenant for update;

  if p_cost_usd is null or p_cost_usd <= 0
     or coalesce(p_terminal_reason, '') not in ('success', 'paused_awaiting_approval') then
    insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, agent_slug, period_start, attempt)
    values (v_tenant, p_run_id, 'refund', v_held, null, v_ps, v_attempt)
    on conflict (run_id, attempt) where kind in ('settle','refund') do nothing
    returning 1 into v_inserted;
    if v_inserted is null then
      return 'noop';
    end if;
    update tenant_credit_balances
       set reserved = greatest(reserved - v_held, 0), updated_at = now()
     where tenant_id = v_tenant;
    return 'refunded';
  end if;

  v_credits := ceil(p_cost_usd / 0.0025)::int;
  select included_allowance, included_used, daily_allowance, daily_used, purchased_balance
    into v_ia, v_iu, v_da, v_du, v_pb
  from tenant_credit_balances where tenant_id = v_tenant;

  v_daily_room := greatest(v_da - v_du, 0);
  v_from_day   := least(v_credits, v_daily_room);
  v_rem        := v_credits - v_from_day;
  v_room       := greatest(v_ia - v_iu, 0);
  v_from_inc   := least(v_rem, v_room);
  v_from_pur   := least(v_rem - v_from_inc, greatest(coalesce(v_pb, 0), 0));

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, attempt, debited, debited_daily, debited_included, debited_purchased)
  values (v_tenant, p_run_id, 'settle', v_credits,
          case when v_from_pur = 0 then 'included'
               when (v_from_day + v_from_inc) = 0 then 'purchased'
               else 'mixed' end,
          null, p_cost_usd, v_ps, v_attempt, v_from_day + v_from_inc + v_from_pur, v_from_day, v_from_inc, v_from_pur)
  on conflict (run_id, attempt) where kind in ('settle','refund') do nothing
  returning 1 into v_inserted;
  if v_inserted is null then
    return 'noop';
  end if;

  update tenant_credit_balances
     set reserved          = greatest(reserved - v_held, 0),
         daily_used        = daily_used + v_from_day,
         included_used     = included_used + v_from_inc,
         purchased_balance = purchased_balance - v_from_pur,
         updated_at        = now()
   where tenant_id = v_tenant;

  return 'settled';
end $$;
revoke all on function finalize_run_credits(uuid, numeric, text) from public, anon, authenticated;
grant execute on function finalize_run_credits(uuid, numeric, text) to service_role;

create table if not exists tool_charges (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  run_id             uuid not null references agent_runs(id) on delete cascade,
  tool_call_id       text not null check (length(tool_call_id) between 1 and 200),
  card_id            uuid,
  reserved_usd       numeric(12,6) not null check (reserved_usd > 0),
  actual_usd         numeric(12,6) check (actual_usd >= 0),
  status             text not null default 'reserved'
                       check (status in ('reserved', 'refunded', 'nothing_to_refund')),
  refund_credits     int not null default 0 check (refund_credits >= 0),
  refunded_daily     int not null default 0 check (refunded_daily >= 0),
  refunded_included  int not null default 0 check (refunded_included >= 0),
  refunded_purchased int not null default 0 check (refunded_purchased >= 0),
  created_at         timestamptz not null default now(),
  settled_at         timestamptz,
  unique (run_id, tool_call_id)
);
alter table tool_charges enable row level security;
revoke all on table tool_charges from anon, authenticated;

create or replace function record_late_tool_charge(
  p_tenant_id    uuid,
  p_run_id       uuid,
  p_tool_call_id text,
  p_card_id      uuid,
  p_reserved_usd numeric
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant   uuid;
  v_finished timestamptz;
  v_inserted int;
begin
  if p_tenant_id is null or p_run_id is null or nullif(p_tool_call_id, '') is null
     or p_reserved_usd is null or p_reserved_usd <= 0 then
    raise exception 'record_late_tool_charge: tenant, run, tool call and a positive reserve are required'
      using errcode = '22023';
  end if;
  select tenant_id, finished_at into v_tenant, v_finished
    from agent_runs where id = p_run_id for share;
  if v_tenant is null then
    return 'no_run';
  end if;
  if v_tenant is distinct from p_tenant_id then
    raise exception 'tenant_mismatch' using errcode = '42501';
  end if;
  if v_finished is not null then
    return 'run_finished';
  end if;

  insert into tool_charges (tenant_id, run_id, tool_call_id, card_id, reserved_usd)
  values (p_tenant_id, p_run_id, p_tool_call_id, p_card_id, p_reserved_usd)
  on conflict (run_id, tool_call_id) do nothing
  returning 1 into v_inserted;
  if v_inserted is null then
    return 'already';
  end if;

  insert into agent_run_side_costs (run_id, tenant_id, cost_key, usd, source)
  values (p_run_id, p_tenant_id, 'late_tool_charge:' || p_tool_call_id, p_reserved_usd, 'late_tool_charge')
  on conflict (run_id, cost_key) do nothing;
  return 'recorded';
end $$;
revoke all on function record_late_tool_charge(uuid, uuid, text, uuid, numeric) from public, anon, authenticated;
grant execute on function record_late_tool_charge(uuid, uuid, text, uuid, numeric) to service_role;

create or replace function refund_tool_charge(
  p_tenant_id    uuid,
  p_run_id       uuid,
  p_tool_call_id text,
  p_actual_usd   numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row        tool_charges%rowtype;
  v_actual     numeric;
  v_nominal    int;
  v_amount     int;
  v_debited    int;
  v_sd         int;
  v_si         int;
  v_sp         int;
  v_null_alloc boolean;
  v_settle_ps  date;
  v_settle_day date;
  v_prev_nom   int;
  v_prev_owed  int;
  v_prev_d     int;
  v_prev_i     int;
  v_prev_p     int;
  v_owed_total int;
  v_owed       int;
  v_rem        int;
  v_d          int := 0;
  v_i          int := 0;
  v_p          int := 0;
  v_bal_ps     date;
  v_bal_dpe    date;
begin
  if p_tenant_id is null or p_run_id is null or nullif(p_tool_call_id, '') is null
     or p_actual_usd is null or p_actual_usd < 0 then
    raise exception 'refund_tool_charge: tenant, run, tool call and a non-negative actual are required'
      using errcode = '22023';
  end if;

  select * into v_row from tool_charges
   where run_id = p_run_id and tool_call_id = p_tool_call_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'credits', 0);
  end if;
  if v_row.tenant_id is distinct from p_tenant_id then
    raise exception 'tenant_mismatch' using errcode = '42501';
  end if;
  if v_row.status <> 'reserved' then
    return jsonb_build_object('status', 'already', 'credits',
      v_row.refunded_daily + v_row.refunded_included + v_row.refunded_purchased);
  end if;

  v_actual := least(p_actual_usd, v_row.reserved_usd);
  update tool_charges set actual_usd = v_actual where id = v_row.id;

  if exists (
    select 1 from tenant_credit_ledger r
     where r.run_id = p_run_id and r.tenant_id = p_tenant_id and r.kind = 'reserve'
       and not exists (
         select 1 from tenant_credit_ledger t
          where t.run_id = r.run_id and t.attempt = r.attempt and t.kind in ('settle', 'refund')
       )
  ) then
    return jsonb_build_object('status', 'pending', 'credits', 0);
  end if;

  perform _credit_balance_touch(p_tenant_id);

  select coalesce(sum(amount), 0)::int,
         coalesce(sum(coalesce(debited, amount)), 0)::int,
         coalesce(sum(debited_daily), 0)::int,
         coalesce(sum(debited_included), 0)::int,
         coalesce(sum(debited_purchased), 0)::int,
         bool_or(debited_daily is null or debited_included is null or debited_purchased is null),
         max(period_start),
         max(created_at)::date
    into v_amount, v_debited, v_sd, v_si, v_sp, v_null_alloc, v_settle_ps, v_settle_day
    from tenant_credit_ledger
   where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'settle';

  v_nominal := floor((v_row.reserved_usd - v_actual) / 0.0025)::int;

  if v_debited <= 0 or v_null_alloc is not false or v_nominal <= 0 then
    update tool_charges
       set status = 'nothing_to_refund', refund_credits = 0, settled_at = now()
     where id = v_row.id;
    return jsonb_build_object('status', 'nothing_to_refund', 'credits', 0);
  end if;

  select coalesce(sum(floor((reserved_usd - actual_usd) / 0.0025)), 0)::int,
         coalesce(sum(refund_credits), 0)::int,
         coalesce(sum(refunded_daily), 0)::int,
         coalesce(sum(refunded_included), 0)::int,
         coalesce(sum(refunded_purchased), 0)::int
    into v_prev_nom, v_prev_owed, v_prev_d, v_prev_i, v_prev_p
    from tool_charges
   where run_id = p_run_id and tenant_id = p_tenant_id
     and status in ('refunded', 'nothing_to_refund') and actual_usd is not null
     and id <> v_row.id;

  v_owed_total := v_debited - least(v_debited, greatest(v_amount - (v_prev_nom + v_nominal), 0));
  v_owed       := greatest(v_owed_total - v_prev_owed, 0);

  select period_start, daily_period_end into v_bal_ps, v_bal_dpe
    from tenant_credit_balances where tenant_id = p_tenant_id;
  v_rem := v_owed;
  v_p   := least(v_rem, greatest(v_sp - v_prev_p, 0));
  v_rem := v_rem - v_p;
  if v_bal_ps = v_settle_ps then
    v_i   := least(v_rem, greatest(v_si - v_prev_i, 0));
    v_rem := v_rem - v_i;
  end if;
  if v_bal_dpe is not null and v_bal_dpe = v_settle_day + 1 then
    v_d   := least(v_rem, greatest(v_sd - v_prev_d, 0));
    v_rem := v_rem - v_d;
  end if;

  update tenant_credit_balances
     set purchased_balance = purchased_balance + v_p,
         included_used     = greatest(included_used - v_i, 0),
         daily_used        = greatest(daily_used - v_d, 0),
         updated_at        = now()
   where tenant_id = p_tenant_id;

  update tool_charges
     set status             = case when v_owed > 0 then 'refunded' else 'nothing_to_refund' end,
         refund_credits     = v_owed,
         refunded_daily     = v_d,
         refunded_included  = v_i,
         refunded_purchased = v_p,
         settled_at         = now()
   where id = v_row.id;

  return jsonb_build_object(
    'status', case when v_owed > 0 then 'refunded' else 'nothing_to_refund' end,
    'credits', v_d + v_i + v_p,
    'daily', v_d, 'included', v_i, 'purchased', v_p,
    'forfeited', v_rem
  );
end $$;
revoke all on function refund_tool_charge(uuid, uuid, text, numeric) from public, anon, authenticated;
grant execute on function refund_tool_charge(uuid, uuid, text, numeric) to service_role;

do $$
begin
  raise notice '20261006120000: run side costs, settle bucket draws, late tool charge refunds';
end $$;

commit;

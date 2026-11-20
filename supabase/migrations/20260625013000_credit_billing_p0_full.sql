
create table if not exists tenant_credit_balances (
  tenant_id          uuid primary key references tenants(id) on delete cascade,
  period_start       date        not null,
  period_end         date        not null,
  included_allowance int         not null default 0,
  included_used      int         not null default 0,
  purchased_balance  int         not null default 0,
  reserved           int         not null default 0,
  updated_at         timestamptz not null default now(),
  constraint tcb_nonneg check (included_used >= 0 and included_allowance >= 0 and reserved >= 0)
);
alter table tenant_credit_balances enable row level security;
drop policy if exists tenant_credit_balances_select_own on tenant_credit_balances;
create policy tenant_credit_balances_select_own on tenant_credit_balances
  for select to authenticated
  using (tenant_id in (select tenant_id from tenant_users where user_id = auth.uid()));

create table if not exists tenant_credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  run_id          uuid,
  kind            text not null check (kind in ('reserve','settle','refund','topup')),
  amount          int  not null,
  source          text not null default 'included' check (source in ('included','purchased','mixed','stripe')),
  agent_slug      text,
  cost_usd        numeric(12,6),
  period_start    date not null,
  stripe_payment_intent_id text,
  stripe_event_id          text,
  created_at      timestamptz not null default now()
);
alter table tenant_credit_ledger enable row level security;
drop policy if exists tenant_credit_ledger_select_own on tenant_credit_ledger;
create policy tenant_credit_ledger_select_own on tenant_credit_ledger
  for select to authenticated
  using (tenant_id in (select tenant_id from tenant_users where user_id = auth.uid()));

create unique index if not exists tcl_run_reserve_uq
  on tenant_credit_ledger (run_id) where kind = 'reserve';
create unique index if not exists tcl_run_terminal_uq
  on tenant_credit_ledger (run_id) where kind in ('settle','refund');
create unique index if not exists tcl_topup_payment_uq
  on tenant_credit_ledger (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create unique index if not exists tcl_topup_event_uq
  on tenant_credit_ledger (stripe_event_id) where stripe_event_id is not null;
create index if not exists tcl_tenant_created_idx
  on tenant_credit_ledger (tenant_id, created_at desc);

create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public as $$
  select case
    when s.grandfathered then 250000
    when s.plan = 'solo'       then 20000
    when s.plan = 'team'       then 80000
    when s.plan = 'full'       then 300000
    when s.plan = 'enterprise' then 20000000
    else 40000
  end
  from (select 1) one
  left join tenant_subscriptions s on s.tenant_id = p_tenant_id;
$$;

create or replace function _credit_balance_touch(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_allow int;
begin
  v_allow := _credit_allowance_for_tenant(p_tenant_id);
  insert into tenant_credit_balances (tenant_id, period_start, period_end, included_allowance)
  values (p_tenant_id,
          date_trunc('month', current_date)::date,
          (date_trunc('month', current_date) + interval '1 month')::date,
          v_allow)
  on conflict (tenant_id) do nothing;
  perform 1 from tenant_credit_balances where tenant_id = p_tenant_id for update;
  update tenant_credit_balances
     set period_start       = case when current_date >= period_end
                                   then date_trunc('month', current_date)::date else period_start end,
         period_end         = case when current_date >= period_end
                                   then (date_trunc('month', current_date) + interval '1 month')::date else period_end end,
         included_used      = case when current_date >= period_end then 0 else included_used end,
         included_allowance = v_allow,
         updated_at         = now()
   where tenant_id = p_tenant_id;
end $$;

create or replace function _reserve_estimate_for(p_slug text)
returns int language sql immutable as $$
  select case p_slug
    when 'engineer'             then 2000
    when 'product-builder'      then 2400
    when 'fundraising'          then 500
    when 'growth-lead'          then 320
    when 'research'             then 320
    when 'advisor'              then 320
    when 'browser-operator'     then 240
    when 'performance-marketer' then 160
    when 'operator'             then 160
    when 'pm'                   then 160
    when 'support-lead'         then 160
    when 'dispute-response'     then 160
    when 'chief-of-staff'       then 160
    when 'qa'                   then 160
    else 160
  end;
$$;

create or replace function _credits_enforced()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (blob->>'credits_enforced')::boolean from system_config where id = 1), false);
$$;

create or replace function reserve_run_credits(
  p_tenant_id  uuid,
  p_run_id     uuid,
  p_agent_slug text,
  p_estimate   int
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_avail int;
  v_ps    date;
begin
  if p_tenant_id is null or p_run_id is null then
    raise exception 'reserve_run_credits: tenant_id and run_id required' using errcode = '22023';
  end if;
  if p_estimate is null or p_estimate < 0 then
    raise exception 'reserve_run_credits: estimate must be >= 0' using errcode = '22023';
  end if;

  perform _credit_balance_touch(p_tenant_id);

  if exists (select 1 from tenant_credit_ledger where run_id = p_run_id and kind = 'reserve') then
    return false;
  end if;

  select (included_allowance - included_used) + purchased_balance - reserved, period_start
    into v_avail, v_ps
  from tenant_credit_balances where tenant_id = p_tenant_id;

  if v_avail < p_estimate then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  update tenant_credit_balances
     set reserved = reserved + p_estimate, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, agent_slug, period_start)
  values (p_tenant_id, p_run_id, 'reserve', p_estimate, p_agent_slug, v_ps)
  on conflict (run_id) where kind = 'reserve' do nothing;

  return true;
end $$;

create or replace function finalize_run_credits(
  p_run_id          uuid,
  p_cost_usd        numeric,
  p_terminal_reason text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid;
  v_held     int;
  v_ps       date;
  v_credits  int;
  v_ia       int;
  v_iu       int;
  v_room     int;
  v_from_inc int;
  v_from_pur int;
begin
  select tenant_id, amount, period_start into v_tenant, v_held, v_ps
  from tenant_credit_ledger where run_id = p_run_id and kind = 'reserve';
  if v_tenant is null then
    return 'noop';
  end if;

  if exists (select 1 from tenant_credit_ledger where run_id = p_run_id and kind in ('settle','refund')) then
    return 'noop';
  end if;

  perform 1 from tenant_credit_balances where tenant_id = v_tenant for update;

  if p_cost_usd is null or p_cost_usd <= 0 then
    update tenant_credit_balances
       set reserved = greatest(reserved - v_held, 0), updated_at = now()
     where tenant_id = v_tenant;
    insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, agent_slug, period_start)
    values (v_tenant, p_run_id, 'refund', v_held, null, v_ps)
    on conflict (run_id) where kind in ('settle','refund') do nothing;
    return 'refunded';
  end if;

  v_credits := ceil(p_cost_usd / 0.0025)::int;
  update tenant_credit_balances
     set reserved = greatest(reserved - v_held, 0), updated_at = now()
   where tenant_id = v_tenant;

  select included_allowance, included_used into v_ia, v_iu
  from tenant_credit_balances where tenant_id = v_tenant;
  v_room     := greatest(v_ia - v_iu, 0);
  v_from_inc := least(v_credits, v_room);
  v_from_pur := v_credits - v_from_inc;

  update tenant_credit_balances
     set included_used     = included_used + v_from_inc,
         purchased_balance = purchased_balance - v_from_pur,
         updated_at        = now()
   where tenant_id = v_tenant;

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start)
  values (v_tenant, p_run_id, 'settle', v_credits,
          case when v_from_pur = 0 then 'included' when v_from_inc = 0 then 'purchased' else 'mixed' end,
          null, p_cost_usd, v_ps)
  on conflict (run_id) where kind in ('settle','refund') do nothing;

  return 'settled';
end $$;

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced() then
    return null;
  end if;
  if NEW.status = 'queued' then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug));
  end if;
  return null;
end $$;

drop trigger if exists trg_agent_runs_reserve_credits on agent_runs;
create trigger trg_agent_runs_reserve_credits
  after insert on agent_runs
  for each row execute function _trg_reserve_run_credits();

create or replace function _trg_finalize_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced() then
    return null;
  end if;
  if OLD.status in ('queued','running')
     and NEW.status in ('success','parse_failed','error','failed','cancelled','dispatch_error') then
    perform finalize_run_credits(NEW.id, NEW.cost_usd, NEW.status);
  end if;
  return null;
end $$;

drop trigger if exists trg_agent_runs_finalize_credits on agent_runs;
create trigger trg_agent_runs_finalize_credits
  after update of status on agent_runs
  for each row execute function _trg_finalize_run_credits();

update system_config
set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{credits_enforced}', 'false'::jsonb)
where id = 1 and not (blob ? 'credits_enforced');

insert into tenant_credit_balances (tenant_id, period_start, period_end, included_allowance)
select t.id,
       date_trunc('month', current_date)::date,
       (date_trunc('month', current_date) + interval '1 month')::date,
       _credit_allowance_for_tenant(t.id)
from tenants t
on conflict (tenant_id) do nothing;

do $$
declare n int; m int;
begin
  select count(*) into n from tenant_credit_balances;
  select count(*) into m from tenants;
  raise notice '20260625013000: credit P0 full — balances seeded % of % tenants; triggers wired; flag OFF (inert)', n, m;
end $$;

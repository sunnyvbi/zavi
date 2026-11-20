begin;

create table if not exists public.conductor_budget_charges (
  conductor_run_id uuid not null references public.conductor_runs(id) on delete cascade,
  charge_key       text not null check (length(charge_key) between 1 and 200),
  amount_usd       numeric not null check (amount_usd >= 0),
  charged_at       timestamptz not null default now(),
  primary key (conductor_run_id, charge_key)
);
alter table public.conductor_budget_charges enable row level security;
revoke all on public.conductor_budget_charges from public, anon, authenticated;
grant select, insert, delete on public.conductor_budget_charges to service_role;

create or replace function public.consume_conductor_budget_once(
  p_conductor_run_id uuid,
  p_estimate_usd     numeric,
  p_charge_key       text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_status  text;
  v_updated uuid;
begin
  if p_conductor_run_id is null or p_estimate_usd is null or p_estimate_usd < 0
     or p_charge_key is null or length(p_charge_key) not between 1 and 200 then
    raise exception 'consume_conductor_budget_once: null/invalid argument' using errcode = '22023';
  end if;

  select r.status into v_status from public.conductor_runs r where r.id = p_conductor_run_id for update;
  if not found then
    return 'over_cap';
  end if;

  if exists (select 1 from public.conductor_budget_charges c
              where c.conductor_run_id = p_conductor_run_id and c.charge_key = p_charge_key) then
    return 'already_charged';
  end if;

  update public.conductor_runs r
     set spend_usd = r.spend_usd + p_estimate_usd,
         updated_at = now()
   where r.id = p_conductor_run_id
     and r.status not in ('halted', 'done', 'failed')
     and (r.max_usd is null or r.spend_usd + p_estimate_usd <= r.max_usd)
  returning r.id into v_updated;

  if v_updated is not null then
    insert into public.conductor_budget_charges (conductor_run_id, charge_key, amount_usd)
    values (p_conductor_run_id, p_charge_key, p_estimate_usd);
    return 'charged';
  end if;

  update public.conductor_runs r
     set status = 'halted', updated_at = now()
   where r.id = p_conductor_run_id
     and r.status not in ('halted', 'done', 'failed');
  return 'over_cap';
end $$;

revoke all on function public.consume_conductor_budget_once(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.consume_conductor_budget_once(uuid, numeric, text) to service_role;

create or replace function public.refund_conductor_budget_once(
  p_conductor_run_id uuid,
  p_charge_key       text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_amount numeric;
begin
  if p_conductor_run_id is null or p_charge_key is null then
    return false;
  end if;
  delete from public.conductor_budget_charges c
   where c.conductor_run_id = p_conductor_run_id and c.charge_key = p_charge_key
  returning c.amount_usd into v_amount;
  if v_amount is null then
    return false;
  end if;
  update public.conductor_runs r
     set spend_usd = greatest(0, r.spend_usd - v_amount),
         updated_at = now()
   where r.id = p_conductor_run_id;
  return true;
end $$;

revoke all on function public.refund_conductor_budget_once(uuid, text) from public, anon, authenticated;
grant execute on function public.refund_conductor_budget_once(uuid, text) to service_role;

commit;

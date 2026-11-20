
alter table tenant_credit_ledger drop constraint if exists tenant_credit_ledger_kind_check;
alter table tenant_credit_ledger add constraint tenant_credit_ledger_kind_check
  check (kind in ('reserve','settle','refund','topup','topup_revoke'));

drop index if exists tcl_topup_payment_uq;
create unique index if not exists tcl_topup_payment_uq
  on tenant_credit_ledger (stripe_payment_intent_id)
  where kind = 'topup' and stripe_payment_intent_id is not null;

create or replace function apply_credit_topup(
  p_tenant_id                uuid,
  p_credits                  int,
  p_stripe_payment_intent_id text,
  p_stripe_event_id          text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_ps date;
begin
  if p_tenant_id is null or p_credits is null or p_credits <= 0
     or p_stripe_payment_intent_id is null then
    raise exception 'apply_credit_topup: tenant_id, positive credits, payment_intent required'
      using errcode = '22023';
  end if;

  perform _credit_balance_touch(p_tenant_id);
  select period_start into v_ps from tenant_credit_balances where tenant_id = p_tenant_id;

  insert into tenant_credit_ledger
    (tenant_id, run_id, kind, amount, source, cost_usd, period_start,
     stripe_payment_intent_id, stripe_event_id)
  values
    (p_tenant_id, null, 'topup', p_credits, 'stripe', null, v_ps,
     p_stripe_payment_intent_id, p_stripe_event_id)
  on conflict (stripe_payment_intent_id) where kind = 'topup' and stripe_payment_intent_id is not null
  do nothing;

  if not found then
    return false;
  end if;

  update tenant_credit_balances
     set purchased_balance = purchased_balance + p_credits, updated_at = now()
   where tenant_id = p_tenant_id;
  return true;
end $$;
revoke all on function apply_credit_topup(uuid, int, text, text) from public, anon, authenticated;
grant execute on function apply_credit_topup(uuid, int, text, text) to service_role;

create or replace function revoke_credit_topup(
  p_stripe_payment_intent_id text,
  p_stripe_event_id          text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_amount int;
  v_ps     date;
begin
  if p_stripe_payment_intent_id is null then
    raise exception 'revoke_credit_topup: payment_intent required' using errcode = '22023';
  end if;

  select tenant_id, amount into v_tenant, v_amount
  from tenant_credit_ledger
  where kind = 'topup' and stripe_payment_intent_id = p_stripe_payment_intent_id;
  if v_tenant is null then
    return false;
  end if;

  perform 1 from tenant_credit_balances where tenant_id = v_tenant for update;

  if exists (
    select 1 from tenant_credit_ledger
    where kind = 'topup_revoke' and stripe_payment_intent_id = p_stripe_payment_intent_id
  ) then
    return false;
  end if;

  select period_start into v_ps from tenant_credit_balances where tenant_id = v_tenant;

  update tenant_credit_balances
     set purchased_balance = purchased_balance - v_amount, updated_at = now()
   where tenant_id = v_tenant;

  insert into tenant_credit_ledger
    (tenant_id, run_id, kind, amount, source, period_start,
     stripe_payment_intent_id, stripe_event_id)
  values
    (v_tenant, null, 'topup_revoke', v_amount, 'stripe', v_ps,
     p_stripe_payment_intent_id, p_stripe_event_id);
  return true;
end $$;
revoke all on function revoke_credit_topup(text, text) from public, anon, authenticated;
grant execute on function revoke_credit_topup(text, text) to service_role;

do $$
begin
  raise notice '20260704082345: credit top-up grant + clawback RPCs created (service_role only; inert until wired live)';
end $$;

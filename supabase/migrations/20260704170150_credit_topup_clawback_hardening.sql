
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

  perform pg_advisory_xact_lock(hashtext(p_stripe_payment_intent_id));

  perform _credit_balance_touch(p_tenant_id);

  if exists (
    select 1 from tenant_credit_ledger
    where kind = 'topup_revoke' and stripe_payment_intent_id = p_stripe_payment_intent_id
  ) then
    return false;
  end if;

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

drop function if exists revoke_credit_topup(text, text);
create or replace function revoke_credit_topup(
  p_stripe_payment_intent_id text,
  p_stripe_event_id          text,
  p_tenant_hint              uuid
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_amount int;
  v_ps     date;
begin
  if p_stripe_payment_intent_id is null then
    raise exception 'revoke_credit_topup: payment_intent required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_stripe_payment_intent_id));

  select tenant_id, amount into v_tenant, v_amount
  from tenant_credit_ledger
  where kind = 'topup' and stripe_payment_intent_id = p_stripe_payment_intent_id;

  if v_tenant is not null then
    perform 1 from tenant_credit_balances where tenant_id = v_tenant for update;
    if exists (
      select 1 from tenant_credit_ledger
      where kind = 'topup_revoke' and stripe_payment_intent_id = p_stripe_payment_intent_id
    ) then
      return 'noop';
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
    return 'revoked';
  end if;

  if p_tenant_hint is null then
    return 'not_a_topup';
  end if;
  perform _credit_balance_touch(p_tenant_hint);
  if exists (
    select 1 from tenant_credit_ledger
    where kind = 'topup_revoke' and stripe_payment_intent_id = p_stripe_payment_intent_id
  ) then
    return 'noop';
  end if;
  select period_start into v_ps from tenant_credit_balances where tenant_id = p_tenant_hint;
  insert into tenant_credit_ledger
    (tenant_id, run_id, kind, amount, source, period_start,
     stripe_payment_intent_id, stripe_event_id)
  values
    (p_tenant_hint, null, 'topup_revoke', 0, 'stripe', v_ps,
     p_stripe_payment_intent_id, p_stripe_event_id);
  return 'tombstoned';
end $$;
revoke all on function revoke_credit_topup(text, text, uuid) from public, anon, authenticated;
grant execute on function revoke_credit_topup(text, text, uuid) to service_role;

do $$
begin
  raise notice '20260704170150: credit top-up clawback hardened (tombstone + tenant-hint + full-claw)';
end $$;

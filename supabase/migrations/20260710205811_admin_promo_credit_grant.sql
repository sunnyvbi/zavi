
alter table tenant_credit_ledger drop constraint if exists tenant_credit_ledger_kind_check;
alter table tenant_credit_ledger
  add constraint tenant_credit_ledger_kind_check
  check (kind in ('reserve','settle','refund','topup','grant'));

alter table tenant_credit_ledger add column if not exists grant_key text;
create unique index if not exists tenant_credit_ledger_grant_key_uq
  on tenant_credit_ledger (grant_key)
  where kind = 'grant' and grant_key is not null;

create or replace function grant_promo_credits(
  p_tenant_id   uuid,
  p_credits     int,
  p_reason      text,
  p_grant_key   text,
  p_actor_email text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_ps date;
begin
  if p_tenant_id is null or p_credits is null or p_credits <= 0
     or p_grant_key is null or length(coalesce(p_reason, '')) = 0
     or p_actor_email is null then
    raise exception 'grant_promo_credits: tenant_id, positive credits, reason, grant_key, actor required'
      using errcode = '22023';
  end if;
  if p_credits > 100000 then
    raise exception 'grant_promo_credits: p_credits exceeds per-grant cap (100000)'
      using errcode = '22023';
  end if;

  perform _credit_balance_touch(p_tenant_id);
  select period_start into v_ps from tenant_credit_balances where tenant_id = p_tenant_id;

  insert into tenant_credit_ledger
    (tenant_id, run_id, kind, amount, source, cost_usd, period_start, grant_key)
  values
    (p_tenant_id, null, 'grant', p_credits, 'purchased', null, v_ps, p_grant_key)
  on conflict (grant_key) where kind = 'grant' and grant_key is not null
  do nothing;

  if not found then
    return false;
  end if;

  update tenant_credit_balances
     set purchased_balance = purchased_balance + p_credits, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into admin_action_log (staff_email, tenant_id, action, target, after_state, on_behalf)
  values (p_actor_email, p_tenant_id, 'credit_grant', p_grant_key,
          jsonb_build_object('credits', p_credits, 'reason', p_reason), false);

  return true;
end $$;
revoke all on function grant_promo_credits(uuid, int, text, text, text) from public, anon, authenticated;
grant execute on function grant_promo_credits(uuid, int, text, text, text) to service_role;

create or replace function revoke_promo_credits(
  p_grant_key   text,
  p_actor_email text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_amount int;
begin
  if p_grant_key is null then
    raise exception 'revoke_promo_credits: grant_key required' using errcode = '22023';
  end if;

  select tenant_id, amount into v_tenant, v_amount
    from tenant_credit_ledger
   where kind = 'grant' and grant_key = p_grant_key
   limit 1;

  if v_tenant is null then
    return false;
  end if;
  if exists (select 1 from tenant_credit_ledger
              where kind = 'grant' and grant_key = p_grant_key || ':revoked') then
    return false;
  end if;

  perform _credit_balance_touch(v_tenant);

  insert into tenant_credit_ledger
    (tenant_id, run_id, kind, amount, source, cost_usd, period_start, grant_key)
  select v_tenant, null, 'grant', -v_amount, 'purchased', null, period_start, p_grant_key || ':revoked'
    from tenant_credit_balances where tenant_id = v_tenant;

  update tenant_credit_balances
     set purchased_balance = purchased_balance - v_amount, updated_at = now()
   where tenant_id = v_tenant;

  insert into admin_action_log (staff_email, tenant_id, action, target, after_state, on_behalf)
  values (p_actor_email, v_tenant, 'credit_grant_revoke', p_grant_key,
          jsonb_build_object('credits', -v_amount), false);

  return true;
end $$;
revoke all on function revoke_promo_credits(text, text) from public, anon, authenticated;
grant execute on function revoke_promo_credits(text, text) to service_role;

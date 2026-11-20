
create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.grandfathered then 250000
    when s.credits_revoked_at is not null then coalesce(s.monthly_credits, 0)
    when s.status = 'canceled' then _free_daily_credits()
    when s.monthly_usd is not null then _tier_credits(s.monthly_usd)
    when s.monthly_credits is not null then s.monthly_credits
    when s.plan = 'solo'       then 20000
    when s.plan = 'team'       then 80000
    when s.plan = 'full'       then 300000
    when s.plan = 'enterprise' then 20000000
    else _free_daily_credits()
  end
  from (select 1) one
  left join tenant_subscriptions s on s.tenant_id = p_tenant_id;
$$;

create or replace function _is_free_daily_tenant(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select not s.grandfathered
            and (
                  (s.monthly_credits is null
                   and s.monthly_usd is null
                   and s.plan = 'free')
               or (s.status = 'canceled'
                   and s.credits_revoked_at is null)
                )
       from tenant_subscriptions s
      where s.tenant_id = p_tenant_id),
    true
  );
$$;

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

  if p_cost_usd is null or p_cost_usd <= 0 then
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

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, attempt)
  values (v_tenant, p_run_id, 'settle', v_credits,
          case when v_from_pur = 0 then 'included'
               when (v_from_day + v_from_inc) = 0 then 'purchased'
               else 'mixed' end,
          null, p_cost_usd, v_ps, v_attempt)
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

revoke all on function _is_free_daily_tenant(uuid)        from public, anon, authenticated;
revoke all on function _credit_allowance_for_tenant(uuid) from public, anon, authenticated;
grant execute on function _is_free_daily_tenant(uuid)        to service_role;
grant execute on function _credit_allowance_for_tenant(uuid) to service_role;

do $$
declare n int;
begin
  update tenant_credit_balances b
     set purchased_balance = 0, updated_at = now()
   where b.purchased_balance < 0
     and not exists (
       select 1 from tenant_credit_ledger l
        where l.tenant_id = b.tenant_id
          and (l.kind = 'topup_revoke' or (l.kind = 'grant' and l.amount < 0))
     );
  get diagnostics n = row_count;
  raise notice '20260917010000: cleared % negative purchased_balance row(s) to 0', n;
end $$;

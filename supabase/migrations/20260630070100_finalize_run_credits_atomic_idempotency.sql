
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
  v_inserted int;
begin
  select tenant_id, amount, period_start into v_tenant, v_held, v_ps
  from tenant_credit_ledger where run_id = p_run_id and kind = 'reserve';
  if v_tenant is null then
    return 'noop';
  end if;

  perform 1 from tenant_credit_balances where tenant_id = v_tenant for update;

  if p_cost_usd is null or p_cost_usd <= 0 then
    insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, agent_slug, period_start)
    values (v_tenant, p_run_id, 'refund', v_held, null, v_ps)
    on conflict (run_id) where kind in ('settle','refund') do nothing
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
  select included_allowance, included_used into v_ia, v_iu
  from tenant_credit_balances where tenant_id = v_tenant;
  v_room     := greatest(v_ia - v_iu, 0);
  v_from_inc := least(v_credits, v_room);
  v_from_pur := v_credits - v_from_inc;

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start)
  values (v_tenant, p_run_id, 'settle', v_credits,
          case when v_from_pur = 0 then 'included' when v_from_inc = 0 then 'purchased' else 'mixed' end,
          null, p_cost_usd, v_ps)
  on conflict (run_id) where kind in ('settle','refund') do nothing
  returning 1 into v_inserted;
  if v_inserted is null then
    return 'noop';
  end if;

  update tenant_credit_balances
     set reserved          = greatest(reserved - v_held, 0),
         included_used     = included_used + v_from_inc,
         purchased_balance = purchased_balance - v_from_pur,
         updated_at        = now()
   where tenant_id = v_tenant;

  return 'settled';
end $$;

do $$
begin
  raise notice '20260630070100: finalize_run_credits now atomic (insert-returning-1 guard before balance mutation)';
end $$;

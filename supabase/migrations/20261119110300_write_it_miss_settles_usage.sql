begin;

alter table agent_runs add column if not exists settle_at_usage boolean;

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
  v_ig         bigint;
  v_dg         bigint;
  v_flat       int;
  v_usage      boolean;
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

  select r.billed_credits, coalesce(r.settle_at_usage, false) into v_flat, v_usage from agent_runs r where r.id = p_run_id;
  if v_flat is not null and v_usage
     and coalesce((select blob->>'flat_job_pricing' from system_config where id = 1), 'true') <> 'false' then
    v_credits := least(ceil(p_cost_usd / 0.0025)::int, v_flat);
    if v_credits < v_flat then
      update agent_runs set billed_credits = null where id = p_run_id;
    end if;
  elsif v_flat is not null
     and coalesce((select blob->>'flat_job_pricing' from system_config where id = 1), 'true') <> 'false' then
    v_credits := v_flat;
  else
    if v_flat is not null then
      update agent_runs set billed_credits = null where id = p_run_id;
    end if;
    v_credits := ceil(p_cost_usd / 0.0025)::int;
  end if;
  select included_allowance, included_used, daily_allowance, daily_used, purchased_balance,
         included_gen, daily_gen
    into v_ia, v_iu, v_da, v_du, v_pb, v_ig, v_dg
  from tenant_credit_balances where tenant_id = v_tenant;

  v_daily_room := greatest(v_da - v_du, 0);
  v_from_day   := least(v_credits, v_daily_room);
  v_rem        := v_credits - v_from_day;
  v_room       := greatest(v_ia - v_iu, 0);
  v_from_inc   := least(v_rem, v_room);
  v_from_pur   := least(v_rem - v_from_inc, greatest(coalesce(v_pb, 0), 0));

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, attempt, debited, debited_daily, debited_included, debited_purchased, included_gen, daily_gen)
  values (v_tenant, p_run_id, 'settle', v_credits,
          case when v_from_pur = 0 then 'included'
               when (v_from_day + v_from_inc) = 0 then 'purchased'
               else 'mixed' end,
          null, p_cost_usd, v_ps, v_attempt, v_from_day + v_from_inc + v_from_pur, v_from_day, v_from_inc, v_from_pur, v_ig, v_dg)
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

notify pgrst, 'reload schema';

commit;

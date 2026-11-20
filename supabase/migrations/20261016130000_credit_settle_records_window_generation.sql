
begin;

alter table tenant_credit_balances add column if not exists included_gen bigint not null default 0;
alter table tenant_credit_balances add column if not exists daily_gen    bigint not null default 0;
alter table tenant_credit_ledger   add column if not exists included_gen bigint;
alter table tenant_credit_ledger   add column if not exists daily_gen    bigint;

create or replace function _credit_balance_touch(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allow  int;
  v_free   boolean;
  v_ps     date;
  v_pe     date;
  v_daily  int;
  v_anchor date;
  v_end    timestamptz;
  v_today  date := current_date;
  v_shift  interval := interval '0';
begin
  v_allow := _credit_allowance_for_tenant(p_tenant_id);
  v_free  := _is_free_daily_tenant(p_tenant_id);

  if v_free then
    v_ps := current_date;
    v_pe := (current_date + interval '1 day')::date;
    v_daily := 0;
  else
    select s.current_period_end
      into v_end
      from tenant_subscriptions s
     where s.tenant_id = p_tenant_id
       and s.current_period_end is not null;

    if v_end is not null then
      v_anchor := (v_end at time zone 'UTC')::date;
      v_shift  := (v_end at time zone 'UTC') - date_trunc('day', v_end at time zone 'UTC');
      v_today  := ((now() at time zone 'UTC') - v_shift)::date;
      select w.period_start, w.period_end
        into v_ps, v_pe
        from _credit_month_window(v_anchor, v_today) w;
    else
      v_ps := date_trunc('month', current_date)::date;
      v_pe := (date_trunc('month', current_date) + interval '1 month')::date;
    end if;
    begin
      v_daily := _free_daily_credits();
    exception when others then
      v_daily := 0;
    end;
  end if;

  insert into tenant_credit_balances (tenant_id, period_start, period_end, included_allowance)
  values (p_tenant_id, v_ps, v_pe, v_allow)
  on conflict (tenant_id) do nothing;

  perform 1 from tenant_credit_balances where tenant_id = p_tenant_id for update;

  update tenant_credit_balances
     set period_start       = case when v_today >= period_end or period_end <> v_pe
                                   then v_ps else period_start end,
         period_end         = case when v_today >= period_end or period_end <> v_pe
                                   then v_pe else period_end end,
         included_used      = case when v_today >= period_end
                                     or (period_end - period_start = 1) <> v_free
                                   then 0 else included_used end,
         included_allowance = v_allow,
         daily_used         = case when daily_period_end is null
                                     or current_date >= daily_period_end
                                     or v_daily = 0
                                   then 0 else daily_used end,
         included_gen       = included_gen + case when v_today >= period_end
                                                    or (period_end - period_start = 1) <> v_free
                                                  then 1 else 0 end,
         daily_gen          = daily_gen + case when daily_period_end is null
                                                 or current_date >= daily_period_end
                                                 or v_daily = 0
                                               then 1 else 0 end,
         daily_period_end   = case when v_daily = 0 then null
                                   when daily_period_end is null or current_date >= daily_period_end
                                   then (current_date + interval '1 day')::date
                                   else daily_period_end end,
         daily_allowance    = v_daily,
         updated_at         = now()
   where tenant_id = p_tenant_id;
end $$;

revoke all on function _credit_balance_touch(uuid) from public, anon, authenticated;
grant execute on function _credit_balance_touch(uuid) to service_role;

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

do $$
begin
  raise notice '20261016130000: settle rows record the credit generations they debited';
end $$;

commit;

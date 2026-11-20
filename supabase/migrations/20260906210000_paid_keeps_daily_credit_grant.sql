
alter table tenant_credit_balances
  add column if not exists daily_allowance  int  not null default 0,
  add column if not exists daily_used       int  not null default 0,
  add column if not exists daily_period_end date;

comment on column tenant_credit_balances.daily_allowance is
  'Use-it-or-lose-it daily grant. 0 for free tenants (their grant already lives in included_allowance on a daily period); _free_daily_credits() for paid tenants, who keep it ON TOP of the monthly pool.';

create or replace function _credit_balance_touch(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allow int;
  v_free  boolean;
  v_ps    date;
  v_pe    date;
  v_daily int;
begin
  v_allow := _credit_allowance_for_tenant(p_tenant_id);
  v_free  := _is_free_daily_tenant(p_tenant_id);

  if v_free then
    v_ps := current_date;
    v_pe := (current_date + interval '1 day')::date;
    v_daily := 0;
  else
    v_ps := date_trunc('month', current_date)::date;
    v_pe := (date_trunc('month', current_date) + interval '1 month')::date;
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
     set period_start       = case when current_date >= period_end or period_end <> v_pe
                                   then v_ps else period_start end,
         period_end         = case when current_date >= period_end or period_end <> v_pe
                                   then v_pe else period_end end,
         included_used      = case when current_date >= period_end or period_end <> v_pe
                                   then 0 else included_used end,
         included_allowance = v_allow,
         daily_used         = case when daily_period_end is null
                                     or current_date >= daily_period_end
                                     or v_daily = 0
                                   then 0 else daily_used end,
         daily_period_end   = case when v_daily = 0 then null
                                   when daily_period_end is null or current_date >= daily_period_end
                                   then (current_date + interval '1 day')::date
                                   else daily_period_end end,
         daily_allowance    = v_daily,
         updated_at         = now()
   where tenant_id = p_tenant_id;
end $$;

create or replace function reserve_run_credits(
  p_tenant_id  uuid,
  p_run_id     uuid,
  p_agent_slug text,
  p_estimate   int,
  p_attempt    int
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
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
  if p_attempt is null or p_attempt < 0 then
    raise exception 'reserve_run_credits: attempt must be >= 0' using errcode = '22023';
  end if;

  perform _credit_balance_touch(p_tenant_id);

  if exists (select 1 from tenant_credit_ledger
             where run_id = p_run_id and kind = 'reserve' and attempt = p_attempt) then
    return false;
  end if;

  select (included_allowance - included_used)
         + greatest(daily_allowance - daily_used, 0)
         + purchased_balance - reserved,
         period_start
    into v_avail, v_ps
  from tenant_credit_balances where tenant_id = p_tenant_id;

  if v_avail < p_estimate and not _credits_unlimited(p_tenant_id) then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  update tenant_credit_balances
     set reserved = reserved + p_estimate, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, agent_slug, period_start, attempt)
  values (p_tenant_id, p_run_id, 'reserve', p_estimate, p_agent_slug, v_ps, p_attempt)
  on conflict (run_id, attempt) where kind = 'reserve' do nothing;

  return true;
end $$;
revoke all on function reserve_run_credits(uuid, uuid, text, int, int) from public, anon, authenticated;
grant execute on function reserve_run_credits(uuid, uuid, text, int, int) to service_role;

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
  select included_allowance, included_used, daily_allowance, daily_used
    into v_ia, v_iu, v_da, v_du
  from tenant_credit_balances where tenant_id = v_tenant;

  v_daily_room := greatest(v_da - v_du, 0);
  v_from_day   := least(v_credits, v_daily_room);
  v_rem        := v_credits - v_from_day;
  v_room       := greatest(v_ia - v_iu, 0);
  v_from_inc   := least(v_rem, v_room);
  v_from_pur   := v_rem - v_from_inc;

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

do $$
declare r record; n int := 0;
begin
  for r in select tenant_id from tenant_credit_balances loop
    perform _credit_balance_touch(r.tenant_id);
    n := n + 1;
  end loop;
  raise notice '20260906210000: touched % balance rows (daily window opened for paid tenants; stale periods rolled)', n;
end $$;


create or replace function _credit_month_window(p_anchor date, p_today date)
returns table (period_start date, period_end date)
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  m int;
  s date;
begin
  m := (extract(year from p_today)::int - extract(year from p_anchor)::int) * 12
     + (extract(month from p_today)::int - extract(month from p_anchor)::int);
  s := (p_anchor + make_interval(months => m))::date;
  if s > p_today then
    m := m - 1;
    s := (p_anchor + make_interval(months => m))::date;
  end if;
  period_start := s;
  period_end := (p_anchor + make_interval(months => m + 1))::date;
  return next;
end $$;
revoke all on function _credit_month_window(date, date) from public, anon, authenticated;
grant execute on function _credit_month_window(date, date) to service_role;

create or replace function _credit_balance_touch(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allow  int;
  v_free   boolean;
  v_ps     date;
  v_pe     date;
  v_daily  int;
  v_anchor date;
begin
  v_allow := _credit_allowance_for_tenant(p_tenant_id);
  v_free  := _is_free_daily_tenant(p_tenant_id);

  if v_free then
    v_ps := current_date;
    v_pe := (current_date + interval '1 day')::date;
    v_daily := 0;
  else
    select (s.current_period_end at time zone 'UTC')::date
      into v_anchor
      from tenant_subscriptions s
     where s.tenant_id = p_tenant_id
       and s.current_period_end is not null;

    if v_anchor is not null then
      select w.period_start, w.period_end
        into v_ps, v_pe
        from _credit_month_window(v_anchor, current_date) w;
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
     set period_start       = case when current_date >= period_end or period_end <> v_pe
                                   then v_ps else period_start end,
         period_end         = case when current_date >= period_end or period_end <> v_pe
                                   then v_pe else period_end end,
         included_used      = case when current_date >= period_end
                                     or (period_end - period_start = 1) <> v_free
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
revoke all on function _credit_balance_touch(uuid) from public, anon, authenticated;
grant execute on function _credit_balance_touch(uuid) to service_role;

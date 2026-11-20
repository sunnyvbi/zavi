
create or replace function _free_daily_credits()
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    nullif((select blob->>'free_daily_credits' from system_config where id = 1), '')::int,
    2000
  );
$$;

create or replace function _is_free_daily_tenant(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select not s.grandfathered
            and s.monthly_credits is null
            and s.plan = 'free'
       from tenant_subscriptions s
      where s.tenant_id = p_tenant_id),
    true
  );
$$;

create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.grandfathered then 250000
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

create or replace function _credit_balance_touch(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allow int;
  v_free  boolean;
  v_ps    date;
  v_pe    date;
begin
  v_allow := _credit_allowance_for_tenant(p_tenant_id);
  v_free  := _is_free_daily_tenant(p_tenant_id);

  if v_free then
    v_ps := current_date;
    v_pe := (current_date + interval '1 day')::date;
  else
    v_ps := date_trunc('month', current_date)::date;
    v_pe := (date_trunc('month', current_date) + interval '1 month')::date;
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
         updated_at         = now()
   where tenant_id = p_tenant_id;
end $$;

revoke all on function _free_daily_credits()          from public, anon, authenticated;
revoke all on function _is_free_daily_tenant(uuid)    from public, anon, authenticated;
revoke all on function _credit_allowance_for_tenant(uuid) from public, anon, authenticated;
grant execute on function _free_daily_credits()          to service_role;
grant execute on function _is_free_daily_tenant(uuid)    to service_role;
grant execute on function _credit_allowance_for_tenant(uuid) to service_role;

do $$
begin
  raise notice '20260901190000: free tier now replenishes daily (system_config.free_daily_credits, default 2000); paid/grandfathered/monthly_credits unchanged';
end $$;

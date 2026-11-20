
alter table tenant_subscriptions
  add column if not exists monthly_credits int
    check (monthly_credits is null or monthly_credits >= 0);

create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public as $$
  select case
    when s.grandfathered then 250000
    when s.monthly_credits is not null then s.monthly_credits
    when s.plan = 'solo'       then 20000
    when s.plan = 'team'       then 80000
    when s.plan = 'full'       then 300000
    when s.plan = 'enterprise' then 20000000
    else 40000
  end
  from (select 1) one
  left join tenant_subscriptions s on s.tenant_id = p_tenant_id;
$$;

create or replace function set_tenant_monthly_credits(p_tenant_id uuid, p_monthly_credits int)
returns void language plpgsql security definer set search_path = public as $$
begin
  update tenant_subscriptions
     set monthly_credits = p_monthly_credits, updated_at = now()
   where tenant_id = p_tenant_id;
  perform _credit_balance_touch(p_tenant_id);
end $$;

revoke all on function set_tenant_monthly_credits(uuid, int) from public;
grant execute on function set_tenant_monthly_credits(uuid, int) to service_role;

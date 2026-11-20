
alter table tenant_subscriptions
  add column if not exists comp_expires_at timestamptz;

comment on column tenant_subscriptions.comp_expires_at is
  'When a staff-comped tier ends (null = not a comp). Set by POST /api/admin/tenants/:id/plan; cleared by the Stripe billing webhook on any tier write.';

create or replace function _tenant_tier(p_tenant_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when exists (
      select 1
        from system_config sc,
             lateral jsonb_array_elements_text(
               case when jsonb_typeof(sc.blob->'tier_pro_tenants') = 'array'
                    then sc.blob->'tier_pro_tenants' else '[]'::jsonb end
             ) a
       where sc.id = 1 and a = p_tenant_id::text
    ) then 'pro'
    else coalesce(
      (select case
                when s.comp_expires_at is not null
                  then case when s.comp_expires_at > now() then s.tier else 'free' end
                when s.status in ('active', 'trialing', 'past_due') then s.tier
              end
         from tenant_subscriptions s
        where s.tenant_id = p_tenant_id
          and s.tier in ('free', 'starter', 'growth', 'pro')),
      'free'
    )
  end;
$$;

create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.grandfathered then 250000
    when s.credits_revoked_at is not null then coalesce(s.monthly_credits, 0)
    when s.comp_expires_at is not null and s.comp_expires_at > now()
     and s.tier in ('starter', 'growth', 'pro') then _tier_monthly_credits(s.tier)
    when s.comp_expires_at is not null then _free_daily_credits()
    when s.status = 'canceled' then _free_daily_credits()
    when s.tier in ('starter', 'growth', 'pro')
     and s.status in ('active', 'trialing', 'past_due') then _tier_monthly_credits(s.tier)
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
            and case
                  when s.comp_expires_at is not null then s.comp_expires_at <= now()
                  else (
                         (s.monthly_credits is null
                          and s.monthly_usd is null
                          and s.plan = 'free'
                          and not (s.tier in ('starter', 'growth', 'pro')
                                   and s.status in ('active', 'trialing', 'past_due')))
                      or (s.status = 'canceled'
                          and s.credits_revoked_at is null)
                       )
                end
       from tenant_subscriptions s
      where s.tenant_id = p_tenant_id),
    true
  );
$$;

revoke all on function _tenant_tier(uuid)                from public, anon, authenticated;
revoke all on function _credit_allowance_for_tenant(uuid) from public, anon, authenticated;
revoke all on function _is_free_daily_tenant(uuid)       from public, anon, authenticated;
grant execute on function _tenant_tier(uuid)                to service_role;
grant execute on function _credit_allowance_for_tenant(uuid) to service_role;
grant execute on function _is_free_daily_tenant(uuid)       to service_role;

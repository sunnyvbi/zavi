

create or replace function _credits_per_usd()
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case
              when blob->>'credits_per_usd' ~ '^[0-9]+$'
               and (blob->>'credits_per_usd')::bigint between 1 and 1000000
              then (blob->>'credits_per_usd')::int
            end
       from system_config where id = 1),
    400
  );
$$;

create or replace function _tier_credits(p_usd int)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case
              when blob->'credit_tiers'->>p_usd::text ~ '^[0-9]+$'
               and (blob->'credit_tiers'->>p_usd::text)::bigint between 0 and 2000000000
              then (blob->'credit_tiers'->>p_usd::text)::int
            end
       from system_config where id = 1),
    p_usd * _credits_per_usd()
  );
$$;

revoke all on function _credits_per_usd()   from public, anon, authenticated;
revoke all on function _tier_credits(int)   from public, anon, authenticated;
grant execute on function _credits_per_usd() to service_role;
grant execute on function _tier_credits(int) to service_role;

alter table tenant_subscriptions
  add column if not exists monthly_usd int;

comment on column tenant_subscriptions.monthly_usd is
  'Self-serve ladder rung in whole USD/mo that this tenant pays. When set, the credit allowance is derived LIVE from that tier''s configured volume (_tier_credits), so a staff tier change applies mid-period. NULL = legacy/comped/hand-set volume, which keeps using the frozen monthly_credits number.';

update tenant_subscriptions
   set monthly_usd = monthly_credits / 400
 where monthly_usd is null
   and monthly_credits is not null
   and monthly_credits > 0
   and monthly_credits % 400 = 0
   and (monthly_credits / 400) = any (array[
     50, 75, 100, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000,
     5000, 7500, 10000, 12500, 15000, 20000, 25000, 30000
   ]);

create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.grandfathered then 250000
    when s.credits_revoked_at is not null then coalesce(s.monthly_credits, 0)
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
            and s.monthly_credits is null
            and s.monthly_usd is null
            and s.plan = 'free'
       from tenant_subscriptions s
      where s.tenant_id = p_tenant_id),
    true
  );
$$;

create or replace function set_tenant_monthly_credits(
  p_tenant_id uuid, p_monthly_credits int, p_monthly_usd int, p_event_created bigint
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_applied boolean := false;
begin
  update tenant_subscriptions
     set monthly_credits       = p_monthly_credits,
         monthly_usd           = case when p_monthly_credits is null then null else p_monthly_usd end,
         monthly_credits_event = p_event_created,
         updated_at            = now()
   where tenant_id = p_tenant_id
     and p_event_created > monthly_credits_event
     and credits_revoked_at is null;
  if found then
    v_applied := true;
    perform _credit_balance_touch(p_tenant_id);
  end if;
  return v_applied;
end $$;

create or replace function set_tenant_monthly_credits(
  p_tenant_id uuid, p_monthly_credits int, p_event_created bigint
) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  select set_tenant_monthly_credits(p_tenant_id, p_monthly_credits, null::int, p_event_created);
$$;

revoke all on function set_tenant_monthly_credits(uuid, int, int, bigint) from public, anon, authenticated;
grant execute on function set_tenant_monthly_credits(uuid, int, int, bigint) to service_role;

create or replace function revoke_tenant_credits(
  p_tenant_id uuid, p_event_created bigint, p_stripe_subscription_id text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_applied boolean := false;
begin
  update tenant_subscriptions
     set monthly_credits       = 0,
         monthly_usd           = null,
         credits_revoked_at     = now(),
         monthly_credits_event  = p_event_created,
         updated_at             = now()
   where tenant_id = p_tenant_id
     and grandfathered = false
     and p_stripe_subscription_id is not null
     and stripe_subscription_id = p_stripe_subscription_id
     and p_event_created >= monthly_credits_event;
  if found then
    v_applied := true;
    perform _credit_balance_touch(p_tenant_id);
  end if;
  return v_applied;
end $$;

create or replace function resync_credit_allowances()
returns table (tenant_id uuid, previous_allowance int, new_allowance int, used_this_period int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tid    uuid;
  v_before int;
begin
  for v_tid, v_before in
    select s.tenant_id, coalesce(b.included_allowance, 0)
      from tenant_subscriptions s
      left join tenant_credit_balances b on b.tenant_id = s.tenant_id
     where s.monthly_usd is not null
       and s.credits_revoked_at is null
     order by s.tenant_id
  loop
    perform _credit_balance_touch(v_tid);
    tenant_id          := v_tid;
    previous_allowance := v_before;
    select coalesce(b.included_allowance, 0), coalesce(b.included_used, 0)
      into new_allowance, used_this_period
      from tenant_credit_balances b
     where b.tenant_id = v_tid;
    return next;
  end loop;
end $$;

revoke all on function resync_credit_allowances() from public, anon, authenticated;
grant execute on function resync_credit_allowances() to service_role;

do $$
declare v_mapped int; v_rate int;
begin
  select count(*) into v_mapped from tenant_subscriptions where monthly_usd is not null;
  select _credits_per_usd() into v_rate;
  raise notice '20260909071128: % subscription(s) mapped to a ladder tier; default rate % credits/$1', v_mapped, v_rate;
end $$;

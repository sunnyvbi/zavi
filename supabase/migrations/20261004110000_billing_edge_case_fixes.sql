
create or replace function _free_daily_credits()
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case
              when blob->>'free_daily_credits' ~ '^[0-9]{1,10}$'
              then case
                     when (blob->>'free_daily_credits')::bigint between 1 and 2000000000
                     then (blob->>'free_daily_credits')::int
                   end
            end
       from system_config where id = 1),
    2000
  );
$$;
revoke all on function _free_daily_credits()          from public, anon, authenticated;
grant execute on function _free_daily_credits()          to service_role;

create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.grandfathered then 250000
    when s.credits_revoked_at is not null then coalesce(s.monthly_credits, 0)
    when s.comp_expires_at is not null and s.comp_expires_at > now()
     and s.tier in ('starter', 'growth', 'pro') then _tier_monthly_credits(s.tier)
    when s.comp_expires_at is not null then _free_daily_credits()
    when s.status = 'canceled' then _free_daily_credits()
    when s.status = 'incomplete' then _free_daily_credits()
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
revoke all on function _credit_allowance_for_tenant(uuid) from public, anon, authenticated;
grant execute on function _credit_allowance_for_tenant(uuid) to service_role;

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
                      or (s.status = 'incomplete'
                          and s.credits_revoked_at is null)
                       )
                end
       from tenant_subscriptions s
      where s.tenant_id = p_tenant_id),
    true
  );
$$;
revoke all on function _is_free_daily_tenant(uuid)       from public, anon, authenticated;
grant execute on function _is_free_daily_tenant(uuid)       to service_role;

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

  select greatest(included_allowance - included_used, 0)
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

create or replace function media_credits_affordable(p_tenant_id uuid, p_cost_usd numeric)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_avail int;
begin
  if p_tenant_id is null then
    raise exception 'media_credits_affordable: tenant_id required' using errcode = '22023';
  end if;
  if p_cost_usd is null or p_cost_usd <= 0 then return true; end if;
  if not _credits_enforced(p_tenant_id) then return true; end if;
  if _credits_unlimited(p_tenant_id) then return true; end if;
  perform _credit_balance_touch(p_tenant_id);
  select greatest(included_allowance - included_used, 0)
         + greatest(daily_allowance - daily_used, 0)
         + purchased_balance - reserved
    into v_avail
  from tenant_credit_balances where tenant_id = p_tenant_id;
  return coalesce(v_avail, 0) >= ceil(p_cost_usd / 0.0025)::int;
end $$;
revoke all on function media_credits_affordable(uuid, numeric) from public, anon, authenticated;
grant execute on function media_credits_affordable(uuid, numeric) to service_role;

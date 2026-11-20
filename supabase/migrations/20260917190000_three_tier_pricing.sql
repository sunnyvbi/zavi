
alter table tenant_subscriptions
  add column if not exists tier text
    check (tier in ('free', 'starter', 'growth', 'pro')),
  add column if not exists tier_event_created bigint not null default 0;

comment on column tenant_subscriptions.tier is
  'Three-tier pricing tier (free/starter/growth/pro). NULL = free. Counts only while status is active/trialing/past_due. Written by the Stripe webhook from the price id.';

update system_config
   set blob = (
     jsonb_build_object(
       'tier_credits',       '{"starter":8000,"growth":48000,"pro":96000}'::jsonb,
       'tier_gate_enforced', false,
       'tier_pro_tenants',   '["73db45ff-457e-4541-bc8f-bdb625390204","e0fe9ea8-52e0-448e-80ff-5e68e8f81b3e","5f05d826-7793-45d1-88f9-c5c5bb3f0347"]'::jsonb
     )
     || coalesce(blob, '{}'::jsonb)
   ) || '{"free_daily_credits":1000}'::jsonb
 where id = 1;

create or replace function _tier_rank(p_tier text)
returns int language sql immutable security definer set search_path = public, pg_temp as $$
  select case p_tier
    when 'free'    then 0
    when 'starter' then 1
    when 'growth'  then 2
    when 'pro'     then 3
    else 3
  end;
$$;

create or replace function _tier_agent_min_default()
returns jsonb language sql immutable security definer set search_path = public, pg_temp as $$
  select '{
    "operator": "free",
    "research": "free",
    "advisor": "free",
    "cgo": "free",
    "growth-lead": "free",
    "pm": "free",
    "chief-of-staff": "free",
    "support-lead": "free",
    "qa": "free",
    "dispute-response": "free",
    "onboarding-discovery": "free",
    "seo-geo": "free",
    "supply-demand-balancer": "free",
    "browser-operator": "starter",
    "content-design": "starter",
    "content-seo": "starter",
    "product-builder": "starter",
    "performance-marketer": "starter",
    "generated_video": "starter",
    "seo": "starter",
    "geo": "starter",
    "linkedin_organic": "starter",
    "reddit_organic": "starter",
    "x_organic": "starter",
    "instagram_organic": "starter",
    "tiktok_organic": "starter",
    "youtube_organic": "starter",
    "ugc": "starter",
    "engineer": "pro",
    "fundraising": "pro",
    "google_ads": "pro",
    "meta_ads": "pro",
    "tiktok_ads": "pro",
    "linkedin_ads": "pro",
    "reddit_ads": "pro",
    "youtube_ads": "pro",
    "influencer": "pro",
    "email_marketing": "pro",
    "sms": "pro"
  }'::jsonb;
$$;

update system_config
   set blob = jsonb_build_object('tier_agent_min', _tier_agent_min_default()) || coalesce(blob, '{}'::jsonb)
 where id = 1;

create or replace function _tier_gate_enforced()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select blob->'tier_gate_enforced' = 'true'::jsonb from system_config where id = 1), false);
$$;

create or replace function _tier_required(p_slug text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case
              when m->>p_slug in ('free', 'starter', 'growth', 'pro') then m->>p_slug
            end
       from (select case
                      when jsonb_typeof(sc.blob->'tier_agent_min') = 'object' then sc.blob->'tier_agent_min'
                      else _tier_agent_min_default()
                    end as m
               from (select 1) one
               left join system_config sc on sc.id = 1) cfg),
    'pro'
  );
$$;

create or replace function _tier_monthly_credits(p_tier text)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case
              when blob->'tier_credits'->>p_tier ~ '^[0-9]+$'
               and (blob->'tier_credits'->>p_tier)::bigint between 0 and 2000000000
              then (blob->'tier_credits'->>p_tier)::int
            end
       from system_config where id = 1),
    case p_tier when 'starter' then 8000 when 'growth' then 48000 when 'pro' then 96000 else 0 end
  );
$$;

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
      (select s.tier
         from tenant_subscriptions s
        where s.tenant_id = p_tenant_id
          and s.status in ('active', 'trialing', 'past_due')
          and s.tier in ('free', 'starter', 'growth', 'pro')),
      'free'
    )
  end;
$$;

create or replace function _tier_allows(p_tenant_id uuid, p_slug text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select _tier_rank(_tenant_tier(p_tenant_id)) >= _tier_rank(_tier_required(p_slug));
$$;

create or replace function _credit_allowance_for_tenant(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.grandfathered then 250000
    when s.credits_revoked_at is not null then coalesce(s.monthly_credits, 0)
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
            and (
                  (s.monthly_credits is null
                   and s.monthly_usd is null
                   and s.plan = 'free'
                   and not (s.tier in ('starter', 'growth', 'pro')
                            and s.status in ('active', 'trialing', 'past_due')))
               or (s.status = 'canceled'
                   and s.credits_revoked_at is null)
                )
       from tenant_subscriptions s
      where s.tenant_id = p_tenant_id),
    true
  );
$$;

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
begin
  if NEW.status not in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and _tier_gate_enforced() then
    v_required := _tier_required(NEW.agent_slug);
    if _tier_rank(_tenant_tier(NEW.tenant_id)) < _tier_rank(v_required) then
      raise exception 'plan_upgrade_required' using errcode = 'P0001', detail = v_required;
    end if;
  end if;
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if NEW.status in ('queued', 'running') then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

create or replace function _trg_rereserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
begin
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued'
     and _tier_gate_enforced() then
    v_required := _tier_required(NEW.agent_slug);
    if _tier_rank(_tenant_tier(NEW.tenant_id)) < _tier_rank(v_required) then
      raise exception 'plan_upgrade_required' using errcode = 'P0001', detail = v_required;
    end if;
  end if;
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued' then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

revoke all on function _tier_rank(text)                  from public, anon, authenticated;
revoke all on function _tier_agent_min_default()         from public, anon, authenticated;
revoke all on function _tier_gate_enforced()             from public, anon, authenticated;
revoke all on function _tier_required(text)              from public, anon, authenticated;
revoke all on function _tier_monthly_credits(text)       from public, anon, authenticated;
revoke all on function _tenant_tier(uuid)                from public, anon, authenticated;
revoke all on function _tier_allows(uuid, text)          from public, anon, authenticated;
revoke all on function _credit_allowance_for_tenant(uuid) from public, anon, authenticated;
revoke all on function _is_free_daily_tenant(uuid)       from public, anon, authenticated;
grant execute on function _tier_rank(text)                  to service_role;
grant execute on function _tier_agent_min_default()         to service_role;
grant execute on function _tier_gate_enforced()             to service_role;
grant execute on function _tier_required(text)              to service_role;
grant execute on function _tier_monthly_credits(text)       to service_role;
grant execute on function _tenant_tier(uuid)                to service_role;
grant execute on function _tier_allows(uuid, text)          to service_role;
grant execute on function _credit_allowance_for_tenant(uuid) to service_role;
grant execute on function _is_free_daily_tenant(uuid)       to service_role;

do $$
begin
  raise notice '20260917190000: three-tier pricing installed; tier_gate_enforced=%', _tier_gate_enforced();
end $$;
